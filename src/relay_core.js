// Logic shared by every host this relay runs on.
//
// The Express app in app.js and the Cloudflare Worker in worker/ both route
// requests their own way, but the rules about scopes, lanes, command shapes
// and push delivery live here so the two hosts cannot drift apart. Nothing in
// this file may touch Express or Node's HTTP layer.
const {
  buildCommandPayload,
  deviceScopes,
  normalizeRemoteLogLines,
  randomId,
  shouldDisableSubscription,
  stringValue,
} = require("./helpers");

const COMMAND_RUN_RETENTION_DAYS = 14;
const COMMAND_RUN_MAX_COUNT = 200;
const DESKTOP_ONLINE_WINDOW_MS = 60 * 1000;
const DEFAULT_DESKTOP_ID = "default";
const MAX_LONG_POLL_MS = 25000;

// Which scope each command type needs. Types that touch the machine rather
// than a build are listed here before they are accepted, so landing them is a
// whitelist change in normalizeRemoteCommand and nothing else.
const COMMAND_TYPE_SCOPES = {
  shell: "run",
  script: "run",
  fastlane: "run",
  power: "power",
  window: "window",
  app: "window",
  unlock: "unlock",
  ios: "ios",
  iosQuery: "ios",
  // A phone that may run release scripts may run the release flow itself.
  release: "run",
  releaseControl: "run",
};

// Types that must name the machine they are for. Release commands keep
// defaulting to DEFAULT_DESKTOP_ID for compatibility, but there is no safe
// default for "shut down whichever desktop answered first".
const DESKTOP_SCOPED_COMMAND_TYPES = [
  "power",
  "window",
  "app",
  "unlock",
  "ios",
  "iosQuery",
  "release",
  "releaseControl",
];

// Types a device may only send to the desktop that paired it. An iOS build
// host hands its own pairing code to one controlling machine; that grant is
// not a licence to drive some other Mac on the same relay.
const PAIRED_DESKTOP_COMMAND_TYPES = ["ios", "iosQuery"];

// What a remote iOS release can ask the build host to do. Each is one step of
// the same workflow the host runs locally, so the list mirrors its buttons.
const IOS_ACTIONS = [
  "prepare",
  "inspect",
  "build",
  "upload",
  "continue",
  "refresh",
  "wait",
  "draft",
  "submit",
  "release",
  "distribute",
];

// Read-only questions, answered on the control lane so a busy host can still
// say what it is doing.
const IOS_QUERY_ACTIONS = ["history", "log"];

// Actions that only make sense against a run the host already prepared.
const IOS_RUN_ACTIONS = IOS_ACTIONS.filter(
  (action) => action !== "prepare" && action !== "inspect",
);

// The envelope carries the App Store Connect key and a few small project
// files, sealed for the host. Generous for that, far short of D1's row limit.
const MAX_IOS_ENVELOPE_LENGTH = 512 * 1024;

// What the phone may ask the desktop's release flows to do, per platform. The
// same buttons the desktop dialogs have, and nothing else.
const RELEASE_ACTIONS = {
  android: ["prepare", "start", "retry"],
  ios: [
    "prepare",
    "inspect",
    "continue",
    "refresh",
    "wait",
    "retryUpload",
    "draft",
    "submit",
    "release",
    "distribute",
  ],
};
const IOS_RELEASE_RUN_ACTIONS = RELEASE_ACTIONS.ios.filter(
  (action) => action !== "prepare" && action !== "inspect",
);
const RELEASE_CONTROL_ACTIONS = ["overview", "project", "cancel"];
const PLAY_TRACKS = ["internal", "alpha", "beta", "production"];

// A run snapshot with its App Store state; the relay stores it whole.
const MAX_COMMAND_RESULT_BYTES = 256 * 1024;

