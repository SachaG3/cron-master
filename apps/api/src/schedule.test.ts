import assert from "node:assert/strict";
import test from "node:test";
import { computeNextRun } from "./schedule.js";

test("computeNextRun returns null for disabled jobs", () => {
  const next = computeNextRun({
    scheduleType: "cron",
    cronExpression: "*/5 * * * *",
    enabled: false,
    from: new Date("2026-06-19T10:02:00.000Z"),
  });

  assert.equal(next, null);
});

test("computeNextRun returns a future one-shot date", () => {
  const next = computeNextRun({
    scheduleType: "once",
    runAt: "2026-06-19T11:00:00.000Z",
    from: new Date("2026-06-19T10:00:00.000Z"),
  });

  assert.equal(next?.toISOString(), "2026-06-19T11:00:00.000Z");
});

test("computeNextRun ignores past one-shot dates", () => {
  const next = computeNextRun({
    scheduleType: "once",
    runAt: "2026-06-19T09:00:00.000Z",
    from: new Date("2026-06-19T10:00:00.000Z"),
  });

  assert.equal(next, null);
});

test("computeNextRun computes the next cron occurrence", () => {
  const next = computeNextRun({
    scheduleType: "cron",
    cronExpression: "*/5 * * * *",
    timezone: "UTC",
    from: new Date("2026-06-19T10:02:00.000Z"),
  });

  assert.equal(next?.toISOString(), "2026-06-19T10:05:00.000Z");
});
