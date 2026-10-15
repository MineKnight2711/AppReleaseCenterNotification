const {
  DEFAULT_DESKTOP_ID,
  commandResult,
  configureWebPush,
  preferredDesktop,
  desktopStateJson,
  normalizeRemoteCommand,
  remoteCommandJson,
  sendToDevices,
  waitForQueuedCommands,
} = require("../src/relay_core");

// These rules used to be checked through the Express host's HTTP surface.
// That host is gone, so they are checked here instead — which is where they
// live, and which keeps them honest for whatever host comes next.

function device(scopes) {
  return { id: "device-1", scopes };
}

function expectRejected(fn, statusCode, fragment) {
  expect(fn).toThrow();
  try {
    fn();
  } catch (error) {
    expect(error.statusCode).toBe(statusCode);
    if (fragment) expect(error.message).toContain(fragment);
  }
}

const now = "2026-09-21T00:00:00.000Z";

describe("command scopes", () => {
  test("a run device may send release work", () => {
    const command = normalizeRemoteCommand(
      { type: "shell", payload: { command: "Get-Date" } },
      device(["run"]),
      now,
    );
    expect(command.lane).toBe("release");
    expect(command.status).toBe("queued");
    expect(command.targetDesktopId).toBe(DEFAULT_DESKTOP_ID);
  });

  test("a run device may not send power commands", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "power", targetDesktopId: "pc", payload: { action: "lock" } },
          device(["run"]),
          now,
        ),
      403,
      "not allowed",
    );
  });

  test("a power device may not send release work", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "shell", payload: { command: "Get-Date" } },
          device(["power"]),
          now,
        ),
      403,
    );
  });

  test("a device recorded before scopes existed keeps run only", () => {
    const command = normalizeRemoteCommand(
      { type: "script", payload: { projectPath: "C:/p", scriptPath: "a.ps1" } },
      { id: "old-device" },
      now,
    );
    expect(command.type).toBe("script");
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "power", targetDesktopId: "pc", payload: { action: "lock" } },
          { id: "old-device" },
          now,
        ),
      403,
    );
  });
});

describe("lanes", () => {
  test("release work and machine control go to different queues", () => {
    const shell = normalizeRemoteCommand(
      { type: "shell", payload: { command: "Get-Date" } },
      device(["run"]),
      now,
    );
    const power = normalizeRemoteCommand(
      { type: "power", targetDesktopId: "pc", payload: { action: "lock" } },
      device(["power"]),
      now,
    );
    expect(shell.lane).toBe("release");
    expect(power.lane).toBe("control");
  });

  test("the lane survives the wire format", () => {
    expect(remoteCommandJson({ commandId: "c", lane: "control" }).lane).toBe(
      "control",
    );
    // Anything queued before lanes existed is release work.
    expect(remoteCommandJson({ commandId: "c" }).lane).toBe("release");
  });
});

describe("unlock commands", () => {
  test("requires its own scope and keeps only ciphertext", () => {
    const command = normalizeRemoteCommand(
      {
        type: "unlock",
        targetDesktopId: "pc",
        payload: { envelope: "Abcd_1234-xyz" },
      },
      device(["unlock"]),
      now,
    );
    expect(command.lane).toBe("control");
    expect(command.payload).toEqual({ envelope: "Abcd_1234-xyz" });
    expectRejected(
      () =>
        normalizeRemoteCommand(
          {
            type: "unlock",
            targetDesktopId: "pc",
            payload: { envelope: "Abcd_1234-xyz" },
          },
          device(["power"]),
          now,
        ),
      403,
    );
  });

  test("rejects plaintext-shaped or oversized payloads", () => {
    for (const envelope of ["password=secret", "a".repeat(2049)]) {
      expectRejected(
        () =>
          normalizeRemoteCommand(
            { type: "unlock", targetDesktopId: "pc", payload: { envelope } },
            device(["unlock"]),
            now,
          ),
        400,
      );
    }
  });
});

