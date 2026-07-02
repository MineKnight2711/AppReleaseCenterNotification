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
      state.subscriptions[device.id] = {
        deviceId: device.id,
        subscription,
        endpoint: subscription.endpoint,
        enabled: true,
        createdAt: device.linkedAt,
        lastSeenAt: device.lastSeenAt,
      };
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
  };
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function emptyState() {
  return { pairings: {}, devices: {}, subscriptions: {} };
}

module.exports = {
  JsonNotificationStore,
};
