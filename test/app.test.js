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
      PUBLIC_BASE_URL: "https://notify.example.com",
    },
  });
  return { app, store, pushClient };
}

test("creates pairing and links phone subscription", async () => {
  const { app } = testHarness();
  const pairingResponse = await request(app)
    .post("/api/pairings")
    .set("Authorization", "Bearer secret")
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