// How a finished release sounds on the phone. The Android app creates one
// notification channel per outcome with its own sound and vibration; the ids
// here must match ReleaseNotifications.kt, versions included: the app deletes
// the channels of earlier versions, so a stale id lands on the default sound.
const RELEASE_PUSH_STYLES = {
  succeeded: {
    channelId: "release_success_v3",
    sound: "release_success",
    color: "#22C55E",
    // Honoured only below Android 8, where there are no channels.
    vibrate: ["0s", "0.07s", "0.09s", "0.07s"],
  },
  failed: {
    channelId: "release_failure_v3",
    sound: "release_failure",
    color: "#EF4444",
    vibrate: ["0s", "0.45s", "0.15s", "0.45s", "0.15s", "0.9s"],
  },
};

// FCM registration tokens are ~160 characters today; this is headroom, not a
// format check.
const MAX_PUSH_TOKEN_LENGTH = 4096;

// Which queue a command waits in. The release lane is drained only when the
// desktop is idle; the control lane is drained regardless, because "lock my
// machine" is most needed exactly while a build is running.
const COMMAND_TYPE_LANES = {
  shell: "release",
  script: "release",
  fastlane: "release",
  power: "control",
  window: "control",
  app: "control",
  unlock: "control",
  // A build holds the host's runner like any other release work.
  ios: "release",
  iosQuery: "control",
  release: "release",
  // Reads and stop: answered while a release holds the runner.
  releaseControl: "control",
};

const ACCEPTED_COMMAND_TYPES = Object.keys(COMMAND_TYPE_LANES).filter(
  (type) => type !== "window" && type !== "app",
);

const POWER_ACTIONS = [
  "shutdown",
  "restart",
  "sleep",
  "hibernate",
  "lock",
  "logoff",
  // Screen off, machine still running. The stand-in for sleep on hardware
  // that cannot be woken remotely, where suspending means losing the phone.
  "displayOff",
  "cancel",
];

// Long enough to walk away from the machine, short enough that a forgotten
// command does not fire hours later.
const MAX_POWER_DELAY_SECONDS = 600;

async function waitForQueuedCommands(store, desktopId, waitMs, lane) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const commands = await store.listRemoteCommands({
      status: "queued",
      targetDesktopId: desktopId,
      lane,
      limit: 10,
    });
    if (commands.length > 0 || Date.now() >= deadline) return commands;
    await delay(Math.min(1000, deadline - Date.now()));
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

function desktopStateJson(desktop) {
  const lastSeenAt = stringValue(desktop.lastSeenAt);
  const lastSeenMillis = Date.parse(lastSeenAt);
  return {
    desktopId: stringValue(desktop.desktopId) || DEFAULT_DESKTOP_ID,
    displayName: stringValue(desktop.displayName) || "Desktop",
    lastSeenAt,
    online:
      !Number.isNaN(lastSeenMillis) &&
      Date.now() - lastSeenMillis <= DESKTOP_ONLINE_WINDOW_MS,
    remoteControlEnabled: desktop.remoteControlEnabled !== false,
    state: desktop.state && typeof desktop.state === "object" ? desktop.state : {},
  };
}

/// The desktop a phone's single-desktop view shows: the one that paired it,
/// else the default desktop, else whichever reported last. "Whichever reported
/// last" alone flips between machines once a Mac build host heartbeats beside
/// the desktop the phone was paired with — and the power buttons follow it.
function preferredDesktop(desktops, device) {
  const paired = stringValue(device && device.desktopId);
  return (
    (paired && desktops.find((desktop) => desktop.desktopId === paired)) ||
    desktops.find((desktop) => desktop.desktopId === DEFAULT_DESKTOP_ID) ||
    desktops[0] ||
    null
  );
}

