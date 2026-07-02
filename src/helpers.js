const crypto = require("crypto");

function buildCommandPayload(event) {
  const command = stringValue(event.statusLabel || event.command);
  const projectName = stringValue(event.projectName);
  const exitCode = Number.isInteger(event.exitCode) ? event.exitCode : null;
  const title =
    event.event === "started"
      ? "Release command started"
      : event.event === "completed"
        ? "Release command completed"
        : "Release command failed";
  const detail =
    event.event === "started"
      ? "started"
      : exitCode === null
        ? stringValue(event.event)
        : `finished with exit ${exitCode}`;
  const body = [projectName, command, detail].filter(Boolean).join(" - ");

  return {
    title,
    body,
    data: {
      runId: stringValue(event.runId),
      event: stringValue(event.event),
      activePath: stringValue(event.activePath),
      url: "/",
    },
  };
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

function randomCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
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

module.exports = {
  buildCommandPayload,
  deviceIds,
  deviceJson,
  isExpiredIso,
  randomCode,
  randomId,
  shouldDisableSubscription,
  stringValue,
};
