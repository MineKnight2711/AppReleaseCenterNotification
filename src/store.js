const fs = require("fs/promises");
const path = require("path");

class JsonNotificationStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath || "./data/notifications-store.json");
    this._pendingWrite = Promise.resolve();
  }

  async createPairing(pairing) {
    return this._update((state) => {
      state.pairings[pairing.id] = pairing;
      return pairing;
    });
  }

  async getPairing(pairingId) {
    const state = await this._read();
    return state.pairings[pairingId] || null;
  }

  async findPendingPairing(pairingId, pairingCode, isExpired) {
    const state = await this._read();
    if (pairingId && state.pairings[pairingId]) {
      return validPendingPairing(state.pairings[pairingId], pairingCode, isExpired);
    }

    for (const pairing of Object.values(state.pairings)) {
      const match = validPendingPairing(pairing, pairingCode, isExpired);
      if (match) return match;
    }
    return null;
  }

  async expirePairing(pairingId) {
    return this._update((state) => {
      const pairing = state.pairings[pairingId];
      if (!pairing) return null;
      pairing.status = "expired";
      return pairing;
    });
  }

  async linkDevice({ pairingId, device, subscription }) {
    return this._update((state) => {
      const pairing = state.pairings[pairingId];
      if (!pairing) throw new Error("Pairing session not found.");
      state.devices[device.id] = device;
      if (subscription && subscription.endpoint) {
        state.subscriptions[device.id] = {
          deviceId: device.id,
          subscription,
          endpoint: subscription.endpoint,
          enabled: true,
          createdAt: device.linkedAt,
          lastSeenAt: device.lastSeenAt,
        };
      }
      pairing.status = "linked";
      pairing.deviceId = device.id;
      pairing.linkedAt = device.linkedAt;
      return device;
    });
  }

  async listDevices() {
    const state = await this._read();
    return Object.values(state.devices).sort((a, b) => {
      return new Date(b.linkedAt).getTime() - new Date(a.linkedAt).getTime();
    });
  }

  async deleteDevice(deviceId) {
    return this._update((state) => {
      delete state.devices[deviceId];
      delete state.subscriptions[deviceId];
      return null;
    });
  }

  async getSubscription(deviceId) {
    const state = await this._read();
    return state.subscriptions[deviceId] || null;
  }

  async touchSubscription(deviceId, timestamp) {
    return this._update((state) => {
      if (state.subscriptions[deviceId]) {
        state.subscriptions[deviceId].lastSeenAt = timestamp;
      }
      if (state.devices[deviceId]) {
        state.devices[deviceId].lastSeenAt = timestamp;
      }
      return null;
    });
  }

  async disableSubscription(deviceId, timestamp) {
    return this._update((state) => {
      if (state.subscriptions[deviceId]) {
        state.subscriptions[deviceId].enabled = false;
        state.subscriptions[deviceId].disabledAt = timestamp;
      }
      return null;
    });
  }

  async upsertCommandRun(run) {
    return this._update((state) => {
      const existing = state.commandRuns[run.runId] || {};
      state.commandRuns[run.runId] = { ...existing, ...run };
      return state.commandRuns[run.runId];
    });
  }

  async getCommandRun(runId) {
    const state = await this._read();
    return state.commandRuns[runId] || null;
  }

  async cleanupCommandRuns({ olderThan, maxCount }) {
    return this._update((state) => {
      const entries = Object.entries(state.commandRuns).sort(([, left], [, right]) => {
        return commandRunMillis(right) - commandRunMillis(left);
      });
      const olderThanMillis = Date.parse(olderThan);
      let removed = 0;

      entries.forEach(([runId, run], index) => {
        const isOld =
          !Number.isNaN(olderThanMillis) && commandRunMillis(run) < olderThanMillis;
        const exceedsMax = Number.isInteger(maxCount) && index >= maxCount;
        if (isOld || exceedsMax) {
          delete state.commandRuns[runId];
          removed += 1;
        }
      });

      return removed;
    });
  }

  async findDeviceByControlTokenHash(tokenHash) {
    const state = await this._read();
    return (
      Object.values(state.devices).find(
        (device) => device.controlTokenHash === tokenHash,
      ) || null
    );
  }

  async upsertDesktopState(desktop) {
    return this._update((state) => {
      state.desktops[desktop.desktopId] = {
        ...(state.desktops[desktop.desktopId] || {}),
        ...desktop,
      };
      return state.desktops[desktop.desktopId];
    });
  }

  async getDesktopState(desktopId) {
    const state = await this._read();
    return state.desktops[desktopId] || null;
  }

  async listDesktopStates() {
    const state = await this._read();
    return Object.values(state.desktops).sort((a, b) => {
      return new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime();
    });
  }

  async createRemoteCommand(command) {
    return this._update((state) => {
      state.remoteCommands[command.commandId] = command;
      return command;
    });
  }

  async getRemoteCommand(commandId) {
    const state = await this._read();
    return state.remoteCommands[commandId] || null;
  }

  async listRemoteCommands({ status, targetDesktopId, limit = 20 } = {}) {
    const state = await this._read();
    return Object.values(state.remoteCommands)
      .filter((command) => !status || command.status === status)
      .filter(
        (command) =>
          !targetDesktopId ||
          !command.targetDesktopId ||
          command.targetDesktopId === targetDesktopId,
      )
      .sort((a, b) => commandMillis(a) - commandMillis(b))
      .slice(0, limit);
  }

  async claimRemoteCommand(commandId, desktopId, claimedAt) {
    return this._update((state) => {
      const command = state.remoteCommands[commandId];
      if (!command || command.status !== "queued") return null;
      command.status = "claimed";
      command.claimedByDesktopId = desktopId;
      command.claimedAt = claimedAt;
      command.updatedAt = claimedAt;
      return command;
    });
  }

  async updateRemoteCommand(commandId, patch) {
    return this._update((state) => {
      const command = state.remoteCommands[commandId];
      if (!command) return null;
      state.remoteCommands[commandId] = { ...command, ...patch };
      return state.remoteCommands[commandId];
    });
  }

  async appendRemoteCommandInput(commandId, input) {
    return this._update((state) => {
      const command = state.remoteCommands[commandId];
      if (!command) return null;
      const inputs = Array.isArray(command.inputs) ? command.inputs : [];
      const sequence = inputs.length === 0 ? 1 : Number(inputs[inputs.length - 1].sequence || 0) + 1;
      const entry = { ...input, sequence };
      command.inputs = inputs.concat([entry]).slice(-100);
      command.updatedAt = input.createdAt || new Date().toISOString();
      return entry;
    });
  }

  async listRemoteCommandInputs(commandId, afterSequence = 0) {
    const state = await this._read();
    const command = state.remoteCommands[commandId];
    if (!command || !Array.isArray(command.inputs)) return [];
    return command.inputs.filter((input) => Number(input.sequence || 0) > afterSequence);
  }

  async _update(mutator) {
    this._pendingWrite = this._pendingWrite.then(async () => {
      const state = await this._read();
      const result = mutator(state);
      await this._write(state);
      return result;
    });
    return this._pendingWrite;
  }

  async _read() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async _write(state) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(tempPath, this.filePath);
  }
}

function commandRunMillis(run) {
  const millis = Date.parse(run.updatedAt || run.finishedAt || run.startedAt);
  return Number.isNaN(millis) ? 0 : millis;
}

function validPendingPairing(pairing, pairingCode, isExpired) {
  if (!pairing || pairing.status !== "pending") return null;
  if (pairing.pairingCode !== pairingCode) return null;
  if (isExpired(pairing.expiresAt)) return null;
  return pairing;
}

function normalizeState(value) {
  return {
    pairings: objectValue(value.pairings),
    devices: objectValue(value.devices),
    subscriptions: objectValue(value.subscriptions),
    commandRuns: objectValue(value.commandRuns),
    desktops: objectValue(value.desktops),
    remoteCommands: objectValue(value.remoteCommands),
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function emptyState() {
  return {
    pairings: {},
    devices: {},
    subscriptions: {},
    commandRuns: {},
    desktops: {},
    remoteCommands: {},
  };
}

function commandMillis(command) {
  const millis = Date.parse(command.createdAt || command.updatedAt || 0);
  return Number.isNaN(millis) ? 0 : millis;
}

module.exports = {
  JsonNotificationStore,
};
