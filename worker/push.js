// Web Push for Cloudflare Workers.
//
// The `web-push` package the Express host uses is built on Node's crypto
// module and cannot run here, so this implements the same two calls the relay
// actually uses — setVapidDetails and sendNotification — on WebCrypto.
//
// VAPID signing follows RFC 8292 and the payload encryption RFC 8291
// (aes128gcm). Errors carry `statusCode` so helpers.shouldDisableSubscription
// can still retire a subscription the push service has forgotten.

const encoder = new TextEncoder();

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/// An uncompressed P-256 point (0x04 || x || y) as a JWK.
function pointToJwk(publicKey, privateKey) {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('Expected an uncompressed P-256 public key.');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
    ext: true,
  };
  if (privateKey) jwk.d = bytesToBase64Url(privateKey);
  return jwk;
}

async function signVapidToken({ endpoint, subject, publicKey, privateKey }) {
  const audience = new URL(endpoint).origin;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: audience,
    // Twelve hours: the RFC caps it at 24 and push services reject longer.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const signingInput = `${bytesToBase64Url(
    encoder.encode(JSON.stringify(header)),
  )}.${bytesToBase64Url(encoder.encode(JSON.stringify(payload)))}`;

  const key = await crypto.subtle.importKey(
    'jwk',
    pointToJwk(base64UrlToBytes(publicKey), base64UrlToBytes(privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto returns the raw r||s pair JWS wants, not a DER wrapper.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${bytesToBase64Url(signature)}`;
}

/// Encrypts [payload] for [subscription] per RFC 8291.
async function encryptPayload(subscription, payload) {
  const uaPublic = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);

  const ephemeral = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', ephemeral.publicKey),
  );

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey },
      ephemeral.privateKey,
      256,
    ),
  );

  // HKDF twice over: first the auth secret binds the keys to this
  // subscription, then the salt derives the content key and nonce.
  const sharedKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const keyInfo = concat(
    encoder.encode('WebPush: info\0'),
    uaPublic,
    asPublic,
  );
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo },
      sharedKey,
      256,
    ),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, [
    'deriveBits',
  ]);
  const contentKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: encoder.encode('Content-Encoding: aes128gcm\0'),
      },
      ikmKey,
      128,
    ),
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: encoder.encode('Content-Encoding: nonce\0'),
      },
      ikmKey,
      96,
    ),
  );

  const aesKey = await crypto.subtle.importKey(
    'raw',
    contentKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt'],
  );
  // 0x02 is the final-record delimiter; there is only ever one record here.
  const plaintext = concat(encoder.encode(payload), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);

  return concat(
    salt,
    recordSize,
    new Uint8Array([asPublic.length]),
    asPublic,
    ciphertext,
  );
}

export function createPushClient(fetchImpl = fetch) {
  let vapid = null;

  return {
    setVapidDetails(subject, publicKey, privateKey) {
      if (!publicKey || !privateKey) {
        throw new Error('VAPID keys are required.');
      }
      vapid = { subject, publicKey, privateKey };
    },

    async sendNotification(subscription, payload) {
      if (!vapid) throw new Error('VAPID details are not configured.');
      if (!subscription || !subscription.endpoint) {
        throw new Error('Subscription endpoint is required.');
      }

      const token = await signVapidToken({
        endpoint: subscription.endpoint,
        subject: vapid.subject,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      });

      const headers = {
        Authorization: `vapid t=${token}, k=${vapid.publicKey}`,
        TTL: '2419200',
      };
      let requestBody;

      if (payload && subscription.keys && subscription.keys.p256dh) {
        requestBody = await encryptPayload(subscription, payload);
        headers['Content-Encoding'] = 'aes128gcm';
        headers['Content-Type'] = 'application/octet-stream';
        headers['Content-Length'] = String(requestBody.length);
      }

      const response = await fetchImpl(subscription.endpoint, {
        method: 'POST',
        headers,
        body: requestBody,
      });

      if (!response.ok) {
        const error = new Error(
          `Push service responded ${response.status}: ${await response.text()}`,
        );
        // helpers.shouldDisableSubscription retires 404 and 410 from here.
        error.statusCode = response.status;
        throw error;
      }
      return response;
    },
  };
}

export const __testing = {
  base64UrlToBytes,
  bytesToBase64Url,
  concat,
  encryptPayload,
  pointToJwk,
  signVapidToken,
};
