const cors = require("cors");
const express = require("express");
const path = require("path");
const webpush = require("web-push");

const {
  buildCommandPayload,
  commandRunFromEvent,
  commandRunJson,
  commandRunSignature,
  deviceIds,
  deviceJson,
  isValidCommandRunSignature,
  isExpiredIso,
  normalizeRemoteLogLines,
  randomCode,
  randomId,
  randomToken,
  secretHash,
  shouldDisableSubscription,
  stringValue,
} = require("./helpers");
const { createNotificationStore } = require("./store_factory");

const COMMAND_RUN_RETENTION_DAYS = 14;
const COMMAND_RUN_MAX_COUNT = 200;
const DESKTOP_ONLINE_WINDOW_MS = 60 * 1000;
const DEFAULT_DESKTOP_ID = "default";
const MAX_LONG_POLL_MS = 25000;

function createApp(options = {}) {
  const config = options.config || process.env;
  const store = options.store || createNotificationStore(config);
  const pushClient = options.pushClient || webpush;
  const app = express();

  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/config", (_req, res) => {
    res.json({ vapidPublicKey: stringValue(config.VAPID_PUBLIC_KEY) });
  });

  app.post("/api/pairings", requireDesktopAuth(config), async (req, res, next) => {
    try {
      const pairingId = randomId();
      const pairingCode = randomCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const pairing = {
        id: pairingId,
        pairingCode,
        status: "pending",
        source: stringValue(req.body.source) || "desktop",
        app: stringValue(req.body.app) || "app_release_center",
        createdAt: new Date().toISOString(),
        expiresAt,
      };
      await store.createPairing(pairing);

      const pairingUrl = new URL(publicBaseUrl(config, req));
      pairingUrl.searchParams.set("pairing", pairingId);
      pairingUrl.searchParams.set("code", pairingCode);

      res.status(201).json({
        pairingId,
        pairingCode,
        pairingUrl: pairingUrl.toString(),
        expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/pairings/:pairingId",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const pairing = await store.getPairing(req.params.pairingId);
        if (!pairing) {
          res.status(404).json({ error: "Pairing session not found." });
          return;
        }

        let status = pairing.status || "pending";
        if (status === "pending" && isExpiredIso(pairing.expiresAt)) {
          status = "expired";
          await store.expirePairing(pairing.id);
        }

        const response = { status, expiresAt: pairing.expiresAt };
        if (status === "linked" && pairing.deviceId) {
          const devices = await store.listDevices();
          const device = devices.find((entry) => entry.id === pairing.deviceId);
          if (device) response.device = deviceJson(device);
        }

        res.json(response);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/push-subscriptions", async (req, res, next) => {
    try {
      const pairingCode = stringValue(req.body.pairingCode);
      const pairingId = stringValue(req.body.pairingId);
      const subscription = req.body.subscription;

      if (!pairingCode || !subscription || !subscription.endpoint) {
        res.status(400).json({ error: "Pairing code and subscription are required." });
        return;
      }

      const pairing = await store.findPendingPairing(
        pairingId,
        pairingCode,
        isExpiredIso,
      );
      if (!pairing) {
        res.status(404).json({ error: "Pairing session is invalid or expired." });
        return;
      }

      const now = new Date().toISOString();
      const deviceControlToken = randomToken();
      const device = {
        id: randomId(),
        displayName: stringValue(req.body.deviceName) || "Linked phone",
        platform: stringValue(req.body.platform),
        browser: stringValue(req.body.browser),
        linkedAt: now,
        lastSeenAt: now,
        controlTokenHash: secretHash(deviceControlToken),
      };
      await store.linkDevice({ pairingId: pairing.id, device, subscription });

      res.status(201).json({
        device: deviceJson(device),
        deviceControlToken,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/control-devices", async (req, res, next) => {
    try {
      const pairingCode = stringValue(req.body.pairingCode);
      const pairingId = stringValue(req.body.pairingId);

      if (!pairingCode) {
        res.status(400).json({ error: "Pairing code is required." });
        return;
      }

      const pairing = await store.findPendingPairing(
        pairingId,
        pairingCode,
        isExpiredIso,
      );
      if (!pairing) {
        res.status(404).json({ error: "Pairing session is invalid or expired." });
        return;
      }

      const now = new Date().toISOString();
      const deviceControlToken = randomToken();
      const device = {
        id: randomId(),
        displayName: stringValue(req.body.deviceName) || "Android phone",
        platform: stringValue(req.body.platform) || "Android",
        browser: stringValue(req.body.browser),
        linkedAt: now,
        lastSeenAt: now,
        controlTokenHash: secretHash(deviceControlToken),
      };
      await store.linkDevice({ pairingId: pairing.id, device });

      res.status(201).json({
        device: deviceJson(device),
        deviceControlToken,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/devices", requireDesktopAuth(config), async (_req, res, next) => {
    try {
      const devices = await store.listDevices();
      res.json({ devices: devices.map(deviceJson) });
    } catch (error) {
      next(error);
    }
  });

  app.delete(
    "/api/devices/:deviceId",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        await store.deleteDevice(req.params.deviceId);
        res.status(204).send("");
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/test-notifications",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const result = await sendToDevices({
          config,
          store,
          pushClient,
          targetDeviceIds: deviceIds(req.body.targetDeviceIds),
          payload: {
            title: "App Release Center test",
            body: "Phone notification link is working.",
            data: { url: "/" },
          },
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/command-events",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const targetDeviceIds = deviceIds(req.body.targetDeviceIds);
        const commandRun = await store.upsertCommandRun(
          commandRunFromEvent(req.body, targetDeviceIds),
        );
        const result = await sendToDevices({
          config,
          store,
          pushClient,
          targetDeviceIds,
          payloadForDevice: (deviceId) =>
            buildCommandPayload(commandRun, {
              url: commandRunDetailUrl(config, req, commandRun.runId, deviceId),
            }),
        });
        cleanupCommandRuns(store);
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("/api/command-runs/:runId", async (req, res, next) => {
    try {
      const runId = stringValue(req.params.runId);
      const deviceId = stringValue(req.query.deviceId);
      const signature = stringValue(req.query.sig);
      const secret = detailViewSecret(config);
      if (
        !runId ||
        !deviceId ||
        !secret ||
        !isValidCommandRunSignature(secret, runId, deviceId, signature)
      ) {
        res.status(403).json({
          error: "This notification detail is no longer available.",
        });
        return;
      }

      const [run, subscription] = await Promise.all([
        store.getCommandRun(runId),
        store.getSubscription(deviceId),
      ]);
      if (
        !run ||
        !subscription ||
        !Array.isArray(run.targetDeviceIds) ||
        !run.targetDeviceIds.includes(deviceId)
      ) {
        res.status(404).json({
          error: "This notification detail is no longer available.",
        });
        return;
      }

      res.json({ run: commandRunJson(run) });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/desktop/heartbeat",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const now = new Date().toISOString();
        const desktop = {
          desktopId: stringValue(req.body.desktopId) || DEFAULT_DESKTOP_ID,
          displayName: stringValue(req.body.displayName) || "Desktop",
          lastSeenAt: now,
          remoteControlEnabled: req.body.remoteControlEnabled !== false,
          state:
            req.body.state && typeof req.body.state === "object"
              ? req.body.state
              : {},
        };
        const saved = await store.upsertDesktopState(desktop);
        res.json({ desktop: desktopStateJson(saved) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/desktop/commands",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const desktopId = stringValue(req.query.desktopId) || DEFAULT_DESKTOP_ID;
        const waitMs = Math.min(
          Math.max(Number.parseInt(req.query.waitMs, 10) || 0, 0),
          MAX_LONG_POLL_MS,
        );
        const commands = await waitForQueuedCommands(store, desktopId, waitMs);
        res.json({ commands: commands.map(remoteCommandJson) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/desktop/commands/:commandId/claim",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const desktopId = stringValue(req.body.desktopId) || DEFAULT_DESKTOP_ID;
        const command = await store.claimRemoteCommand(
          req.params.commandId,
          desktopId,
          new Date().toISOString(),
        );
        if (!command) {
          res.status(409).json({ error: "Command is no longer queued." });
          return;
        }
        res.json({ command: remoteCommandJson(command) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/desktop/commands/:commandId/events",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const now = new Date().toISOString();
        const patch = compactObject({
          status: remoteStatus(req.body.status),
          runId: stringValue(req.body.runId),
          startedAt: isoOrNull(req.body.startedAt),
          finishedAt: isoOrNull(req.body.finishedAt),
          durationMs: intOrNull(req.body.durationMs),
          exitCode: intOrNull(req.body.exitCode),
          error: stringValue(req.body.error),
          yesNoPrompt: stringValue(req.body.yesNoPrompt),
          logLines: normalizeRemoteLogLines(req.body.logLines),
          updatedAt: now,
        });
        const command = await store.updateRemoteCommand(req.params.commandId, patch);
        if (!command) {
          res.status(404).json({ error: "Command not found." });
          return;
        }
        res.json({ command: remoteCommandJson(command) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/desktop/commands/:commandId/inputs",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const afterSequence = Number.parseInt(req.query.afterSequence, 10) || 0;
        const inputs = await store.listRemoteCommandInputs(
          req.params.commandId,
          afterSequence,
        );
        res.json({ inputs: inputs.map(remoteInputJson) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/mobile/desktop-state",
    requireMobileAuth(store),
    async (_req, res, next) => {
      try {
        const desktops = await store.listDesktopStates();
        const desktop = desktops[0] || null;
        res.json({ desktop: desktop ? desktopStateJson(desktop) : null });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/mobile/commands",
    requireMobileAuth(store),
    async (req, res, next) => {
      try {
        const now = new Date().toISOString();
        const command = normalizeRemoteCommand(req.body, req.mobileDevice, now);
        const saved = await store.createRemoteCommand(command);
        res.status(201).json({ command: remoteCommandJson(saved) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/mobile/commands/:commandId",
    requireMobileAuth(store),
    async (req, res, next) => {
      try {
        const command = await requireOwnedRemoteCommand(
          store,
          req.params.commandId,
          req.mobileDevice,
        );
        res.json({ command: remoteCommandJson(command) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/mobile/commands/:commandId/input",
    requireMobileAuth(store),
    async (req, res, next) => {
      try {
        await requireOwnedRemoteCommand(
          store,
          req.params.commandId,
          req.mobileDevice,
        );
        const value = stringValue(req.body.value);
        if (!value) {
          res.status(400).json({ error: "Input value is required." });
          return;
        }
        const input = await store.appendRemoteCommandInput(req.params.commandId, {
          kind: "stdin",
          value,
          createdAt: new Date().toISOString(),
          deviceId: req.mobileDevice.id,
        });
        res.status(201).json({ input: remoteInputJson(input) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/mobile/commands/:commandId/stop",
    requireMobileAuth(store),
    async (req, res, next) => {
      try {
        await requireOwnedRemoteCommand(
          store,
          req.params.commandId,
          req.mobileDevice,
        );
        const input = await store.appendRemoteCommandInput(req.params.commandId, {
          kind: "stop",
          createdAt: new Date().toISOString(),
          deviceId: req.mobileDevice.id,
        });
        res.status(201).json({ input: remoteInputJson(input) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.use((error, _req, res, _next) => {
    const statusCode = Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;
    if (statusCode >= 500) {
      console.error(error);
    }
    res.status(statusCode).json({
      error: error.message || "Notification server error.",
    });
  });

  return app;
}

function requireMobileAuth(store) {
  return async (req, res, next) => {
    try {
      const header = stringValue(req.get("authorization"));
      const token = header.toLowerCase().startsWith("bearer ")
        ? header.slice("bearer ".length)
        : "";
      if (!token) {
        res.status(401).json({ error: "Unauthorized." });
        return;
      }

      const device = await store.findDeviceByControlTokenHash(secretHash(token));
      if (!device) {
        res.status(401).json({ error: "Unauthorized." });
        return;
      }
      req.mobileDevice = device;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function waitForQueuedCommands(store, desktopId, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const commands = await store.listRemoteCommands({
      status: "queued",
      targetDesktopId: desktopId,
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

function normalizeRemoteCommand(body, device, now) {
  const type = stringValue(body.type);
  if (!["shell", "script", "fastlane"].includes(type)) {
    throw badRequest("Command type must be shell, script, or fastlane.");
  }

  const payload =
    body.payload && typeof body.payload === "object" ? body.payload : body;
  const commandId = randomId();
  const command = {
    commandId,
    type,
    status: "queued",
    targetDesktopId: stringValue(body.targetDesktopId) || DEFAULT_DESKTOP_ID,
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
  };
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

function commandRunDetailUrl(config, req, runId, deviceId) {
  const url = new URL(`/runs/${encodeURIComponent(runId)}`, publicBaseUrl(config, req));
  url.searchParams.set("deviceId", deviceId);
  url.searchParams.set(
    "sig",
    commandRunSignature(detailViewSecret(config), runId, deviceId),
  );
  return `${url.pathname}${url.search}`;
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

function requireDesktopAuth(config) {
  return (req, res, next) => {
    const expected = stringValue(config.DESKTOP_API_TOKEN);
    if (!expected) {
      next();
      return;
    }

    if (req.get("authorization") !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    next();
  };
}

function detailViewSecret(config) {
  return stringValue(config.DETAIL_VIEW_SECRET) || stringValue(config.DESKTOP_API_TOKEN);
}

function publicBaseUrl(config, req) {
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  const host = req.get("x-forwarded-host") || req.get("host");
  if (host) return `${proto}://${host}`;

  const configured = stringValue(config.PUBLIC_BASE_URL);
  if (configured) return configured;
  return "http://localhost:8080";
}

module.exports = {
  createApp,
  sendToDevices,
};
