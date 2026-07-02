const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const { stringValue } = require("./helpers");

class FirestoreNotificationStore {
  constructor(db) {
    this.db = db;
  }

  async createPairing(pairing) {
    await this._pairingRef(pairing.id).set(pairing);
    return pairing;
  }

  async getPairing(pairingId) {
    const snapshot = await this._pairingRef(pairingId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async findPendingPairing(pairingId, pairingCode, isExpired) {
    if (pairingId) {
      return validPendingPairing(
        await this.getPairing(pairingId),
        pairingCode,
        isExpired,
      );
    }

    const snapshot = await this.db
      .collection("pairingSessions")
      .where("pairingCode", "==", pairingCode)
      .where("status", "==", "pending")
      .limit(10)
      .get();

    for (const doc of snapshot.docs) {
      const match = validPendingPairing(doc.data(), pairingCode, isExpired);
      if (match) return match;
    }
    return null;
  }

  async expirePairing(pairingId) {
    const pairing = await this.getPairing(pairingId);
    if (!pairing) return null;
    pairing.status = "expired";
    await this._pairingRef(pairingId).update({ status: "expired" });
    return pairing;
  }

  async linkDevice({ pairingId, device, subscription }) {
    await this.db.runTransaction(async (transaction) => {
      const pairingRef = this._pairingRef(pairingId);
      const pairingSnapshot = await transaction.get(pairingRef);
      if (!pairingSnapshot.exists) throw new Error("Pairing session not found.");

      transaction.set(this._deviceRef(device.id), device);
      if (subscription && subscription.endpoint) {
        transaction.set(this._subscriptionRef(device.id), {
          deviceId: device.id,
          subscription,
          endpoint: subscription.endpoint,
          enabled: true,
          createdAt: device.linkedAt,
          lastSeenAt: device.lastSeenAt,
        });
      }
      transaction.update(pairingRef, {
        status: "linked",
        deviceId: device.id,
        linkedAt: device.linkedAt,
      });
    });
    return device;
  }

  async listDevices() {
    const snapshot = await this.db
      .collection("devices")
      .orderBy("linkedAt", "desc")
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async deleteDevice(deviceId) {
    await Promise.all([
      this._deviceRef(deviceId).delete(),
      this._subscriptionRef(deviceId).delete(),
    ]);
    return null;
  }

  async getSubscription(deviceId) {
    const snapshot = await this._subscriptionRef(deviceId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async touchSubscription(deviceId, timestamp) {
    await Promise.all([
      updateIfExists(this._subscriptionRef(deviceId), { lastSeenAt: timestamp }),
      updateIfExists(this._deviceRef(deviceId), { lastSeenAt: timestamp }),
    ]);
    return null;
  }

  async disableSubscription(deviceId, timestamp) {
    await updateIfExists(this._subscriptionRef(deviceId), {
      enabled: false,
      disabledAt: timestamp,
    });
    return null;
  }

  async upsertCommandRun(run) {
    await this._commandRunRef(run.runId).set(run, { merge: true });
    const snapshot = await this._commandRunRef(run.runId).get();
    return snapshot.exists ? snapshot.data() : run;
  }

  async getCommandRun(runId) {
    const snapshot = await this._commandRunRef(runId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async cleanupCommandRuns({ olderThan, maxCount }) {
    const snapshot = await this.db
      .collection("commandRuns")
      .orderBy("updatedAt", "desc")
      .get();
    const olderThanMillis = Date.parse(olderThan);
    let removed = 0;
    const deletes = [];

    snapshot.docs.forEach((doc, index) => {
      const run = doc.data();
      const isOld =
        !Number.isNaN(olderThanMillis) &&
        commandRunMillis(run) < olderThanMillis;
      const exceedsMax = Number.isInteger(maxCount) && index >= maxCount;
      if (isOld || exceedsMax) {
        removed += 1;
        deletes.push(this._commandRunRef(doc.id).delete());
      }
    });

    await Promise.all(deletes);
    return removed;
  }

  async findDeviceByControlTokenHash(tokenHash) {
    const snapshot = await this.db
      .collection("devices")
      .where("controlTokenHash", "==", tokenHash)
      .limit(1)
      .get();
    return snapshot.docs.length === 0 ? null : snapshot.docs[0].data();
  }

  async upsertDesktopState(desktop) {
    await this._desktopRef(desktop.desktopId).set(desktop, { merge: true });
    const snapshot = await this._desktopRef(desktop.desktopId).get();
    return snapshot.exists ? snapshot.data() : desktop;
  }

  async getDesktopState(desktopId) {
    const snapshot = await this._desktopRef(desktopId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async listDesktopStates() {
    const snapshot = await this.db
      .collection("desktopStates")
      .orderBy("lastSeenAt", "desc")
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async createRemoteCommand(command) {
    await this._remoteCommandRef(command.commandId).set(command);
    return command;
  }

  async getRemoteCommand(commandId) {
    const snapshot = await this._remoteCommandRef(commandId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  async listRemoteCommands({ status, targetDesktopId, limit = 20 } = {}) {
    let query = this.db.collection("remoteCommands");
    if (status) query = query.where("status", "==", status);
    const snapshot = await query.get();
    return snapshot.docs
      .map((doc) => doc.data())
      .filter(
        (command) =>
          !targetDesktopId ||
          !command.targetDesktopId ||
          command.targetDesktopId === targetDesktopId,
      )
      .sort((left, right) => commandMillis(left) - commandMillis(right))
      .slice(0, limit);
  }

  async claimRemoteCommand(commandId, desktopId, claimedAt) {
    let claimed = null;
    await this.db.runTransaction(async (transaction) => {
      const ref = this._remoteCommandRef(commandId);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const command = snapshot.data();
      if (command.status !== "queued") return;
      claimed = {
        ...command,
        status: "claimed",
        claimedByDesktopId: desktopId,
        claimedAt,
        updatedAt: claimedAt,
      };
      transaction.set(ref, claimed);
    });
    return claimed;
  }

  async updateRemoteCommand(commandId, patch) {
    const ref = this._remoteCommandRef(commandId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return null;
    await ref.set(patch, { merge: true });
    return (await ref.get()).data();
  }

  async appendRemoteCommandInput(commandId, input) {
    const ref = this._remoteCommandRef(commandId);
    let entry = null;
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) return;
      const command = snapshot.data();
      const inputs = Array.isArray(command.inputs) ? command.inputs : [];
      const sequence =
        inputs.length === 0
          ? 1
          : Number(inputs[inputs.length - 1].sequence || 0) + 1;
      entry = { ...input, sequence };
      transaction.update(ref, {
        inputs: inputs.concat([entry]).slice(-100),
        updatedAt: input.createdAt || new Date().toISOString(),
      });
    });
    return entry;
  }

  async listRemoteCommandInputs(commandId, afterSequence = 0) {
    const command = await this.getRemoteCommand(commandId);
    if (!command || !Array.isArray(command.inputs)) return [];
    return command.inputs.filter(
      (input) => Number(input.sequence || 0) > afterSequence,
    );
  }

  _pairingRef(pairingId) {
    return this.db.collection("pairingSessions").doc(pairingId);
  }

  _deviceRef(deviceId) {
    return this.db.collection("devices").doc(deviceId);
  }

  _subscriptionRef(deviceId) {
    return this.db.collection("pushSubscriptions").doc(deviceId);
  }

  _commandRunRef(runId) {
    return this.db.collection("commandRuns").doc(runId);
  }

  _desktopRef(desktopId) {
    return this.db.collection("desktopStates").doc(desktopId);
  }

  _remoteCommandRef(commandId) {
    return this.db.collection("remoteCommands").doc(commandId);
  }
}

function createFirestoreNotificationStore(config) {
  const projectId = stringValue(config.FIREBASE_PROJECT_ID);
  const serviceAccount = serviceAccountFromConfig(config);
  if (!serviceAccount) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON_B64 or FIREBASE_SERVICE_ACCOUNT_JSON is required when Firestore storage is enabled.",
    );
  }

  const effectiveProjectId = projectId || stringValue(serviceAccount.project_id);
  const appName = `app-release-center-notifications-${effectiveProjectId || "default"}`;
  let app = getApps().find((entry) => entry.name === appName);

  if (!app) {
    const options = { credential: cert(serviceAccount) };
    if (effectiveProjectId) options.projectId = effectiveProjectId;
    app = initializeApp(options, appName);
  }

  return new FirestoreNotificationStore(getFirestore(app));
}

function hasFirestoreConfig(config) {
  return Boolean(
    stringValue(config.FIREBASE_PROJECT_ID) ||
      stringValue(config.FIREBASE_SERVICE_ACCOUNT_JSON_B64) ||
      stringValue(config.FIREBASE_SERVICE_ACCOUNT_JSON),
  );
}

function serviceAccountFromConfig(config) {
  const encoded = stringValue(config.FIREBASE_SERVICE_ACCOUNT_JSON_B64);
  const raw = encoded
    ? Buffer.from(encoded, "base64").toString("utf8")
    : stringValue(config.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Firebase service account JSON: ${error.message}`);
  }
}

async function updateIfExists(ref, patch) {
  const snapshot = await ref.get();
  if (!snapshot.exists) return;
  await ref.update(patch);
}

function validPendingPairing(pairing, pairingCode, isExpired) {
  if (!pairing || pairing.status !== "pending") return null;
  if (pairing.pairingCode !== pairingCode) return null;
  if (isExpired(pairing.expiresAt)) return null;
  return pairing;
}

function commandRunMillis(run) {
  const millis = Date.parse(run.updatedAt || run.finishedAt || run.startedAt);
  return Number.isNaN(millis) ? 0 : millis;
}

module.exports = {
  FirestoreNotificationStore,
  createFirestoreNotificationStore,
  hasFirestoreConfig,
  serviceAccountFromConfig,
};
