const {
  accessToken,
  clearTokenCache,
  isStaleFcmToken,
  parseServiceAccount,
  sendFcm,
  signJwt,
} = require("../src/fcm");
const {
  normalizePushToken,
  normalizeReleaseEvent,
  releasePushMessage,
} = require("../src/relay_core");

const subtle = globalThis.crypto.subtle;

async function serviceAccount() {
  const keys = await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = Buffer.from(await subtle.exportKey("pkcs8", keys.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${der
    .toString("base64")
    .match(/.{1,64}/g)
    .join("\n")}\n-----END PRIVATE KEY-----\n`;
  return {
    publicKey: keys.publicKey,
    json: {
      type: "service_account",
      project_id: "app-release-center",
      client_email: "firebase-adminsdk@app-release-center.iam.gserviceaccount.com",
      private_key: pem,
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(clearTokenCache);

describe("service account", () => {
  test("is read from JSON or from base64 of it", async () => {
    const { json } = await serviceAccount();
    const raw = JSON.stringify(json);
    const fromJson = parseServiceAccount(raw);
    expect(fromJson.projectId).toBe("app-release-center");
    expect(parseServiceAccount(Buffer.from(raw).toString("base64"))).toEqual(fromJson);
    expect(parseServiceAccount("")).toBeNull();
  });

  test("says what is missing", () => {
    expect(() => parseServiceAccount('{"project_id":"x"}')).toThrow(/client_email/);
    expect(() => parseServiceAccount("not json at all!")).toThrow(/base64/);
  });
});

describe("OAuth", () => {
  test("signs an RS256 assertion Google can verify", async () => {
    const { json, publicKey } = await serviceAccount();
    const jwt = await signJwt({ iss: "me" }, json.private_key);
    const [header, claims, signature] = jwt.split(".");
    const decode = (part) =>
      JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({ iss: "me" });
    const valid = await subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  test("exchanges the assertion once and reuses the token", async () => {
    const account = parseServiceAccount(JSON.stringify((await serviceAccount()).json));
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, { access_token: "ya29.token", expires_in: 3599 });
    };
    expect(await accessToken(account, { fetchImpl })).toBe("ya29.token");
    expect(await accessToken(account, { fetchImpl })).toBe("ya29.token");
    expect(calls).toHaveLength(1);
    const form = new URLSearchParams(calls[0].init.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(
      Buffer.from(form.get("assertion").split(".")[1], "base64url").toString(),
    );
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.iss).toBe(account.clientEmail);
  });

  test("a refused service account is a configuration error", async () => {
    const account = parseServiceAccount(JSON.stringify((await serviceAccount()).json));
    await expect(
      accessToken(account, {
        fetchImpl: async () =>
          jsonResponse(400, { error: "invalid_grant", error_description: "Invalid JWT" }),
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/Invalid JWT/) });
  });
});

describe("sending", () => {
  async function send(response) {
    const account = parseServiceAccount(JSON.stringify((await serviceAccount()).json));
    const requests = [];
    const result = await sendFcm(
      account,
      { message: { token: "t" } },
      {
        fetchImpl: async (url, init) => {
          requests.push({ url, init });
          return url.includes("oauth2")
            ? jsonResponse(200, { access_token: "ya29.token" })
            : response;
        },
      },
    );
    return { result, requests };
  }

  test("posts the message to the project with the bearer token", async () => {
    const { result, requests } = await send(jsonResponse(200, { name: "m/1" }));
    expect(result).toEqual({ ok: true });
    const call = requests[1];
    expect(call.url).toBe(
      "https://fcm.googleapis.com/v1/projects/app-release-center/messages:send",
    );
    expect(call.init.headers.Authorization).toBe("Bearer ya29.token");
  });

  test("an uninstalled app's token is dropped, a bad message's is kept", async () => {
    const gone = await send(
      jsonResponse(404, {
        error: {
          status: "NOT_FOUND",
          message: "Requested entity was not found.",
          details: [{ errorCode: "UNREGISTERED" }],
        },
      }),
    );
    expect(gone.result.errorCode).toBe("UNREGISTERED");
    expect(isStaleFcmToken(gone.result)).toBe(true);

    const malformed = await send(
      jsonResponse(400, { error: { status: "INVALID_ARGUMENT", message: "bad" } }),
    );
    expect(isStaleFcmToken(malformed.result)).toBe(false);
  });
});

describe("release events", () => {
  const event = (overrides = {}) =>
    normalizeReleaseEvent({
      outcome: "failed",
      title: "Release lỗi · emed_plus_new",
      body: "iOS 2.1.13+32 · Build IPA lỗi",
      tag: "ios-1730",
      projectName: "emed_plus_new",
      platform: "ios",
      ...overrides,
    });

  test("go out on the outcome's own channel and sound", () => {
    const failed = releasePushMessage(event(), "token-1").message;
    expect(failed.token).toBe("token-1");
    expect(failed.notification.title).toBe("Release lỗi · emed_plus_new");
    expect(failed.android.notification.channel_id).toBe("release_failure_v3");
    expect(failed.android.notification.sound).toBe("release_failure");
    expect(failed.android.notification.tag).toBe("ios-1730");
    expect(failed.data.outcome).toBe("failed");
    // FCM rejects anything but strings in data.
    for (const value of Object.values(failed.data)) expect(typeof value).toBe("string");

    const succeeded = releasePushMessage(event({ outcome: "succeeded", tag: "" }), "t")
      .message;
    expect(succeeded.android.notification.channel_id).toBe("release_success_v3");
    expect(succeeded.android.notification.tag).toBeUndefined();
    expect(succeeded.data.tag).toBeUndefined();
  });

  test("need a known outcome and a title, and are kept short", () => {
    expect(() => event({ outcome: "maybe" })).toThrow(/outcome/);
    expect(() => event({ title: "" })).toThrow(/title/);
    expect(event({ body: "x".repeat(2000) }).body.length).toBe(600);
  });

  test("push tokens are bounded and single-line", () => {
    expect(normalizePushToken("abc:DEF_123")).toBe("abc:DEF_123");
    expect(normalizePushToken(undefined)).toBe("");
    expect(() => normalizePushToken("a b")).toThrow(/invalid/);
    expect(() => normalizePushToken("x".repeat(5000))).toThrow(/invalid/);
  });
});
