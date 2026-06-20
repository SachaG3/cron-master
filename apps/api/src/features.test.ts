import assert from "node:assert/strict";
import test from "node:test";
import { shouldNotifyDeadmanMissing } from "./features.js";

test("shouldNotifyDeadmanMissing notifies on the first missing transition", () => {
  assert.equal(
    shouldNotifyDeadmanMissing({
      wasMissing: false,
      notifyOnMissing: true,
      reminderMinutes: 0,
      now: new Date("2026-06-21T10:00:00.000Z"),
    }),
    true,
  );
});

test("shouldNotifyDeadmanMissing suppresses repeated alerts without reminders", () => {
  assert.equal(
    shouldNotifyDeadmanMissing({
      wasMissing: true,
      notifyOnMissing: true,
      reminderMinutes: 0,
      lastNotificationAt: new Date("2026-06-21T09:00:00.000Z"),
      now: new Date("2026-06-21T10:00:00.000Z"),
    }),
    false,
  );
});

test("shouldNotifyDeadmanMissing respects reminder intervals", () => {
  assert.equal(
    shouldNotifyDeadmanMissing({
      wasMissing: true,
      notifyOnMissing: true,
      reminderMinutes: 30,
      lastNotificationAt: new Date("2026-06-21T09:20:00.000Z"),
      now: new Date("2026-06-21T10:00:00.000Z"),
    }),
    true,
  );
});
