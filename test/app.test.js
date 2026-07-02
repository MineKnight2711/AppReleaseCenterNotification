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
      runId: "run-1",
      targetDeviceIds: [linkedResponse.body.device.id],
      event: "completed",
      command: "fastlane android deploy",
      statusLabel: "deploy",
      projectName: "Demo",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:05.000Z",
      durationMs: 5000,
      exitCode: 0,
      logTail: ["Deploy finished"],
    })
    .expect(200);

  expect(pushClient.sendNotification).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(pushClient.sendNotification.mock.calls[0][1]);
  expect(payload.title).toBe("Completed: Deploy");
  expect(payload.renotify).toBe(true);
  expect(payload.tag).toBe("run-1");
  expect(payload.data.url).toContain("/runs/run-1?");
  expect(payload.data.url).toContain(`deviceId=${linkedResponse.body.device.id}`);

  const detailUrl = new URL(payload.data.url, "https://notify.example.com");
  const detailResponse = await request(app)
    .get(`/api/command-runs/run-1${detailUrl.search}`)
    .expect(200);

  expect(detailResponse.body.run.status).toBe("completed");
  expect(detailResponse.body.run.displayCommandLabel).toBe("Deploy");
  expect(detailResponse.body.run.logTail).toEqual(["Deploy finished"]);

  detailUrl.searchParams.set("sig", "bad");
  await request(app)
    .get(`/api/command-runs/run-1${detailUrl.search}`)
    .expect(403);
});

test("pairs native mobile device and relays remote shell command", async () => {
  const { app } = testHarness();
  const pairingResponse = await request(app)
    .post("/api/pairings")
    .set("Authorization", "Bearer secret")
    .send({ source: "desktop" })
    .expect(201);

  const linkedResponse = await request(app)
    .post("/api/control-devices")
    .send({
      pairingId: pairingResponse.body.pairingId,
      pairingCode: pairingResponse.body.pairingCode,
      deviceName: "Pixel",
      platform: "Android",
    })
    .expect(201);
  const token = linkedResponse.body.deviceControlToken;
  expect(token).toHaveLength(64);

  await request(app)
    .post("/api/desktop/heartbeat")
    .set("Authorization", "Bearer secret")
    .send({
      desktopId: "default",
      displayName: "Windows PC",
      state: { projects: [{ path: "C:\\Demo", name: "Demo" }] },
    })
    .expect(200);

  const desktopState = await request(app)
    .get("/api/mobile/desktop-state")
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  expect(desktopState.body.desktop.displayName).toBe("Windows PC");
  expect(desktopState.body.desktop.online).toBe(true);

  const commandResponse = await request(app)
    .post("/api/mobile/commands")
    .set("Authorization", `Bearer ${token}`)
    .send({
      type: "shell",
      payload: {
        command: "Get-Date",
        workingDirectory: "C:\\Demo",
      },
    })
    .expect(201);
  const commandId = commandResponse.body.command.commandId;
  expect(commandResponse.body.command.status).toBe("queued");

  const pending = await request(app)
    .get("/api/desktop/commands?desktopId=default")
    .set("Authorization", "Bearer secret")
    .expect(200);
  expect(pending.body.commands.map((command) => command.commandId)).toContain(
    commandId,
  );

  await request(app)
    .post(`/api/desktop/commands/${commandId}/claim`)
    .set("Authorization", "Bearer secret")
    .send({ desktopId: "default" })
    .expect(200);

  await request(app)
    .post(`/api/mobile/commands/${commandId}/input`)
    .set("Authorization", `Bearer ${token}`)
    .send({ value: "y" })
    .expect(201);
  const inputs = await request(app)
    .get(`/api/desktop/commands/${commandId}/inputs?afterSequence=0`)
    .set("Authorization", "Bearer secret")
    .expect(200);
  expect(inputs.body.inputs).toEqual([
    expect.objectContaining({ sequence: 1, kind: "stdin", value: "y" }),
  ]);

  await request(app)
    .post(`/api/desktop/commands/${commandId}/events`)
    .set("Authorization", "Bearer secret")
    .send({
      status: "completed",
      exitCode: 0,
      logLines: ["done"],
      finishedAt: "2026-07-02T00:00:05.000Z",
    })
    .expect(200);

  const finalResponse = await request(app)
    .get(`/api/mobile/commands/${commandId}`)
    .set("Authorization", `Bearer ${token}`)
    .expect(200);
  expect(finalResponse.body.command.status).toBe("completed");
  expect(finalResponse.body.command.logLines).toEqual(["done"]);
});

test("requires mobile auth for mobile relay endpoints", async () => {
  const { app } = testHarness();
  await request(app).get("/api/mobile/desktop-state").expect(401);
});

test("disables gone subscriptions after push failures", async () => {
  const { app, pushClient } = testHarness();
  pushClient.sendNotification.mockRejectedValue({ statusCode: 410 });
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

  const response = await request(app)
    .post("/api/test-notifications")
    .set("Authorization", "Bearer secret")
    .send({ targetDeviceIds: [linkedResponse.body.device.id] })
    .expect(200);

  expect(response.body).toEqual({ sent: 0, failed: 1, disabled: 1 });

  await request(app)
    .post("/api/test-notifications")
    .set("Authorization", "Bearer secret")
    .send({ targetDeviceIds: [linkedResponse.body.device.id] })
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
