const crypto = require("crypto");

const MAX_COMMAND_LABEL_LENGTH = 56;
const MAX_LOG_TAIL_LINES = 20;
const MAX_LOG_TAIL_BYTES = 4096;
const MAX_REMOTE_LOG_LINES = 500;
const MAX_REMOTE_LOG_BYTES = 128 * 1024;

function buildCommandPayload(event, options = {}) {
  const eventName = stringValue(event.event) || stringValue(event.status);
  const commandLabel = truncateMiddle(displayCommandLabel(event), MAX_COMMAND_LABEL_LENGTH);
  const projectName = stringValue(event.projectName);
  const exitCode = intValue(event.exitCode);
  const duration = durationLabel(event.durationMs);
  const isRunning = eventName === "started" || event.status === "running";
  const title =
    isRunning
      ? `Running: ${commandLabel}`
      : eventName === "completed" || event.status === "completed"
        ? `Completed: ${commandLabel}`
        : `Failed: ${commandLabel}`;
  const bodyParts = [
    projectName || "App Release Center",
    isRunning
      ? `Started at ${timeLabel(event.startedAt)}`
      : exitCode === null
        ? duration
        : `Exit ${exitCode}`,
    isRunning ? null : duration,
  ].filter(Boolean);
  const timestamp = Date.parse(event.finishedAt || event.startedAt);

  return {
    title,
    body: bodyParts.join(" - "),
    tag: stringValue(event.runId),
    renotify: !isRunning,
    timestamp: Number.isNaN(timestamp) ? undefined : timestamp,
    data: {
      runId: stringValue(event.runId),
      event: eventName,
      activePath: stringValue(event.activePath),
      projectName,
      commandLabel,
      exitCode,
      durationMs: intValue(event.durationMs),
      startedAt: stringValue(event.startedAt),
      finishedAt: stringValue(event.finishedAt),
      url: stringValue(options.url) || "/",
    },
  };
}

function commandRunFromEvent(event, targetDeviceIds) {
  const eventName = stringValue(event.event) || "started";
  const runId = stringValue(event.runId) || randomId();
  const commandLabel = stringValue(event.statusLabel || event.commandLabel || event.command);
  const now = new Date().toISOString();
  return compactObject({
    runId,
    event: eventName,
    status: commandRunStatus(eventName),
    projectName: stringValue(event.projectName),
    commandLabel,
    displayCommandLabel: humanizeCommandLabel(commandLabel),
    command: stringValue(event.command),
    activePath: stringValue(event.activePath),
    startedAt: isoDateOrNull(event.startedAt) || now,
    finishedAt: isoDateOrNull(event.finishedAt),
    durationMs: intValue(event.durationMs),
    exitCode: intValue(event.exitCode),
    logTail: normalizeLogTail(event.logTail),
    targetDeviceIds: Array.isArray(targetDeviceIds) ? targetDeviceIds : [],
    updatedAt: now,
  });
}

function commandRunJson(run) {
  return {
    runId: stringValue(run.runId),
    status: stringValue(run.status) || commandRunStatus(run.event),
    event: stringValue(run.event),
    projectName: stringValue(run.projectName),
    commandLabel: stringValue(run.commandLabel || run.statusLabel || run.command),
    displayCommandLabel: displayCommandLabel(run),
    command: stringValue(run.command),
    activePath: stringValue(run.activePath),
    startedAt: isoDate(run.startedAt),
    finishedAt: run.finishedAt ? isoDate(run.finishedAt) : null,
    durationMs: intValue(run.durationMs),
    exitCode: intValue(run.exitCode),
    logTail: normalizeLogTail(run.logTail),
    updatedAt: run.updatedAt ? isoDate(run.updatedAt) : null,
  };
}

function commandRunSignature(secret, runId, deviceId) {
  return crypto
    .createHmac("sha256", secret)
    .update(`${runId}:${deviceId}`)
    .digest("hex");
}

function isValidCommandRunSignature(secret, runId, deviceId, signature) {
  const expected = commandRunSignature(secret, runId, deviceId);
  const actual = stringValue(signature);
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function deviceJson(device) {
  return {
    id: stringValue(device.id),
    displayName: stringValue(device.displayName),
    platform: stringValue(device.platform),
    browser: stringValue(device.browser),
    linkedAt: isoDate(device.linkedAt),
    lastSeenAt: isoDate(device.lastSeenAt),
  };
}

function deviceIds(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => stringValue(entry)).filter(Boolean);
}

