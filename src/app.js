const cors = require("cors");
const express = require("express");
const path = require("path");
const webpush = require("web-push");

const {
  buildCommandPayload,
  deviceIds,
  deviceJson,
  isExpiredIso,
  randomCode,
  randomId,
  shouldDisableSubscription,
  stringValue,
} = require("./helpers");
const { JsonNotificationStore } = require("./store");

function createApp(options = {}) {
  const config = options.config || process.env;
  const store =
    options.store ||
    new JsonNotificationStore(config.STORE_FILE || "./data/notifications-store.json");
  const pushClient = options.pushClient || webpush;
  const app = express();

  app.use(cors({ origin: true }));
  app.use(express.json({ limit: "256kb" }));
  app.use(express.static(path.join(__dirname, "..", "public")));

  app.get("/api/config", (_req, res) => {
    res.json({ vapidPublicKey: stringValue(config.VAPID_PUBLIC_KEY) });
  });

  app.post("/api/pairings", requireDesktopAuth(config), async (req, res, next) => {
    try {
      const pairingId = randomId();
      const pairingCode = randomCode();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const pairing = {
        id: pairingId,
        pairingCode,
        status: "pending",
        source: stringValue(req.body.source) || "desktop",
        app: stringValue(req.body.app) || "app_release_center",
        createdAt: new Date().toISOString(),
        expiresAt,
      };
      await store.createPairing(pairing);

      const pairingUrl = new URL(publicBaseUrl(config, req));
      pairingUrl.searchParams.set("pairing", pairingId);
      pairingUrl.searchParams.set("code", pairingCode);

      res.status(201).json({
        pairingId,
        pairingCode,
        pairingUrl: pairingUrl.toString(),
        expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/pairings/:pairingId",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const pairing = await store.getPairing(req.params.pairingId);
        if (!pairing) {
          res.status(404).json({ error: "Pairing session not found." });
          return;
        }

        let status = pairing.status || "pending";
        if (status === "pending" && isExpiredIso(pairing.expiresAt)) {
          status = "expired";
          await store.expirePairing(pairing.id);
        }

        const response = { status, expiresAt: pairing.expiresAt };
        if (status === "linked" && pairing.deviceId) {
          const devices = await store.listDevices();
          const device = devices.find((entry) => entry.id === pairing.deviceId);
          if (device) response.device = deviceJson(device);
        }

        res.json(response);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/push-subscriptions", async (req, res, next) => {
    try {
      const pairingCode = stringValue(req.body.pairingCode);
      const pairingId = stringValue(req.body.pairingId);
      const subscription = req.body.subscription;

      if (!pairingCode || !subscription || !subscription.endpoint) {
        res.status(400).json({ error: "Pairing code and subscription are required." });
        return;
      }

      const pairing = await store.findPendingPairing(
        pairingId,
        pairingCode,
        isExpiredIso,
      );
      if (!pairing) {
        res.status(404).json({ error: "Pairing session is invalid or expired." });
        return;
      }

      const now = new Date().toISOString();
      const device = {
        id: randomId(),
        displayName: stringValue(req.body.deviceName) || "Linked phone",
        platform: stringValue(req.body.platform),
        browser: stringValue(req.body.browser),
        linkedAt: now,
        lastSeenAt: now,
      };
      await store.linkDevice({ pairingId: pairing.id, device, subscription });

      res.status(201).json({ device: deviceJson(device) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/devices", requireDesktopAuth(config), async (_req, res, next) => {
    try {
      const devices = await store.listDevices();
      res.json({ devices: devices.map(deviceJson) });
    } catch (error) {
      next(error);
    }
  });

  app.delete(
    "/api/devices/:deviceId",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        await store.deleteDevice(req.params.deviceId);
        res.status(204).send("");
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/test-notifications",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const result = await sendToDevices({
          config,
          store,
          pushClient,
          targetDeviceIds: deviceIds(req.body.targetDeviceIds),
          payload: {
            title: "App Release Center test",
            body: "Phone notification link is working.",
            data: { url: "/" },
          },
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/command-events",
    requireDesktopAuth(config),
    async (req, res, next) => {
      try {
        const result = await sendToDevices({
          config,
          store,
          pushClient,
          targetDeviceIds: deviceIds(req.body.targetDeviceIds),
          payload: buildCommandPayload(req.body),
        });
        res.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  app.use((error, _req, res, _next) => {
    const statusCode = Number.isInteger(error.statusCode)
      ? error.statusCode
      : 500;
    res.status(statusCode).json({
      error: statusCode === 500 ? "Notification server error." : error.message,
    });
  });

  return app;
}

async function sendToDevices({
  config,
  store,
  pushClient,
  targetDeviceIds,
  payload,
}) {
  if (targetDeviceIds.length === 0) {
    const error = new Error("targetDeviceIds is required.");
    error.statusCode = 400;
    throw error;
  }

  configureWebPush(config, pushClient);
  let sent = 0;
  let failed = 0;
  let disabled = 0;

  for (const deviceId of targetDeviceIds) {
    const record = await store.getSubscription(deviceId);
    if (!record || record.enabled === false) continue;

    try {
      await pushClient.sendNotification(
        record.subscription,
        JSON.stringify(payload),
      );
      sent += 1;
      await store.touchSubscription(deviceId, new Date().toISOString());
    } catch (error) {
      failed += 1;
      if (shouldDisableSubscription(error)) {
        disabled += 1;
        await store.disableSubscription(deviceId, new Date().toISOString());
      }
    }
  }

  return { sent, failed, disabled };
}

function configureWebPush(config, pushClient) {
  const publicKey = stringValue(config.VAPID_PUBLIC_KEY);
  const privateKey = stringValue(config.VAPID_PRIVATE_KEY);
  const subject = stringValue(config.VAPID_SUBJECT) || "mailto:release@example.com";

  if (!publicKey || !privateKey) {
    throw new Error("VAPID keys are not configured.");
  }

  pushClient.setVapidDetails(subject, publicKey, privateKey);
}

function requireDesktopAuth(config) {
  return (req, res, next) => {
    const expected = stringValue(config.DESKTOP_API_TOKEN);
    if (!expected) {
      next();
      return;
    }

    if (req.get("authorization") !== `Bearer ${expected}`) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    next();
  };
}

function publicBaseUrl(config, req) {
  const configured = stringValue(config.PUBLIC_BASE_URL);
  if (configured) return configured;
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  return `${proto}://${req.get("host")}`;
}

module.exports = {
  createApp,
  sendToDevices,
};