function normalizeRemoteCommand(body, device, now) {
  const type = stringValue(body.type);
  if (!ACCEPTED_COMMAND_TYPES.includes(type)) {
    throw badRequest(
      `Command type must be one of ${ACCEPTED_COMMAND_TYPES.join(", ")}.`,
    );
  }

  const requiredScope = COMMAND_TYPE_SCOPES[type];
  if (!deviceScopes(device.scopes).includes(requiredScope)) {
    throw forbidden(`This device is not allowed to send ${type} commands.`);
  }

  const targetDesktopId = stringValue(body.targetDesktopId);
  if (!targetDesktopId && DESKTOP_SCOPED_COMMAND_TYPES.includes(type)) {
    throw badRequest(`A ${type} command must name its target desktop.`);
  }
  if (
    PAIRED_DESKTOP_COMMAND_TYPES.includes(type) &&
    stringValue(device.desktopId) !== targetDesktopId
  ) {
    throw forbidden(
      `This device may only send ${type} commands to the desktop that paired it.`,
    );
  }

  const payload =
    body.payload && typeof body.payload === "object" ? body.payload : body;
  const commandId = randomId();
  const command = {
    commandId,
    type,
    lane: COMMAND_TYPE_LANES[type],
    status: "queued",
    targetDesktopId: targetDesktopId || DEFAULT_DESKTOP_ID,
    createdByDeviceId: device.id,
    createdAt: now,
    updatedAt: now,
    payload: normalizeRemotePayload(type, payload),
    logLines: [],
    inputs: [],
  };
  return command;
}

function normalizeRemotePayload(type, payload) {
  if (type === "power") {
    // Matched case-insensitively but stored in the canonical spelling, so a
    // camelCase action such as displayOff survives the round trip.
    const requestedAction = stringValue(payload.action).toLowerCase();
    const action = POWER_ACTIONS.find(
      (candidate) => candidate.toLowerCase() === requestedAction,
    );
    if (!action) {
      throw badRequest(`Power action must be one of ${POWER_ACTIONS.join(", ")}.`);
    }
    const requested = intOrNull(payload.delaySeconds) || 0;
    return {
      action,
      delaySeconds: Math.min(Math.max(requested, 0), MAX_POWER_DELAY_SECONDS),
      // The desktop still refuses this while a release is running unless the
      // phone said so deliberately; this only carries the intent across.
      force: payload.force === true,
    };
  }

  if (type === "unlock") {
    const envelope = stringValue(payload.envelope);
    if (!envelope || envelope.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(envelope)) {
      throw badRequest("Encrypted unlock envelope is invalid.");
    }
    return { envelope };
  }

  if (type === "ios") {
    const action = stringValue(payload.action);
    if (!IOS_ACTIONS.includes(action)) {
      throw badRequest(`iOS action must be one of ${IOS_ACTIONS.join(", ")}.`);
    }
    const runId = iosRunId(payload.runId, IOS_RUN_ACTIONS.includes(action));
    // Everything that steers the build — commit, settings, credentials — is
    // sealed for the host and authenticated against these fields, so the
    // relay can route the command but cannot read or alter it.
    const envelope = stringValue(payload.envelope);
    if (
      !envelope ||
      envelope.length > MAX_IOS_ENVELOPE_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(envelope)
    ) {
      throw badRequest("Encrypted iOS envelope is invalid.");
    }
    return {
      action,
      runId,
      projectId: iosProjectId(payload.projectId),
      envelope,
    };
  }

  if (type === "release") {
    const platform = stringValue(payload.platform);
    const actions = RELEASE_ACTIONS[platform];
    if (!actions) throw badRequest("Release platform must be android or ios.");
    const action = stringValue(payload.action);
    if (!actions.includes(action)) {
      throw badRequest(`Release action must be one of ${actions.join(", ")}.`);
    }
    if (platform === "android") {
      if (action === "prepare") {
        const track = stringValue(payload.track).toLowerCase();
        if (!PLAY_TRACKS.includes(track)) {
          throw badRequest(`Track must be one of ${PLAY_TRACKS.join(", ")}.`);
        }
        return {
          platform,
          action,
          projectPath: requiredText(payload.projectPath, 500, "Project path"),
          track,
        };
      }
      // Production is confirmed on the phone, per release, like the desktop.
      return { platform, action, confirmProduction: payload.confirmProduction === true };
    }
    const projectId = iosProjectId(payload.projectId);
    if (action === "prepare" || action === "inspect") {
      return compactObject({
        platform,
        action,
        projectId,
        version: clip(stringValue(payload.version), 40),
        notes: action === "prepare" ? clip(stringValue(payload.notes), 4000) : undefined,
        existingBuild: action === "prepare" ? existingBuild(payload.existingBuild) : undefined,
      });
    }
    return {
      platform,
      action,
      projectId,
      runId: iosRunId(payload.runId, IOS_RELEASE_RUN_ACTIONS.includes(action)),
    };
  }

  if (type === "releaseControl") {
    const action = stringValue(payload.action);
    if (!RELEASE_CONTROL_ACTIONS.includes(action)) {
      throw badRequest(
        `Release control must be one of ${RELEASE_CONTROL_ACTIONS.join(", ")}.`,
      );
    }
    const platform = stringValue(payload.platform);
    if (action !== "overview" && !RELEASE_ACTIONS[platform]) {
      throw badRequest("Release platform must be android or ios.");
    }
    return compactObject({
      action,
      platform: platform || undefined,
      projectId: clip(stringValue(payload.projectId), 200) || undefined,
    });
  }

  if (type === "iosQuery") {
    const action = stringValue(payload.action);
    if (!IOS_QUERY_ACTIONS.includes(action)) {
      throw badRequest(
        `iOS query must be one of ${IOS_QUERY_ACTIONS.join(", ")}.`,
      );
    }
    return {
      action,
      runId: iosRunId(payload.runId, action === "log"),
      projectId: iosProjectId(payload.projectId),
    };
  }

  if (type === "shell") {
    const command = stringValue(payload.command);
    if (!command) throw badRequest("Shell command is required.");
    return {
      command,
      workingDirectory: stringValue(payload.workingDirectory),
    };
  }

  if (type === "script") {
    const scriptPath = stringValue(payload.scriptPath);
    const projectPath = stringValue(payload.projectPath);
    if (!scriptPath || !projectPath) {
      throw badRequest("Project path and script path are required.");
    }
    return {
      projectPath,
      scriptPath,
      args: stringArray(payload.args),
      options: objectValue(payload.options),
    };
  }

  const projectPath = stringValue(payload.projectPath);
  const laneKey = stringValue(payload.laneKey);
  if (!projectPath || !laneKey) {
    throw badRequest("Project path and lane key are required.");
  }
  return {
    projectPath,
    laneKey,
    args: stringArray(payload.args),
  };
}