function isExpiredIso(value, now = Date.now()) {
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) return true;
  return millis <= now;
}

function randomId() {
  return crypto.randomBytes(12).toString("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function randomCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function secretHash(value) {
  return crypto
    .createHash("sha256")
    .update(stringValue(value))
    .digest("hex");
}

function shouldDisableSubscription(error) {
  const statusCode = error.statusCode || error.status;
  return statusCode === 404 || statusCode === 410;
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isoDate(value) {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime())
    ? new Date(0).toISOString()
    : date.toISOString();
}

function isoDateOrNull(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function intValue(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function commandRunStatus(eventName) {
  if (eventName === "completed") return "completed";
  if (eventName === "failed") return "failed";
  return "running";
}

function durationLabel(value) {
  const millis = intValue(value);
  if (millis === null || millis < 0) return "";
  if (millis < 1000) return "<1s";
  const totalSeconds = Math.round(millis / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}h ${minutes}m`;
}

function displayCommandLabel(event) {
  return (
    stringValue(event.displayCommandLabel) ||
    humanizeCommandLabel(event.commandLabel || event.statusLabel || event.command) ||
    "Command"
  );
}

function humanizeCommandLabel(value) {
  const raw = stringValue(value);
  if (!raw) return "";
  const firstCommand = raw.split(/\s+&&\s+|\s+\|\|\s+|\s+\|\s+/)[0];
  const withoutQuotes = firstCommand.replace(/^['"]|['"]$/g, "");
  const basename = /\s/.test(withoutQuotes)
    ? withoutQuotes
    : withoutQuotes.split(/[\\/]/).pop() || withoutQuotes;
  const withoutExtension = basename.replace(/\.(?:sh|bash|zsh|cmd|bat|ps1|dart|rb|js|ts)$/i, "");
  const cleaned = withoutExtension
    .replace(/[\\/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(" ")
    .map(titleWord)
    .join(" ");
}

function titleWord(word) {
  if (!word) return "";
  if (/^[A-Z0-9]{2,}$/.test(word)) return word;
  if (/^(ios|ipa)$/i.test(word)) return word.toUpperCase();
  if (/^(apk|aab)$/i.test(word)) return word.toUpperCase();
  return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
}

function timeLabel(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function normalizeLogTail(value) {
  if (!Array.isArray(value)) return [];
  const lines = value
    .map((entry) => stringValue(entry))
    .filter(Boolean)
    .slice(-MAX_LOG_TAIL_LINES);
  trimLogTailToBytes(lines);
  return lines;
}

function trimLogTailToBytes(lines) {
  while (
    lines.length > 1 &&
    Buffer.byteLength(JSON.stringify(lines), "utf8") > MAX_LOG_TAIL_BYTES
  ) {
    lines.shift();
  }

  if (
    lines.length === 1 &&
    Buffer.byteLength(JSON.stringify(lines), "utf8") > MAX_LOG_TAIL_BYTES
  ) {
    lines[0] = `...${lines[0].slice(-MAX_LOG_TAIL_BYTES + 16)}`;
  }
}

function normalizeRemoteLogLines(value) {
  if (!Array.isArray(value)) return [];
  const lines = value
    .map((entry) => stringValue(entry))
    .filter((entry) => entry.length > 0)
    .slice(-MAX_REMOTE_LOG_LINES);
  trimLinesToBytes(lines, MAX_REMOTE_LOG_BYTES);
  return lines;
}

function trimLinesToBytes(lines, maxBytes) {
  while (
    lines.length > 1 &&
    Buffer.byteLength(JSON.stringify(lines), "utf8") > maxBytes
  ) {
    lines.shift();
  }

  if (
    lines.length === 1 &&
    Buffer.byteLength(JSON.stringify(lines), "utf8") > maxBytes
  ) {
    lines[0] = `...${lines[0].slice(-maxBytes + 16)}`;
  }
}

function truncateMiddle(value, maxLength) {
  if (value.length <= maxLength) return value;
  const left = Math.ceil((maxLength - 1) / 2);
  const right = Math.floor((maxLength - 1) / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

module.exports = {
  buildCommandPayload,
  commandRunFromEvent,
  commandRunJson,
  commandRunSignature,
  deviceIds,
  deviceJson,
  durationLabel,
  humanizeCommandLabel,
  isValidCommandRunSignature,
  isExpiredIso,
  normalizeLogTail,
  normalizeRemoteLogLines,
  randomCode,
  randomId,
  randomToken,
  secretHash,
  shouldDisableSubscription,
  stringValue,
};
