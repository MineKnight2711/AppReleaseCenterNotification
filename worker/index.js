// The relay running on Cloudflare Workers.
//
// Routing and storage are Workers-shaped; every rule about scopes, lanes,
// command shapes and push payloads comes from ../src/relay_core.js, the same
// module the Express host uses. Behaviour differences between the two hosts
// should only ever be about transport.
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import core from '../src/relay_core.js';
import helpers from '../src/helpers.js';
import fcm from '../src/fcm.js';
import { D1NotificationStore } from './d1_store.js';
import { createPushClient } from './push.js';

const {
  buildCommandPayload,
  commandRunFromEvent,
  commandRunJson,
  commandRunSignature,
  deviceIds,
  deviceJson,
  deviceScopes,
  isValidCommandRunSignature,
  isExpiredIso,
  randomCode,
  randomId,
  randomToken,
  secretHash,
  stringValue,
} = helpers;

const {
  DEFAULT_DESKTOP_ID,
  MAX_LONG_POLL_MS,
  cleanupCommandRuns,
  commandResult,
  compactObject,
  desktopStateJson,
  detailViewSecret,
  intOrNull,
  isoOrNull,
  normalizePushToken,
  normalizeReleaseEvent,
  normalizeRemoteCommand,
  preferredDesktop,
  releasePushMessage,
  remoteCommandJson,
  remoteInputJson,
  remoteStatus,
  requireOwnedRemoteCommand,
  sendToDevices,
  waitForQueuedCommands,
} = core;

const app = new Hono();

app.use('*', cors({ origin: (origin) => origin || '*' }));

// Every handler reaches for these, and building them per request keeps the
// Worker free of module-level state that would leak between isolates.
app.use('/api/*', async (c, next) => {
  c.set('store', new D1NotificationStore(c.env.DB));
  c.set('pushClient', createPushClient());
  await next();
});

function desktopAuth(c, next) {
  const expected = stringValue(c.env.DESKTOP_API_TOKEN);
  if (!expected) return next();
  if (c.req.header('authorization') !== `Bearer ${expected}`) {
    return c.json({ error: 'Unauthorized.' }, 401);
  }
  return next();
}

async function mobileAuth(c, next) {
  const header = stringValue(c.req.header('authorization'));
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice('bearer '.length)
    : '';
  if (!token) return c.json({ error: 'Unauthorized.' }, 401);

  const device = await c.get('store').findDeviceByControlTokenHash(secretHash(token));
  if (!device) return c.json({ error: 'Unauthorized.' }, 401);

  c.set('mobileDevice', device);
  return next();
}

function publicBaseUrl(c) {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = c.req.header('x-forwarded-host') || c.req.header('host') || url.host;
  if (host) return `${proto}://${host}`;
  return stringValue(c.env.PUBLIC_BASE_URL) || 'http://localhost:8787';
}

function commandRunDetailUrl(c, runId, deviceId) {
  const url = new URL(`/runs/${encodeURIComponent(runId)}`, publicBaseUrl(c));
  url.searchParams.set('deviceId', deviceId);
  url.searchParams.set(
    'sig',
    commandRunSignature(detailViewSecret(c.env), runId, deviceId),
  );
  return `${url.pathname}${url.search}`;
}