function remoteCommandJson(command) {
  return {
    commandId: stringValue(command.commandId),
    type: stringValue(command.type),
    lane: command.lane === "control" ? "control" : "release",
    status: stringValue(command.status) || "queued",
    targetDesktopId: stringValue(command.targetDesktopId) || DEFAULT_DESKTOP_ID,
    createdByDeviceId: stringValue(command.createdByDeviceId),
    claimedByDesktopId: stringValue(command.claimedByDesktopId),
    createdAt: stringValue(command.createdAt),
    claimedAt: stringValue(command.claimedAt),
    startedAt: stringValue(command.startedAt),
    finishedAt: stringValue(command.finishedAt),
    updatedAt: stringValue(command.updatedAt),
    runId: stringValue(command.runId),
    durationMs: intOrNull(command.durationMs),
    exitCode: intOrNull(command.exitCode),
    error: stringValue(command.error),
    yesNoPrompt: stringValue(command.yesNoPrompt),
    payload: objectValue(command.payload),
    logLines: normalizeRemoteLogLines(command.logLines),
    result: objectValue(command.result),
  };
}

/// A release that finished or failed on a desktop, as the phone will see it.
function normalizeReleaseEvent(body) {
  const outcome = stringValue(body.outcome);
  if (!RELEASE_PUSH_STYLES[outcome]) {
    throw badRequest(
      `Release outcome must be one of ${Object.keys(RELEASE_PUSH_STYLES).join(", ")}.`,
    );
  }
  const title = clip(stringValue(body.title), 120);
  if (!title) throw badRequest("Release event title is required.");
  return {
    outcome,
    title,
    body: clip(stringValue(body.body), 600),
    // One notification per release run: a retry that succeeds replaces the
    // failure instead of stacking under it.
    tag: clip(stringValue(body.tag), 100),
    projectName: clip(stringValue(body.projectName), 120),
    platform: clip(stringValue(body.platform), 20),
    version: clip(stringValue(body.version), 60),
    targetDeviceIds: stringArray(body.targetDeviceIds),
  };
}

