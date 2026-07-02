# Release Command Web Push

Self-hosted Web Push notification server for App Release Center. This replaces
Firebase Functions/Hosting with a plain Node.js service, and can use Firestore
for persistent device links.

## Local Setup

```powershell
cd C:\Users\miste\Desktop\Work\Project\app_release_center\serverless\notifications
npm install
npx.cmd web-push generate-vapid-keys
Copy-Item .env.example .env
notepad .env
npm start
```

Set `.env` like this:

```env
PORT=8080
PUBLIC_BASE_URL=
VAPID_PUBLIC_KEY=public_key_from_web_push
VAPID_PRIVATE_KEY=private_key_from_web_push
VAPID_SUBJECT=mailto:you@example.com
DESKTOP_API_TOKEN=a_long_random_secret
STORE_FILE=./data/notifications-store.json
FIREBASE_PROJECT_ID=
FIREBASE_SERVICE_ACCOUNT_JSON_B64=
```

`PUBLIC_BASE_URL` is optional. Leave it empty on Render; the server will use the
incoming request host so pairing links match the active Render URL.

For local testing, you may use:

```env
PUBLIC_BASE_URL=http://localhost:8080
```

Web Push on phones needs HTTPS in real use, so deploy behind an HTTPS domain
before scanning the QR from mobile.

Local runs use the JSON `STORE_FILE` by default. To test Firestore locally, set
`FIREBASE_PROJECT_ID` and `FIREBASE_SERVICE_ACCOUNT_JSON_B64`.

## Deploy Options

Any Node.js host works: VPS, Render, Railway, Fly.io, Docker, or a company
server. The service only needs:

- Node.js 20+
- HTTPS public URL
- Firestore credentials, or persistent storage for the JSON fallback
- Environment variables from `.env.example`

### Render

This server repository includes a root-level `render.yaml` Blueprint. In Render:

1. New > Blueprint.
2. Connect this Git repository.
3. Keep the Blueprint path as `render.yaml`.
4. Fill the prompted environment variables.

Use these values:

```text
VAPID_PUBLIC_KEY=public_key_from_web_push
VAPID_PRIVATE_KEY=private_key_from_web_push
VAPID_SUBJECT=mailto:you@example.com
DESKTOP_API_TOKEN=a_long_random_secret
FIREBASE_PROJECT_ID=app-release-center
FIREBASE_SERVICE_ACCOUNT_JSON_B64=base64_encoded_service_account_json
```

When `FIREBASE_PROJECT_ID` or `FIREBASE_SERVICE_ACCOUNT_JSON_B64` is present,
the server stores pairings, linked devices, and push subscriptions in Firestore:

```text
pairingSessions/{pairingId}
devices/{deviceId}
pushSubscriptions/{deviceId}
```

This keeps linked phones after Render sleeps, restarts, or redeploys. If
Firestore env vars are absent, the server falls back to `STORE_FILE`; Free
Render services use ephemeral disk, so that fallback can lose linked phones.

Create the base64 service account value from a downloaded Firebase service
account JSON file with PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("firebase-service-account.json"))
```

Docker:

```bash
docker build -t app-release-center-notifications .
docker run -p 8080:8080 --env-file .env -v "%cd%/data:/app/data" app-release-center-notifications
```

After deploy, enter this in the desktop app:

```text
Serverless endpoint: https://your-public-domain.example.com/api
Desktop API token: DESKTOP_API_TOKEN
```

The API remains compatible with the desktop app:

- `POST /api/pairings`
- `GET /api/pairings/:pairingId`
- `POST /api/push-subscriptions`
- `GET /api/devices`
- `DELETE /api/devices/:deviceId`
- `POST /api/test-notifications`
- `POST /api/command-events`
