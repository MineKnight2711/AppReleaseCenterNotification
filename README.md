# Release Command Web Push

Self-hosted Web Push notification server for App Release Center. This replaces
the Firebase Functions/Hosting/Firestore version with a plain Node.js service.

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
```

`PUBLIC_BASE_URL` is optional. Leave it empty on Render; the server will use the
incoming request host so pairing links match the active Render URL.

For local testing, you may use:

```env
PUBLIC_BASE_URL=http://localhost:8080
```

Web Push on phones needs HTTPS in real use, so deploy behind an HTTPS domain
before scanning the QR from mobile.

## Deploy Options

Any Node.js host works: VPS, Render, Railway, Fly.io, Docker, or a company
server. The service only needs:

- Node.js 20+
- HTTPS public URL
- Persistent storage for `STORE_FILE`
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
```

Free Render services use ephemeral disk, so linked phones can be lost after a
redeploy. For stable device links, upgrade the service and attach a persistent
disk mounted at `/data`, then set:

```text
STORE_FILE=/data/notifications-store.json
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
