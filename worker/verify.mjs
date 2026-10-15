// Checks a running relay end to end, whichever host it is on.
//
//   node worker/verify.mjs <baseUrl> <desktopApiToken>
//   node worker/verify.mjs https://amc-relay.example.workers.dev/api "$TOKEN"
//
// It pairs a throwaway device, queues a power command, claims it and reports
// the result, then deletes what it created. Run it after a deploy: the unit
// tests cover the logic, this covers the wiring — auth, routing, storage and
// the long poll actually holding a connection open.

const [, , rawBase, token] = process.argv;

if (!rawBase || !token) {
  console.error('usage: node worker/verify.mjs <baseUrl> <desktopApiToken>');
  process.exit(2);
}

const base = rawBase.replace(/\/+$/, '');
// Cloudflare's bot rules reject some default agents outright; say who we are.
const agent = 'amc-relay-verify/1.0';
const desktop = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
  'User-Agent': agent,
};
const anon = { 'Content-Type': 'application/json', 'User-Agent': agent };

async function call(method, path, body, headers = desktop) {
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_) {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

const failures = [];
function check(label, passed) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`);
  if (!passed) failures.push(label);
}

const desktopId = `verify-${Date.now()}`;
let deviceId = '';
let runOnlyDeviceId = '';

try {
  const config = await call('GET', '/config', undefined, { 'User-Agent': agent });
  check('config responds', config.status === 200);

  const unauthorised = await call('GET', '/devices', undefined, anon);
  check('desktop auth is enforced', unauthorised.status === 401);

  const pairing = await call('POST', '/pairings', {
    source: 'verify',
    scopes: ['run', 'power'],
  });
  check('pairing created', pairing.status === 201);

  const linked = await call(
    'POST',
    '/control-devices',
    {
      pairingId: pairing.body.pairingId,
      pairingCode: pairing.body.pairingCode,
      deviceName: 'relay verify',
      // Asked for more than the pairing granted, on purpose.
      scopes: ['run', 'power', 'window'],
    },
    anon,
  );
  check('device linked', linked.status === 201);
  check(
    'a phone cannot widen its own scopes',
    JSON.stringify(linked.body.device?.scopes) === JSON.stringify(['run', 'power']),
  );
  deviceId = linked.body.device?.id || '';

  const phone = {
    Authorization: `Bearer ${linked.body.deviceControlToken}`,
    'Content-Type': 'application/json',
    'User-Agent': agent,
  };

  const heartbeat = await call('POST', '/desktop/heartbeat', {
    desktopId,
    displayName: 'relay verify',
    state: { powerControlEnabled: true },
  });
  check('heartbeat accepted', heartbeat.status === 200);

  const state = await call('GET', '/mobile/desktop-state', undefined, phone);
  check('phone sees the desktop online', state.body.desktop?.online === true);

  const queued = await call(
    'POST',
    '/mobile/commands',
    { type: 'power', targetDesktopId: desktopId, payload: { action: 'lock' } },
    phone,
  );
  check('power command queued on the control lane', queued.body.command?.lane === 'control');
  const commandId = queued.body.command?.commandId;

  const missingTarget = await call(
    'POST',
    '/mobile/commands',
    { type: 'power', payload: { action: 'lock' } },
    phone,
  );
  check('a power command must name its desktop', missingTarget.status === 400);

  const release = await call('GET', `/desktop/commands?desktopId=${desktopId}&waitMs=0`);
  check('release lane does not carry it', release.body.commands?.length === 0);

  const control = await call('GET', `/desktop/control-commands?desktopId=${desktopId}&waitMs=0`);
  check(
    'control lane carries it',
    control.body.commands?.[0]?.commandId === commandId,
  );

  const claim = await call('POST', `/desktop/commands/${commandId}/claim`, { desktopId });
  check('claimed', claim.status === 200);
  const reclaim = await call('POST', `/desktop/commands/${commandId}/claim`, {
    desktopId: 'someone-else',
  });
  check('a second desktop cannot claim it', reclaim.status === 409);

  await call('POST', `/desktop/commands/${commandId}/events`, {
    status: 'completed',
    exitCode: 0,
    logLines: ['verified'],
  });
  const finished = await call('GET', `/mobile/commands/${commandId}`, undefined, phone);
  check('the phone sees the result', finished.body.command?.status === 'completed');

  const runOnlyPairing = await call('POST', '/pairings', {
    source: 'verify',
    scopes: ['run'],
  });
  const runOnly = await call(
    'POST',
    '/control-devices',
    {
      pairingId: runOnlyPairing.body.pairingId,
      pairingCode: runOnlyPairing.body.pairingCode,
      deviceName: 'relay verify run-only',
    },
    anon,
  );
  runOnlyDeviceId = runOnly.body.device?.id || '';
  const refused = await call(
    'POST',
    '/mobile/commands',
    { type: 'power', targetDesktopId: desktopId, payload: { action: 'lock' } },
    {
      Authorization: `Bearer ${runOnly.body.deviceControlToken}`,
      'Content-Type': 'application/json',
      'User-Agent': agent,
    },
  );
  check(
    'a device without the power scope is refused',
    refused.status === 403 && `${refused.body.error}`.includes('not allowed'),
  );

  // The long poll has to hold the connection open and wake on a new command,
  // which is the part a host change is most likely to break.
  const otherDesktop = `${desktopId}-poll`;
  const started = Date.now();
  const polling = call(
    'GET',
    `/desktop/control-commands?desktopId=${otherDesktop}&waitMs=10000`,
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await call(
    'POST',
    '/mobile/commands',
    { type: 'power', targetDesktopId: otherDesktop, payload: { action: 'lock' } },
    phone,
  );
  const polled = await polling;
  const elapsed = (Date.now() - started) / 1000;
  check(
    `the long poll holds then wakes (${elapsed.toFixed(1)}s)`,
    elapsed < 6 && polled.body.commands?.length === 1,
  );
} finally {
  // Leave nothing behind: deleting the device takes its subscription with it.
  for (const id of [deviceId, runOnlyDeviceId].filter(Boolean)) {
    await call('DELETE', `/devices/${id}`);
  }
}

console.log(`\n${failures.length} failure(s)`);
process.exit(failures.length === 0 ? 0 : 1);
