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
      transaction.set(this._subscriptionRef(device.id), {
        deviceId: device.id,
        subscription,
        endpoint: subscription.endpoint,
        enabled: true,
        createdAt: device.linkedAt,
        lastSeenAt: device.lastSeenAt,
      });
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

  _pairingRef(pairingId) {
    return this.db.collection("pairingSessions").doc(pairingId);
  }

  _deviceRef(deviceId) {
    return this.db.collection("devices").doc(deviceId);
  }

  _subscriptionRef(deviceId) {
    return this.db.collection("pushSubscriptions").doc(deviceId);
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

module.exports = {
  FirestoreNotificationStore,
  createFirestoreNotificationStore,
  hasFirestoreConfig,
  serviceAccountFromConfig,
};