/// The FCM v1 message for one phone. Sent as a notification message so the
/// system shows it on the right channel even when the app is not running.
function releasePushMessage(event, token) {
  const style = RELEASE_PUSH_STYLES[event.outcome];
  return {
    message: {
      token,
      notification: { title: event.title, body: event.body },
      // Data values must be strings; the app reads them while in foreground.
      data: compactObject({
        outcome: event.outcome,
        title: event.title,
        body: event.body,
        tag: event.tag || undefined,
        projectName: event.projectName || undefined,
        platform: event.platform || undefined,
        version: event.version || undefined,
      }),
      android: {
        priority: "HIGH",
        notification: compactObject({
          channel_id: style.channelId,
          sound: style.sound,
          color: style.color,
          icon: "ic_stat_release",
          tag: event.tag || undefined,
          notification_priority: "PRIORITY_HIGH",
          default_sound: false,
          default_vibrate_timings: false,
          vibrate_timings: style.vibrate,
        }),
      },
    },
  };
}

/// A TestFlight build the phone picked to release again. Only the fields
/// that identify it; the desktop checks it against Apple before using it.
function existingBuild(value) {
  if (!value || typeof value !== "object") return undefined;
  // Build numbers arrive as JSON numbers as often as strings.
  const text = (field) =>
    typeof field === "number" && Number.isFinite(field)
      ? String(field)
      : stringValue(field);
  const build = {
    id: clip(text(value.id), 100),
    version: clip(text(value.version), 40),
    number: clip(text(value.number), 20),
    state: clip(text(value.state), 40),
  };
  return build.id && build.version && build.number ? build : undefined;
}

function requiredText(value, max, label) {
  const text = stringValue(value);
  if (!text || text.length > max) throw badRequest(`${label} is required.`);
  return text;
}

function normalizePushToken(value) {
  const token = stringValue(value);
  if (token.length > MAX_PUSH_TOKEN_LENGTH || /\s/.test(token)) {
    throw badRequest("Push token is invalid.");
  }
  return token;
}

function clip(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function iosRunId(value, required) {
  const runId = stringValue(value);
  if (!runId) {
    if (required) throw badRequest("This iOS action needs a run id.");
    return "";
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runId)) {
    throw badRequest("iOS run id is invalid.");
  }
  return runId;
}

function iosProjectId(value) {
  const projectId = stringValue(value);
  if (!projectId || projectId.length > 200) {
    throw badRequest("iOS project id is required.");
  }
  return projectId;
}

/// What the desktop reports back besides logs: for an iOS step, the run it
/// moved and the App Store state it saw. Undefined leaves the stored value.
function commandResult(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("Command result must be an object.");
  }
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_COMMAND_RESULT_BYTES
  ) {
    throw badRequest("Command result is too large.");
  }
  return value;
}

function remoteInputJson(input) {
  if (!input) return null;
  return {
    sequence: intOrNull(input.sequence) || 0,
    kind: stringValue(input.kind),
    value: stringValue(input.value),
    createdAt: stringValue(input.createdAt),
    deviceId: stringValue(input.deviceId),
  };
}

async function requireOwnedRemoteCommand(store, commandId, device) {
  const command = await store.getRemoteCommand(commandId);
  if (!command) throw notFound("Command not found.");
  if (command.createdByDeviceId !== device.id) throw forbidden("Forbidden.");
  return command;
}

function remoteStatus(value) {
  const status = stringValue(value);
  if (!status) return undefined;
  if (["queued", "claimed", "running", "completed", "failed", "canceled"].includes(status)) {
    return status;
  }
  throw badRequest("Invalid command status.");
}

