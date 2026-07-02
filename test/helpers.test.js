const {
  buildCommandPayload,
  commandRunFromEvent,
  commandRunSignature,
  durationLabel,
  humanizeCommandLabel,
  isExpiredIso,
  normalizeLogTail,
  shouldDisableSubscription,
} = require("../src/helpers");

test("builds completed command payload", () => {
  const payload = buildCommandPayload({
    event: "completed",
    runId: "run-1",
    command: "fastlane android deploy",
      statusLabel: "deploy_android.sh",
      projectName: "Demo",
      durationMs: 5000,
      exitCode: 0,
    });

  expect(payload.title).toBe("Completed: Deploy Android");
  expect(payload.body).toBe("Demo - Exit 0 - 5s");
  expect(payload.renotify).toBe(true);
  expect(payload.data.runId).toBe("run-1");
  expect(payload.data.commandLabel).toBe("Deploy Android");
});

test("humanizes command labels", () => {
  expect(humanizeCommandLabel("deploy_android")).toBe("Deploy Android");
  expect(humanizeCommandLabel("deploy-android")).toBe("Deploy Android");
  expect(humanizeCommandLabel("deploy_android.sh")).toBe("Deploy Android");
  expect(humanizeCommandLabel("bundle_update_fastlane")).toBe(
    "Bundle Update Fastlane",
  );
  expect(humanizeCommandLabel("git pull origin/main")).toBe(
    "Git Pull Origin Main",
  );
});

test("builds signed command run detail metadata", () => {
  const run = commandRunFromEvent(
    {
      event: "failed",
      runId: "run-1",
      command: "fastlane android deploy",
      statusLabel: "deploy",
      projectName: "Demo",
      startedAt: "2026-07-01T00:00:00.000Z",
      finishedAt: "2026-07-01T00:00:05.000Z",
      durationMs: 5000,
      exitCode: 1,
      logTail: ["one", "two"],
    },
    ["phone-1"],
  );

  expect(run.status).toBe("failed");
  expect(run.displayCommandLabel).toBe("Deploy");
  expect(run.targetDeviceIds).toEqual(["phone-1"]);
  expect(commandRunSignature("secret", "run-1", "phone-1")).toHaveLength(64);
});

test("formats duration and bounds log tails", () => {
  expect(durationLabel(400)).toBe("<1s");
  expect(durationLabel(2500)).toBe("3s");
  expect(durationLabel(125000)).toBe("2m 05s");
  expect(normalizeLogTail(Array.from({ length: 25 }, (_, index) => `line ${index}`))).toHaveLength(20);
});

test("detects expired pairing times", () => {
  expect(isExpiredIso("2026-07-01T00:00:00Z", Date.parse("2026-07-01T00:00:01Z"))).toBe(true);
  expect(isExpiredIso("2026-07-01T00:00:00Z", Date.parse("2026-06-30T23:59:59Z"))).toBe(false);
});

test("disables gone push subscriptions", () => {
  expect(shouldDisableSubscription({ statusCode: 410 })).toBe(true);
  expect(shouldDisableSubscription({ statusCode: 500 })).toBe(false);
});
