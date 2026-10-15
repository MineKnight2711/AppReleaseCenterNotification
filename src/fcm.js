// Firebase Cloud Messaging (HTTP v1) for the relay.
//
// Release results go to the Android app through FCM rather than Web Push: a
// native notification channel is the only place a phone keeps a sound and a
// vibration pattern of our choosing. The relay signs in as the Firebase service
// account with a short-lived OAuth token, built on WebCrypto so the same code
// runs in the Worker and under jest.

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Per isolate. Tokens last an hour; minting one per push would add a round
// trip to Google and a signature to every notification.
const tokenCache = new Map();

/// Reads FCM_SERVICE_ACCOUNT_JSON, as pasted JSON or base64 of it. Returns
/// null when unset, so the caller can say what to configure.
function parseServiceAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let json = text;
  if (!text.startsWith("{")) {
    try {
      json = new TextDecoder().decode(base64ToBytes(text));
    } catch (_) {
      throw configurationError("FCM_SERVICE_ACCOUNT_JSON is neither JSON nor base64.");
    }
  }
  let account;
  try {
    account = JSON.parse(json);
  } catch (_) {
    throw configurationError("FCM_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }
  if (!account.client_email || !account.private_key || !account.project_id) {
    throw configurationError(
      "FCM_SERVICE_ACCOUNT_JSON needs client_email, private_key and project_id: use the key file from Firebase > Project settings > Service accounts.",
    );
  }
  return {
    clientEmail: account.client_email,
    privateKey: account.private_key,
    projectId: account.project_id,
  };
}

async function signJwt(claims, privateKeyPem) {
  const encode = (value) =>
    bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}`;
  const key = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pemToDer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function accessToken(account, { fetchImpl = fetch, now = Date.now } = {}) {
  const cached = tokenCache.get(account.clientEmail);
  if (cached && cached.expiresAt - 60 * 1000 > now()) return cached.token;

  const issuedAt = Math.floor(now() / 1000);
  const assertion = await signJwt(
    {
      iss: account.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
    account.privateKey,
  );
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw configurationError(
      `Google refused the FCM service account: ${body.error_description || body.error || `HTTP ${response.status}`}.`,
    );
  }
  tokenCache.set(account.clientEmail, {
    token: body.access_token,
    expiresAt: now() + (Number(body.expires_in) || 3600) * 1000,
  });
  return body.access_token;
}

/// Sends one message. Never throws for a refused message: the caller decides
/// per device whether the token is worth keeping.
async function sendFcm(account, message, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const token = await accessToken(account, options);
  const response = await fetchImpl(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(message),
    },
  );
  if (response.ok) return { ok: true };
  const body = await response.json().catch(() => ({}));
  const error = body.error || {};
  const details = Array.isArray(error.details) ? error.details : [];
  const detail = details.find((entry) => entry && entry.errorCode) || {};
  return {
    ok: false,
    status: response.status,
    errorCode: detail.errorCode || error.status || "",
    message: error.message || `HTTP ${response.status}`,
  };
}

/// A token FCM no longer knows: the app was uninstalled or its data cleared.
/// A malformed message is our fault, not the token's, and keeps it.
function isStaleFcmToken(result) {
  return !result.ok && (result.status === 404 || result.errorCode === "UNREGISTERED");
}

function pemToDer(pem) {
  return base64ToBytes(
    String(pem)
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s+/g, ""),
  );
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function configurationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.expose = true;
  return error;
}

function clearTokenCache() {
  tokenCache.clear();
}

module.exports = {
  accessToken,
  clearTokenCache,
  isStaleFcmToken,
  parseServiceAccount,
  sendFcm,
  signJwt,
};