function isoOrNull(value) {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function intOrNull(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => stringValue(entry)).filter(Boolean).slice(0, 50);
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function cleanupCommandRuns(store) {
  if (typeof store.cleanupCommandRuns !== "function") return;
  const olderThan = new Date(
    Date.now() - COMMAND_RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  store
    .cleanupCommandRuns({
      olderThan,
      maxCount: COMMAND_RUN_MAX_COUNT,
    })
    .catch((error) => {
      console.warn(`Command run cleanup failed: ${error.message}`);
    });
}

async function sendToDevices({
  config,
  store,
  pushClient,
  targetDeviceIds,
  payload,
  payloadForDevice,
}) {
  if (targetDeviceIds.length === 0) {
    const error = new Error("targetDeviceIds is required.");
    error.statusCode = 400;
    throw error;
  }

  configureWebPush(config, pushClient);
  let sent = 0;
  let failed = 0;
  let disabled = 0;

  for (const deviceId of targetDeviceIds) {
    const record = await store.getSubscription(deviceId);
    if (!record || record.enabled === false) continue;

    try {
      const outgoingPayload = payloadForDevice
        ? await payloadForDevice(deviceId)
        : payload;
      await pushClient.sendNotification(
        record.subscription,
        JSON.stringify(outgoingPayload),
      );
      sent += 1;
      await store.touchSubscription(deviceId, new Date().toISOString());
    } catch (error) {
      failed += 1;
      if (shouldDisableSubscription(error)) {
        disabled += 1;
        await store.disableSubscription(deviceId, new Date().toISOString());
      }
    }
  }

  return { sent, failed, disabled };
}


function configureWebPush(config, pushClient) {
  const publicKey = stringValue(config.VAPID_PUBLIC_KEY);
  const privateKey = stringValue(config.VAPID_PRIVATE_KEY);
  const subject = stringValue(config.VAPID_SUBJECT) || "mailto:release@example.com";

  if (!publicKey) {
    throw clientConfigurationError("VAPID_PUBLIC_KEY is not configured.");
  }
  if (!privateKey) {
    throw clientConfigurationError("VAPID_PRIVATE_KEY is not configured.");
  }

  try {
    pushClient.setVapidDetails(subject, publicKey, privateKey);
  } catch (error) {
    throw clientConfigurationError(
      `Web Push VAPID configuration is invalid: ${error.message}`,
    );
  }
}

function clientConfigurationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}


function detailViewSecret(config) {
  return stringValue(config.DETAIL_VIEW_SECRET) || stringValue(config.DESKTOP_API_TOKEN);
}


module.exports = {
  ACCEPTED_COMMAND_TYPES,
  COMMAND_RUN_MAX_COUNT,
  COMMAND_RUN_RETENTION_DAYS,
  COMMAND_TYPE_LANES,
  COMMAND_TYPE_SCOPES,
  DEFAULT_DESKTOP_ID,
  DESKTOP_ONLINE_WINDOW_MS,
  DESKTOP_SCOPED_COMMAND_TYPES,
  IOS_ACTIONS,
  IOS_QUERY_ACTIONS,
  MAX_COMMAND_RESULT_BYTES,
  MAX_IOS_ENVELOPE_LENGTH,
  MAX_LONG_POLL_MS,
  MAX_POWER_DELAY_SECONDS,
  PAIRED_DESKTOP_COMMAND_TYPES,
  PLAY_TRACKS,
  POWER_ACTIONS,
  RELEASE_ACTIONS,
  RELEASE_CONTROL_ACTIONS,
  RELEASE_PUSH_STYLES,
  badRequest,
  cleanupCommandRuns,
  clientConfigurationError,
  commandResult,
  compactObject,
  configureWebPush,
  delay,
  desktopStateJson,
  detailViewSecret,
  forbidden,
  intOrNull,
  isoOrNull,
  normalizePushToken,
  normalizeReleaseEvent,
  normalizeRemoteCommand,
  normalizeRemotePayload,
  notFound,
  objectValue,
  preferredDesktop,
  releasePushMessage,
  remoteCommandJson,
  remoteInputJson,
  remoteStatus,
  requireOwnedRemoteCommand,
  sendToDevices,
  stringArray,
  waitForQueuedCommands,
};
