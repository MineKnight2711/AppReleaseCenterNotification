# The relay

Cloudflare Workers, deployed at `https://amc-relay.huynhphuocdat2.workers.dev`
and backed by the `amc-relay` D1 database. This is the only host; the Express
app that ran on Render was removed once this one was verified, and lives on
only in git history.

## What it replaced

| Concern | Render (removed) | Worker |
|---|---|---|
| Router | Express | Hono |
| Storage | Firestore, or a JSON file | D1 (`amc-relay`) |
| Push | `web-push` (Node crypto) | `push.js` on WebCrypto |
| Static PWA | `express.static` | Workers Assets |
| Rules | `src/relay_core.js` | the same file |

`firebase-admin` and `web-push` both reach for Node APIs that Workers do not
have, which is what forced the storage and push rewrites. Everything else was a
port rather than a redesign.

`src/relay_core.js` holds every rule about scopes, lanes, command shapes and
push delivery. It was extracted while both hosts were still running so the two
could not drift; it stays separate from `worker/` because `test/relay_core.test.js`
exercises it directly, without a server.

Records are stored as whole JSON documents with only the columns the queue
filters on lifted out beside them. That mirrors how the old host kept these
objects in memory and patched them by merging, which is what let one set of
record shapes serve both hosts during the migration.

## Long polling

The desktop agent holds a request open for up to 12 seconds waiting for a
command. Workers sustain this: measured against the deployed Worker, a poll
opened before a command was queued returned it about a second later, well
inside the window.

Worth re-checking with `verify.mjs` after any change to the queue code, because
a host that quietly stops holding connections turns every power command into a
multi-second wait without failing anything.

## Deploying

```bash
npx wrangler d1 execute amc-relay --remote --file=worker/schema.sql   # first time
npx wrangler deploy
```

Secrets are set once with `wrangler secret put` and never live in
`wrangler.toml`:

- `DESKTOP_API_TOKEN` — what the desktop app authenticates with
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — Web Push

For local work, put the same names in `.dev.vars` (gitignored) and run
`npx wrangler dev`.

## Verifying a deployment

```bash
node worker/verify.mjs https://amc-relay.huynhphuocdat2.workers.dev/api "$DESKTOP_API_TOKEN"
```

It pairs a throwaway device, queues a power command, claims it, reads the
result back as the phone would, checks that a device without the `power` scope
is refused, times the long poll, and deletes the device it created.

Three layers cover this service:

- `npm test` — the rules, with no server involved.
- `worker/verify.mjs` — the wiring, against any deployment.
- `flutter test test/remote_control_e2e_test.dart` in the app repo — the
  desktop agent and the phone driven against a real `wrangler dev` Worker.

## Things that only show up against the real edge

- **Cloudflare rejects some HTTP clients by user agent.** Python's default
  `Python-urllib/…` gets a 403 with error 1010 before the Worker ever runs.
  Dart's `Dart/… (dart:io)` and curl pass, so the desktop and Android apps are
  fine — but a script that talks to this relay has to set its own agent, which
  is why `verify.mjs` does.
- **Migrating hosts left the device table empty.** Pairings and devices lived
  in Firestore and did not come across, so every phone had to be paired again
  after the endpoint changed.
- **A pairing code only works on the relay that issued it.** The desktop and
  the phone must point at the same endpoint, or linking fails with "Pairing
  session is invalid or expired", which reads like an expiry and is not one.

## Not carried over

Web Push delivery is reimplemented here on WebCrypto (RFC 8292 signing, RFC
8291 `aes128gcm` payloads) but has not been confirmed against a real push
subscription — notifications are switched off in the desktop app, so there was
nothing live to test it with. Treat the first real notification as the test.