describe("power commands", () => {
  test("must name the desktop they are for", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "power", payload: { action: "shutdown" } },
          device(["power"]),
          now,
        ),
      400,
      "target desktop",
    );
  });

  test("release work still defaults to the single desktop", () => {
    const command = normalizeRemoteCommand(
      { type: "shell", payload: { command: "Get-Date" } },
      device(["run"]),
      now,
    );
    expect(command.targetDesktopId).toBe(DEFAULT_DESKTOP_ID);
  });

  test("accepts turning the screen off, which is not a suspend", () => {
    // The fallback where Wake-on-LAN cannot work: the machine stays awake and
    // reachable, so the phone keeps control without needing to wake anything.
    const command = normalizeRemoteCommand(
      {
        type: "power",
        targetDesktopId: "pc",
        payload: { action: "displayOff" },
      },
      device(["power"]),
      now,
    );
    expect(command.payload.action).toBe("displayOff");
    expect(command.lane).toBe("control");
  });

  test("an unknown action is refused", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "power", targetDesktopId: "pc", payload: { action: "format" } },
          device(["power"]),
          now,
        ),
      400,
      "Power action",
    );
  });

  test("the delay is clamped and force defaults to off", () => {
    const command = normalizeRemoteCommand(
      {
        type: "power",
        targetDesktopId: "pc",
        payload: { action: "shutdown", delaySeconds: 99999 },
      },
      device(["power"]),
      now,
    );
    expect(command.payload).toEqual({
      action: "shutdown",
      delaySeconds: 600,
      force: false,
    });
  });

  test("a negative delay becomes immediate", () => {
    const command = normalizeRemoteCommand(
      {
        type: "power",
        targetDesktopId: "pc",
        payload: { action: "lock", delaySeconds: -5 },
      },
      device(["power"]),
      now,
    );
    expect(command.payload.delaySeconds).toBe(0);
  });
});

describe("iOS build commands", () => {
  // A controlling desktop paired by the Mac build host "mac-mini".
  const host = (scopes = ["ios"]) => ({ id: "win", scopes, desktopId: "mac-mini" });
  const ios = (payload, targetDesktopId = "mac-mini") => ({
    type: "ios",
    targetDesktopId,
    payload,
  });

  test("a build step is release work that keeps only ciphertext", () => {
    const command = normalizeRemoteCommand(
      ios({
        action: "prepare",
        projectId: "app-1",
        envelope: "sealed_Bytes-1",
        // Anything outside the envelope is dropped, not forwarded.
        commit: "deadbeef",
        settings: { flavor: "prod" },
      }),
      host(),
      now,
    );
    expect(command.lane).toBe("release");
    expect(command.payload).toEqual({
      action: "prepare",
      runId: "",
      projectId: "app-1",
      envelope: "sealed_Bytes-1",
    });
  });

  test("history and logs are answered on the control lane", () => {
    const command = normalizeRemoteCommand(
      {
        type: "iosQuery",
        targetDesktopId: "mac-mini",
        payload: { action: "log", projectId: "app-1", runId: "1730000000" },
      },
      host(),
      now,
    );
    expect(command.lane).toBe("control");
    expect(command.payload).toEqual({
      action: "log",
      runId: "1730000000",
      projectId: "app-1",
    });
  });

  test("needs the ios scope", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          ios({ action: "prepare", projectId: "a", envelope: "x" }),
          host(["run", "power"]),
          now,
        ),
      403,
      "not allowed",
    );
  });

  test("only reaches the desktop that paired the device", () => {
    for (const device of [host(), { id: "phone", scopes: ["ios"] }]) {
      expectRejected(
        () =>
          normalizeRemoteCommand(
            ios({ action: "prepare", projectId: "a", envelope: "x" }, "other-mac"),
            device,
            now,
          ),
        403,
        "paired it",
      );
    }
  });

  test("steps after prepare must name their run", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          ios({ action: "submit", projectId: "a", envelope: "x" }),
          host(),
          now,
        ),
      400,
      "run id",
    );
    expectRejected(
      () =>
        normalizeRemoteCommand(
          ios({ action: "submit", projectId: "a", runId: "../x", envelope: "x" }),
          host(),
          now,
        ),
      400,
      "run id",
    );
  });

  test("refuses unknown actions and plaintext envelopes", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          ios({ action: "shell", projectId: "a", envelope: "x" }),
          host(),
          now,
        ),
      400,
      "iOS action",
    );
    for (const envelope of ["", "key=-----BEGIN", "a".repeat(512 * 1024 + 1)]) {
      expectRejected(
        () =>
          normalizeRemoteCommand(
            ios({ action: "prepare", projectId: "a", envelope }),
            host(),
            now,
          ),
        400,
        "envelope",
      );
    }
  });

  test("the result travels back and is size-limited", () => {
    expect(
      remoteCommandJson({ commandId: "c", result: { run: { id: "1" } } }).result,
    ).toEqual({ run: { id: "1" } });
    expect(remoteCommandJson({ commandId: "c" }).result).toEqual({});
    expect(commandResult(undefined)).toBeUndefined();
    expectRejected(() => commandResult(["a"]), 400, "object");
    expectRejected(
      () => commandResult({ log: "x".repeat(256 * 1024) }),
      400,
      "too large",
    );
  });
});

