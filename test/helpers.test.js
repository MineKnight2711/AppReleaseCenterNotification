const {
  buildCommandPayload,
  isExpiredIso,
  shouldDisableSubscription,
} = require("../src/helpers");

test("builds completed command payload", () => {
  const payload = buildCommandPayload({
    event: "completed",
    runId: "run-1",
    command: "fastlane android deploy",
    statusLabel: "deploy",
    projectName: "Demo",
    exitCode: 0,
  });

  expect(payload.title).toBe("Release command completed");
  expect(payload.body).toBe("Demo - deploy - finished with exit 0");
  expect(payload.data.runId).toBe("run-1");
});

test("detects expired pairing times", () => {
  expect(isExpiredIso("2026-07-01T00:00:00Z", Date.parse("2026-07-01T00:00:01Z"))).toBe(true);
  expect(isExpiredIso("2026-07-01T00:00:00Z", Date.parse("2026-06-30T23:59:59Z"))).toBe(false);
});

test("disables gone push subscriptions", () => {
  expect(shouldDisableSubscription({ statusCode: 410 })).toBe(true);
  expect(shouldDisableSubscription({ statusCode: 500 })).toBe(false);
});