async function body(c) {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function longPollMs(c) {
  return Math.min(
    Math.max(Number.parseInt(c.req.query('waitMs'), 10) || 0, 0),
    MAX_LONG_POLL_MS,
  );
}

app.get('/api/config', (c) =>
  c.json({ vapidPublicKey: stringValue(c.env.VAPID_PUBLIC_KEY) }),
);

app.post('/api/pairings', desktopAuth, async (c) => {
  const input = await body(c);
  const pairingId = randomId();
  const pairingCode = randomCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const pairing = {
    id: pairingId,
    pairingCode,
    status: 'pending',
    source: stringValue(input.source) || 'desktop',
    app: stringValue(input.app) || 'app_release_center',
    // Chosen by the desktop here; the phone only inherits them.
    scopes: deviceScopes(input.scopes),
    // The desktop that made the code. A device linked through it may send
    // that desktop the commands it alone may receive; see relay_core.
    desktopId: stringValue(input.desktopId),
    createdAt: new Date().toISOString(),
    expiresAt,
  };
  await c.get('store').createPairing(pairing);

  const pairingUrl = new URL(publicBaseUrl(c));
  pairingUrl.searchParams.set('pairing', pairingId);
  pairingUrl.searchParams.set('code', pairingCode);

  return c.json(
    { pairingId, pairingCode, pairingUrl: pairingUrl.toString(), expiresAt },
    201,
  );
});

app.get('/api/pairings/:pairingId', desktopAuth, async (c) => {
  const store = c.get('store');
  const pairing = await store.getPairing(c.req.param('pairingId'));
  if (!pairing) return c.json({ error: 'Pairing session not found.' }, 404);

  let status = pairing.status || 'pending';
  if (status === 'pending' && isExpiredIso(pairing.expiresAt)) {
    status = 'expired';
    await store.expirePairing(pairing.id);
  }

  const response = { status, expiresAt: pairing.expiresAt };
  if (status === 'linked' && pairing.deviceId) {
    const devices = await store.listDevices();
    const device = devices.find((entry) => entry.id === pairing.deviceId);
    if (device) response.device = deviceJson(device);
  }
  return c.json(response);
});

/// Links a device and hands back its control token.
///
/// Shared by the PWA (which also registers a push subscription) and the
/// Android app (which does not).
async function linkDeviceRoute(c, { defaults, withSubscription }) {
  const input = await body(c);
  const pairingCode = stringValue(input.pairingCode);
  const subscription = input.subscription;

  if (!pairingCode) {
    return c.json({ error: 'Pairing code is required.' }, 400);
  }
  if (withSubscription && (!subscription || !subscription.endpoint)) {
    return c.json(
      { error: 'Pairing code and subscription are required.' },
      400,
    );
  }

  const store = c.get('store');
  const pairing = await store.findPendingPairing(
    stringValue(input.pairingId),
    pairingCode,
    isExpiredIso,
  );
  if (!pairing) {
    return c.json({ error: 'Pairing session is invalid or expired.' }, 404);
  }

  const now = new Date().toISOString();
  const deviceControlToken = randomToken();
  const device = {
    id: randomId(),
    displayName: stringValue(input.deviceName) || defaults.displayName,
    platform: stringValue(input.platform) || defaults.platform,
    browser: stringValue(input.browser),
    linkedAt: now,
    lastSeenAt: now,
    controlTokenHash: secretHash(deviceControlToken),
    // Inherited from the pairing the desktop created, never from the body.
    scopes: deviceScopes(pairing.scopes),
    desktopId: stringValue(pairing.desktopId),
  };

  await store.linkDevice({
    pairingId: pairing.id,
    device,
    subscription: withSubscription ? subscription : undefined,
  });

  return c.json(
    {
      device: deviceJson(device),
      deviceControlToken,
      desktopId: device.desktopId,
    },
    201,
  );
}

app.post('/api/push-subscriptions', (c) =>
  linkDeviceRoute(c, {
    defaults: { displayName: 'Linked phone', platform: '' },
    withSubscription: true,
  }),
);

app.post('/api/control-devices', (c) =>
  linkDeviceRoute(c, {
    defaults: { displayName: 'Android phone', platform: 'Android' },
    withSubscription: false,
  }),
);

app.get('/api/devices', desktopAuth, async (c) => {
  const devices = await c.get('store').listDevices();
  return c.json({ devices: devices.map(deviceJson) });
});

app.delete('/api/devices/:deviceId', desktopAuth, async (c) => {
  await c.get('store').deleteDevice(c.req.param('deviceId'));
  return c.body(null, 204);
});

app.post('/api/test-notifications', desktopAuth, async (c) => {
  const input = await body(c);
  const result = await sendToDevices({
    config: c.env,
    store: c.get('store'),
    pushClient: c.get('pushClient'),
    targetDeviceIds: deviceIds(input.targetDeviceIds),
    payload: {
      title: 'App Release Center test',
      body: 'Phone notification link is working.',
      data: { url: '/' },
    },
  });
  return c.json(result);
});

app.post('/api/command-events', desktopAuth, async (c) => {
  const input = await body(c);
  const store = c.get('store');
  const targetDeviceIds = deviceIds(input.targetDeviceIds);
  const commandRun = await store.upsertCommandRun(
    commandRunFromEvent(input, targetDeviceIds),
  );
  const result = await sendToDevices({
    config: c.env,
    store,
    pushClient: c.get('pushClient'),
    targetDeviceIds,
    payloadForDevice: (deviceId) =>
      buildCommandPayload(commandRun, {
        url: commandRunDetailUrl(c, commandRun.runId, deviceId),
      }),
  });
  // Not awaited on the Express host either; the caller should not wait for
  // housekeeping, but a Worker must be told to keep the isolate alive for it.
  c.executionCtx.waitUntil(Promise.resolve(cleanupCommandRuns(store)));
  return c.json(result);
});

/// A release finished or failed on a desktop: tell every phone that asked.
///
/// Phones opt in by registering an FCM token, so there is no list to keep on
/// the desktop; targetDeviceIds only narrows it, as a test from one phone does.
app.post('/api/release-events', desktopAuth, async (c) => {
  const event = normalizeReleaseEvent(await body(c));
  const account = fcm.parseServiceAccount(c.env.FCM_SERVICE_ACCOUNT_JSON);
  if (!account) {
    return c.json(
      {
        error:
          'FCM_SERVICE_ACCOUNT_JSON is not configured on the relay. Set it with wrangler secret put.',
      },
      400,
    );
  }
  const store = c.get('store');
  const devices = (await store.listDevices()).filter(
    (device) =>
      stringValue(device.fcmToken) &&
      (event.targetDeviceIds.length === 0 ||
        event.targetDeviceIds.includes(device.id)),
  );
  let sent = 0;
  let removed = 0;
  const failures = [];
  for (const device of devices) {
    const result = await fcm.sendFcm(
      account,
      releasePushMessage(event, device.fcmToken),
    );
    if (result.ok) {
      sent += 1;
      continue;
    }
    failures.push(`${device.displayName || device.id}: ${result.errorCode || result.message}`);
    if (fcm.isStaleFcmToken(result)) {
      await store.updateDevice(device.id, { fcmToken: '' });
      removed += 1;
    }
  }
  return c.json({ devices: devices.length, sent, failed: failures.length, removed, failures });
});

app.get('/api/command-runs/:runId', async (c) => {
  const store = c.get('store');
  const runId = stringValue(c.req.param('runId'));
  const deviceId = stringValue(c.req.query('deviceId'));
  const signature = stringValue(c.req.query('sig'));
  const secret = detailViewSecret(c.env);

  if (
    !runId ||
    !deviceId ||
    !secret ||
    !isValidCommandRunSignature(secret, runId, deviceId, signature)
  ) {
    return c.json(
      { error: 'This notification detail is no longer available.' },
      403,
    );
  }

  const [run, subscription] = await Promise.all([
    store.getCommandRun(runId),
    store.getSubscription(deviceId),
  ]);
  if (
    !run ||
    !subscription ||
    !Array.isArray(run.targetDeviceIds) ||
    !run.targetDeviceIds.includes(deviceId)
  ) {
    return c.json(
      { error: 'This notification detail is no longer available.' },
      404,
    );
  }

  return c.json({ run: commandRunJson(run) });
});

app.post('/api/desktop/heartbeat', desktopAuth, async (c) => {
  const input = await body(c);
  const saved = await c.get('store').upsertDesktopState({
    desktopId: stringValue(input.desktopId) || DEFAULT_DESKTOP_ID,
    displayName: stringValue(input.displayName) || 'Desktop',
    lastSeenAt: new Date().toISOString(),
    remoteControlEnabled: input.remoteControlEnabled !== false,
    state: input.state && typeof input.state === 'object' ? input.state : {},
  });
  return c.json({ desktop: desktopStateJson(saved) });
});

/// Drains one lane's queue, holding the request open while it is empty.
function queueRoute(lane) {
  return async (c) => {
    const desktopId = stringValue(c.req.query('desktopId')) || DEFAULT_DESKTOP_ID;
    const commands = await waitForQueuedCommands(
      c.get('store'),
      desktopId,
      longPollMs(c),
      lane,
    );
    return c.json({ commands: commands.map(remoteCommandJson) });
  };
}

app.get('/api/desktop/commands', desktopAuth, queueRoute('release'));
app.get('/api/desktop/control-commands', desktopAuth, queueRoute('control'));

app.post('/api/desktop/commands/:commandId/claim', desktopAuth, async (c) => {
  const input = await body(c);
  const command = await c
    .get('store')
    .claimRemoteCommand(
      c.req.param('commandId'),
      stringValue(input.desktopId) || DEFAULT_DESKTOP_ID,
      new Date().toISOString(),
    );
  if (!command) return c.json({ error: 'Command is no longer queued.' }, 409);
  return c.json({ command: remoteCommandJson(command) });
});

app.post('/api/desktop/commands/:commandId/events', desktopAuth, async (c) => {
  const input = await body(c);
  const now = new Date().toISOString();
  const patch = compactObject({
    status: remoteStatus(input.status),
    runId: stringValue(input.runId),
    startedAt: isoOrNull(input.startedAt),
    finishedAt: isoOrNull(input.finishedAt),
    durationMs: intOrNull(input.durationMs),
    exitCode: intOrNull(input.exitCode),
    error: stringValue(input.error),
    yesNoPrompt: stringValue(input.yesNoPrompt),
    logLines: helpers.normalizeRemoteLogLines(input.logLines),
    result: commandResult(input.result),
    updatedAt: now,
  });
  const command = await c
    .get('store')
    .updateRemoteCommand(c.req.param('commandId'), patch);
  if (!command) return c.json({ error: 'Command not found.' }, 404);
  return c.json({ command: remoteCommandJson(command) });
});

app.get('/api/desktop/commands/:commandId/inputs', desktopAuth, async (c) => {
  const afterSequence = Number.parseInt(c.req.query('afterSequence'), 10) || 0;
  const inputs = await c
    .get('store')
    .listRemoteCommandInputs(c.req.param('commandId'), afterSequence);
  return c.json({ inputs: inputs.map(remoteInputJson) });
});

app.get('/api/mobile/desktop-state', mobileAuth, async (c) => {
  const desktops = await c.get('store').listDesktopStates();
  const desktop = preferredDesktop(desktops, c.get('mobileDevice'));
  return c.json({ desktop: desktop ? desktopStateJson(desktop) : null });
});

// Every desktop, newest heartbeat first. desktop-state above answers only
// with the most recent one, which is the wrong machine as soon as a build
// host and the desktop driving it both report in.
app.get('/api/mobile/desktops', mobileAuth, async (c) => {
  const desktops = await c.get('store').listDesktopStates();
  return c.json({ desktops: desktops.map(desktopStateJson) });
});

/// The phone's FCM token, or an empty one to stop release pushes.
app.post('/api/mobile/push-token', mobileAuth, async (c) => {
  const token = normalizePushToken((await body(c)).token);
  const device = c.get('mobileDevice');
  await c.get('store').updateDevice(device.id, {
    fcmToken: token,
    fcmTokenUpdatedAt: new Date().toISOString(),
  });
  return c.json({ releasePush: Boolean(token) });
});

app.post('/api/mobile/commands', mobileAuth, async (c) => {
  const input = await body(c);
  const command = normalizeRemoteCommand(
    input,
    c.get('mobileDevice'),
    new Date().toISOString(),
  );
  const saved = await c.get('store').createRemoteCommand(command);
  return c.json({ command: remoteCommandJson(saved) }, 201);
});

app.get('/api/mobile/commands/:commandId', mobileAuth, async (c) => {
  const command = await requireOwnedRemoteCommand(
    c.get('store'),
    c.req.param('commandId'),
    c.get('mobileDevice'),
  );
  return c.json({ command: remoteCommandJson(command) });
});

app.post('/api/mobile/commands/:commandId/input', mobileAuth, async (c) => {
  const store = c.get('store');
  const device = c.get('mobileDevice');
  const commandId = c.req.param('commandId');
  await requireOwnedRemoteCommand(store, commandId, device);

  const value = stringValue((await body(c)).value);
  if (!value) return c.json({ error: 'Input value is required.' }, 400);

  const input = await store.appendRemoteCommandInput(commandId, {
    kind: 'stdin',
    value,
    createdAt: new Date().toISOString(),
    deviceId: device.id,
  });
  return c.json({ input: remoteInputJson(input) }, 201);
});

app.post('/api/mobile/commands/:commandId/stop', mobileAuth, async (c) => {
  const store = c.get('store');
  const device = c.get('mobileDevice');
  const commandId = c.req.param('commandId');
  await requireOwnedRemoteCommand(store, commandId, device);

  const input = await store.appendRemoteCommandInput(commandId, {
    kind: 'stop',
    createdAt: new Date().toISOString(),
    deviceId: device.id,
  });
  return c.json({ input: remoteInputJson(input) }, 201);
});

// Anything else is the PWA: hand it to the static assets, which fall back to
// index.html so client-side routes like /runs/<id> still resolve.
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) console.error(error);
  return c.json({ error: error.message || 'Notification server error.' }, statusCode);
});

export default app;