describe("the phone's desktop", () => {
  // Newest heartbeat first, the order the store lists them in.
  const desktops = [
    { desktopId: "mac-mini" },
    { desktopId: "default" },
    { desktopId: "office-pc" },
  ];

  test("is the one that paired it", () => {
    expect(
      preferredDesktop(desktops, { desktopId: "office-pc" }).desktopId,
    ).toBe("office-pc");
  });

  test("is the default desktop for a phone paired before that was recorded", () => {
    // Not the build host that happened to report last.
    expect(preferredDesktop(desktops, { id: "old-phone" }).desktopId).toBe(
      "default",
    );
  });

  test("falls back to the latest report, or nothing", () => {
    expect(
      preferredDesktop([{ desktopId: "solo" }], { desktopId: "gone" }).desktopId,
    ).toBe("solo");
    expect(preferredDesktop([], {})).toBeNull();
  });
});

describe("release commands from the phone", () => {
  const release = (payload) =>
    normalizeRemoteCommand(
      { type: "release", targetDesktopId: "pc", payload },
      device(["run"]),
      now,
    );

  test("prepare a CH Play release on a known track", () => {
    const command = release({
      platform: "android",
      action: "prepare",
      projectPath: "C:/Work/emed",
      track: "Production",
      shell: "rm -rf /",
    });
    expect(command.lane).toBe("release");
    expect(command.payload).toEqual({
      platform: "android",
      action: "prepare",
      projectPath: "C:/Work/emed",
      track: "production",
    });
    expectRejected(
      () => release({ platform: "android", action: "prepare", projectPath: "x", track: "nightly" }),
      400,
      "Track",
    );
  });

  test("production needs the phone to say so", () => {
    expect(release({ platform: "android", action: "start" }).payload).toEqual({
      platform: "android",
      action: "start",
      confirmProduction: false,
    });
    expect(
      release({ platform: "android", action: "start", confirmProduction: true })
        .payload.confirmProduction,
    ).toBe(true);
  });

  test("iOS steps name the project and, after prepare, the run", () => {
    expect(
      release({
        platform: "ios",
        action: "prepare",
        projectId: "app",
        version: "2.1.13",
        notes: "Sửa lỗi",
        existingBuild: { id: "b1", version: "2.1.13", number: 32, state: "VALID", extra: "x" },
      }).payload,
    ).toEqual({
      platform: "ios",
      action: "prepare",
      projectId: "app",
      version: "2.1.13",
      notes: "Sửa lỗi",
      existingBuild: { id: "b1", version: "2.1.13", number: "32", state: "VALID" },
    });
    expectRejected(
      () => release({ platform: "ios", action: "submit", projectId: "app" }),
      400,
      "run id",
    );
    expect(
      release({ platform: "ios", action: "submit", projectId: "app", runId: "17" })
        .payload.runId,
    ).toBe("17");
  });

  test("only the dialog's own buttons are accepted", () => {
    expectRejected(() => release({ platform: "android", action: "shell" }), 400, "Release action");
    expectRejected(() => release({ platform: "web", action: "prepare" }), 400, "platform");
  });

  test("overview and stop travel on the control lane", () => {
    const stop = normalizeRemoteCommand(
      { type: "releaseControl", targetDesktopId: "pc", payload: { action: "cancel", platform: "ios", projectId: "app" } },
      device(["run"]),
      now,
    );
    expect(stop.lane).toBe("control");
    expect(stop.payload).toEqual({ action: "cancel", platform: "ios", projectId: "app" });
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "releaseControl", targetDesktopId: "pc", payload: { action: "cancel" } },
          device(["run"]),
          now,
        ),
      400,
      "platform",
    );
  });

  test("must name the desktop and need the run scope", () => {
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "release", payload: { platform: "android", action: "retry" } },
          device(["run"]),
          now,
        ),
      400,
      "target desktop",
    );
    expectRejected(
      () =>
        normalizeRemoteCommand(
          { type: "release", targetDesktopId: "pc", payload: { platform: "android", action: "retry" } },
          device(["power"]),
          now,
        ),
      403,
    );
  });
});

