const os = require("os");
const path = require("path");
const request = require("supertest");

const { createApp } = require("../src/app");
const { JsonNotificationStore } = require("../src/store");

function testHarness() {
  const store = new JsonNotificationStore(
    path.join(os.tmpdir(), `arc-notify-${Date.now()}-${Math.random()}.json`),
  );
  const pushClient = {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  const app = createApp({
    store,
    pushClient,
    config: {
      VAPID_PUBLIC_KEY: "public",
      VAPID_PRIVATE_KEY: "private",
      VAPID_SUBJECT: "mailto:test@example.com",
      DESKTOP_API_TOKEN: "secret",
      PUBLIC_BASE_URL: "https://wrong.example.com",
    },
  });
  return { app, store, pushClient };
}

test("creates pairing and links phone subscription", async () => {
  const { app } = testHarness();
  const pairingResponse = await request(app)
    .post("/api/pairings")
    .set("Authorization", "Bearer secret")
    .set("Host", "notify.example.com")
    .set("X-Forwarded-Proto", "https")
    .send({ source: "desktop" })
    .expect(201);

  expect(pairingResponse.body.pairingUrl).toContain("https://notify.example.com");

  await request(app)
    .post("/api/push-subscriptions")
    .send({
      pairingId: pairingResponse.body.pairingId,
      pairingCode: pairingResponse.body.pairingCode,
      deviceName: "Pixel",
      platform: "Android",
      browser: "Chrome",
      subscription: { endpoint: "https://push.example.com", keys: {} },
    })
    .expect(201);

  const pollResponse = await request(app)
    .get(`/api/pairings/${pairingResponse.body.pairingId}`)
    .set("Authorization", "Bearer secret")
    .expect(200);

  expect(pollResponse.body.status).toBe("linked");
  expect(pollResponse.body.device.displayName).toBe("Pixel");
});

test("sends command events to selected subscriptions", async () => {
  const { app, pushClient } = testHarness();
  const pairingResponse = await request(app)
    .post("/api/pairings")
    .set("Authorization", "Bearer secret")
    .set("Host", "notify.example.com")
    .set("X-Forwarded-Proto", "https")
    .send({})
    .expect(201);
  const linkedResponse = await request(app)
    .post("/api/push-subscriptions")
    .send({
      pairingId: pairingResponse.body.pairingId,
      pairingCode: pairingResponse.body.pairingCode,
      subscription: { endpoint: "https://push.example.com", keys: {} },
    })
    .expect(201);

  await request(app)
    .post("/api/command-events")
    .set("Authorization", "Bearer secret")
    .send({
      targetDeviceIds: [linkedResponse.body.device.id],
      event: "completed",
      statusLabel: "deploy",
      projectName: "Demo",
      exitCode: 0,
    })
    .expect(200);

  expect(pushClient.sendNotification).toHaveBeenCalledTimes(1);
});

test("requires desktop auth for protected endpoints", async () => {
  const { app } = testHarness();
  await request(app).get("/api/devices").expect(401);
});

test("returns clear error when VAPID private key is missing", async () => {
  const store = new JsonNotificationStore(
    path.join(os.tmpdir(), `arc-notify-${Date.now()}-${Math.random()}.json`),
  );
  const pushClient = {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  const app = createApp({
    store,
    pushClient,
    config: {
      VAPID_PUBLIC_KEY: "public",
      VAPID_PRIVATE_KEY: "",
      DESKTOP_API_TOKEN: "secret",
    },
  });

  const response = await request(app)
    .post("/api/test-notifications")
    .set("Authorization", "Bearer secret")
    .send({ targetDeviceIds: ["phone-1"] })
    .expect(400);

  expect(response.body.error).toBe("VAPID_PRIVATE_KEY is not configured.");
});

test("returns clear error when VAPID keys are invalid", async () => {
  const store = new JsonNotificationStore(
    path.join(os.tmpdir(), `arc-notify-${Date.now()}-${Math.random()}.json`),
  );
  const pushClient = {
    setVapidDetails: jest.fn(() => {
      throw new Error("invalid key");
    }),
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  const app = createApp({
    store,
    pushClient,
    config: {
      VAPID_PUBLIC_KEY: "public",
      VAPID_PRIVATE_KEY: "private",
      DESKTOP_API_TOKEN: "secret",
    },
  });

  const response = await request(app)
    .post("/api/test-notifications")
    .set("Authorization", "Bearer secret")
    .send({ targetDeviceIds: ["phone-1"] })
    .expect(400);

  expect(response.body.error).toContain("Web Push VAPID configuration is invalid");
});

test("returns server error messages for notification failures", async () => {
  const store = new JsonNotificationStore(
    path.join(os.tmpdir(), `arc-notify-${Date.now()}-${Math.random()}.json`),
  );
  const pushClient = {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  const app = createApp({
    store,
    pushClient,
    config: {
      VAPID_PUBLIC_KEY: "public",
      VAPID_PRIVATE_KEY: "private",
      DESKTOP_API_TOKEN: "secret",
    },
  });
  jest.spyOn(store, "getSubscription").mockRejectedValue(new Error("store failed"));

  const response = await request(app)
    .post("/api/test-notifications")
    .set("Authorization", "Bearer secret")
    .send({ targetDeviceIds: ["phone-1"] })
    .expect(500);

  expect(response.body.error).toBe("store failed");
});
