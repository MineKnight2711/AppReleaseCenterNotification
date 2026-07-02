const os = require("os");
const path = require("path");

const {
  FirestoreNotificationStore,
  createFirestoreNotificationStore,
  serviceAccountFromConfig,
} = require("../src/firestore_store");
const { JsonNotificationStore } = require("../src/store");
const { createNotificationStore } = require("../src/store_factory");

test("firestore store links and lists devices", async () => {
  const store = new FirestoreNotificationStore(new FakeFirestore());
  await store.createPairing({
    id: "pairing-1",
    pairingCode: "ABC123",
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });

  const pending = await store.findPendingPairing(
    "pairing-1",
    "ABC123",
    () => false,
  );
  expect(pending.id).toBe("pairing-1");

  await store.linkDevice({
    pairingId: "pairing-1",
    device: {
      id: "device-1",
      displayName: "Pixel",
      platform: "Android",
      browser: "Chrome",
      linkedAt: "2026-07-02T00:00:00.000Z",
      lastSeenAt: "2026-07-02T00:00:00.000Z",
    },
    subscription: { endpoint: "https://push.example.com", keys: {} },
  });

  const pairing = await store.getPairing("pairing-1");
  expect(pairing.status).toBe("linked");
  expect(pairing.deviceId).toBe("device-1");
  expect(await store.listDevices()).toHaveLength(1);
  expect((await store.getSubscription("device-1")).enabled).toBe(true);
});

test("firestore store expires pairings and skips expired codes", async () => {
  const store = new FirestoreNotificationStore(new FakeFirestore());
  await store.createPairing({
    id: "pairing-1",
    pairingCode: "ABC123",
    status: "pending",
    expiresAt: "2026-07-02T00:00:00.000Z",
  });

  expect(
    await store.findPendingPairing(null, "ABC123", () => true),
  ).toBeNull();

  const expired = await store.expirePairing("pairing-1");
  expect(expired.status).toBe("expired");
  expect((await store.getPairing("pairing-1")).status).toBe("expired");
});

test("firestore store touches, disables, and deletes subscriptions", async () => {
  const store = new FirestoreNotificationStore(new FakeFirestore());
  await store.createPairing({
    id: "pairing-1",
    pairingCode: "ABC123",
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await store.linkDevice({
    pairingId: "pairing-1",
    device: {
      id: "device-1",
      linkedAt: "2026-07-02T00:00:00.000Z",
      lastSeenAt: "2026-07-02T00:00:00.000Z",
    },
    subscription: { endpoint: "https://push.example.com", keys: {} },
  });

  await store.touchSubscription("device-1", "2026-07-02T01:00:00.000Z");
  expect((await store.getSubscription("device-1")).lastSeenAt).toBe(
    "2026-07-02T01:00:00.000Z",
  );
  expect((await store.listDevices())[0].lastSeenAt).toBe(
    "2026-07-02T01:00:00.000Z",
  );

  await store.disableSubscription("device-1", "2026-07-02T02:00:00.000Z");
  const disabled = await store.getSubscription("device-1");
  expect(disabled.enabled).toBe(false);
  expect(disabled.disabledAt).toBe("2026-07-02T02:00:00.000Z");

  await store.deleteDevice("device-1");
  expect(await store.getSubscription("device-1")).toBeNull();
  expect(await store.listDevices()).toHaveLength(0);
});

test("store factory falls back to json store without firestore config", () => {
  const store = createNotificationStore({
    STORE_FILE: path.join(os.tmpdir(), `arc-notify-${Date.now()}.json`),
  });

  expect(store).toBeInstanceOf(JsonNotificationStore);
});

test("firestore factory requires service account credentials", () => {
  expect(() =>
    createFirestoreNotificationStore({ FIREBASE_PROJECT_ID: "app-release-center" }),
  ).toThrow("FIREBASE_SERVICE_ACCOUNT_JSON_B64");
});

test("service account config supports base64 json", () => {
  const raw = JSON.stringify({
    project_id: "app-release-center",
    client_email: "firebase-adminsdk@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
  });

  expect(
    serviceAccountFromConfig({
      FIREBASE_SERVICE_ACCOUNT_JSON_B64: Buffer.from(raw).toString("base64"),
    }).project_id,
  ).toBe("app-release-center");
});

class FakeFirestore {
  constructor() {
    this.records = new Map();
  }

  collection(name) {
    return new FakeCollection(this, name);
  }

  async runTransaction(callback) {
    const transaction = {
      get: (ref) => ref.get(),
      set: (ref, data) => ref.set(data),
      update: (ref, patch) => ref.update(patch),
    };
    return callback(transaction);
  }
}

class FakeCollection {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  doc(id) {
    return new FakeDocRef(this.db, this.name, id);
  }

  where(field, operator, value) {
    return new FakeQuery(this.db, this.name).where(field, operator, value);
  }

  orderBy(field, direction) {
    return new FakeQuery(this.db, this.name).orderBy(field, direction);
  }
}

class FakeQuery {
  constructor(db, collectionName, filters = [], order = null, limitCount = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.filters = filters;
    this.order = order;
    this.limitCount = limitCount;
  }

  where(field, operator, value) {
    return new FakeQuery(
      this.db,
      this.collectionName,
      this.filters.concat([{ field, operator, value }]),
      this.order,
      this.limitCount,
    );
  }

  orderBy(field, direction) {
    return new FakeQuery(
      this.db,
      this.collectionName,
      this.filters,
      { field, direction },
      this.limitCount,
    );
  }

  limit(limitCount) {
    return new FakeQuery(
      this.db,
      this.collectionName,
      this.filters,
      this.order,
      limitCount,
    );
  }

  async get() {
    let docs = Array.from(this.db.records.entries())
      .filter(([key]) => key.startsWith(`${this.collectionName}/`))
      .map(([key, value]) => new FakeDocSnapshot(key, value));

    for (const filter of this.filters) {
      docs = docs.filter((doc) => {
        if (filter.operator !== "==") {
          throw new Error(`Unsupported fake operator ${filter.operator}`);
        }
        return doc.data()[filter.field] === filter.value;
      });
    }

    if (this.order) {
      docs.sort((a, b) => {
        const left = a.data()[this.order.field] || "";
        const right = b.data()[this.order.field] || "";
        const result = String(left).localeCompare(String(right));
        return this.order.direction === "desc" ? -result : result;
      });
    }

    return {
      docs: this.limitCount === null ? docs : docs.slice(0, this.limitCount),
    };
  }
}

class FakeDocRef {
  constructor(db, collectionName, id) {
    this.db = db;
    this.key = `${collectionName}/${id}`;
  }

  async get() {
    return new FakeDocSnapshot(this.key, this.db.records.get(this.key));
  }

  async set(data) {
    this.db.records.set(this.key, clone(data));
  }

  async update(patch) {
    const current = this.db.records.get(this.key);
    if (!current) throw new Error("Document not found.");
    this.db.records.set(this.key, { ...current, ...clone(patch) });
  }

  async delete() {
    this.db.records.delete(this.key);
  }
}

class FakeDocSnapshot {
  constructor(key, value) {
    this.id = key.split("/").pop();
    this.exists = value !== undefined;
    this._value = value;
  }

  data() {
    return clone(this._value);
  }
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