describe("accepted types", () => {
  test("window and app are not live yet", () => {
    for (const type of ["window", "app"]) {
      expectRejected(
        () =>
          normalizeRemoteCommand(
            { type, targetDesktopId: "pc", payload: { action: "list" } },
            device(["run", "power", "window"]),
            now,
          ),
        400,
        "Command type",
      );
    }
  });

  test("nonsense is refused", () => {
    expectRejected(
      () => normalizeRemoteCommand({ type: "rm -rf" }, device(["run"]), now),
      400,
    );
  });
});

describe("desktop state", () => {
  test("a recent heartbeat reads as online", () => {
    const json = desktopStateJson({
      desktopId: "pc",
      displayName: "PC",
      lastSeenAt: new Date().toISOString(),
      state: { sessionLocked: true },
    });
    expect(json.online).toBe(true);
    expect(json.state.sessionLocked).toBe(true);
  });

  test("a stale heartbeat reads as offline but keeps its state", () => {
    const json = desktopStateJson({
      desktopId: "pc",
      lastSeenAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      // The phone needs this precisely when the machine has gone quiet.
      state: { wake: { macAddress: "84:9E:56:EA:B7:F1" } },
    });
    expect(json.online).toBe(false);
    expect(json.state.wake.macAddress).toBe("84:9E:56:EA:B7:F1");
  });
});

describe("queue waiting", () => {
  function storeReturning(sequence) {
    let call = 0;
    return {
      listRemoteCommands: async () => sequence[Math.min(call++, sequence.length - 1)],
    };
  }

  test("returns as soon as something is queued", async () => {
    const store = storeReturning([[], [{ commandId: "c1" }]]);
    const started = Date.now();
    const commands = await waitForQueuedCommands(store, "pc", 5000, "control");
    expect(commands).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("gives up at the deadline with nothing", async () => {
    const store = storeReturning([[]]);
    const commands = await waitForQueuedCommands(store, "pc", 150, "control");
    expect(commands).toEqual([]);
  });
});

describe("push delivery", () => {
  const vapid = {
    VAPID_PUBLIC_KEY: "public",
    VAPID_PRIVATE_KEY: "private",
    VAPID_SUBJECT: "mailto:test@example.com",
  };

  function pushStore(subscription) {
    return {
      subscription,
      disabled: [],
      touched: [],
      async getSubscription() {
        return this.subscription;
      },
      async touchSubscription(id) {
        this.touched.push(id);
      },
      async disableSubscription(id) {
        this.disabled.push(id);
      },
    };
  }

  test("a subscription the push service has forgotten is retired", async () => {
    const store = pushStore({ enabled: true, subscription: { endpoint: "e" } });
    const pushClient = {
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn().mockRejectedValue({ statusCode: 410 }),
    };

    const result = await sendToDevices({
      config: vapid,
      store,
      pushClient,
      targetDeviceIds: ["device-1"],
      payload: { title: "x" },
    });

    expect(result).toEqual({ sent: 0, failed: 1, disabled: 1 });
    expect(store.disabled).toEqual(["device-1"]);
  });

  test("an ordinary failure does not retire the subscription", async () => {
    const store = pushStore({ enabled: true, subscription: { endpoint: "e" } });
    const pushClient = {
      setVapidDetails: jest.fn(),
      sendNotification: jest.fn().mockRejectedValue({ statusCode: 500 }),
    };

    const result = await sendToDevices({
      config: vapid,
      store,
      pushClient,
      targetDeviceIds: ["device-1"],
      payload: { title: "x" },
    });

    expect(result.disabled).toBe(0);
    expect(store.disabled).toEqual([]);
  });

  test("missing VAPID keys fail loudly rather than silently", () => {
    expect(() => configureWebPush({}, { setVapidDetails: () => {} })).toThrow(
      /VAPID_PUBLIC_KEY/,
    );
    expect(() =>
      configureWebPush({ VAPID_PUBLIC_KEY: "public" }, { setVapidDetails: () => {} }),
    ).toThrow(/VAPID_PRIVATE_KEY/);
  });

  test("a key the push client rejects is reported as configuration", () => {
    expect(() =>
      configureWebPush(vapid, {
        setVapidDetails: () => {
          throw new Error("bad key");
        },
      }),
    ).toThrow(/VAPID configuration is invalid/);
  });

  test("sending to nobody is a bad request", async () => {
    await expect(
      sendToDevices({
        config: vapid,
        store: pushStore(null),
        pushClient: { setVapidDetails: jest.fn(), sendNotification: jest.fn() },
        targetDeviceIds: [],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
