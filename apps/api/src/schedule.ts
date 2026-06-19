import parser from "cron-parser";

export function computeNextRun(input: {
  scheduleType: "cron" | "once";
  cronExpression?: string | null;
  runAt?: string | Date | null;
  timezone?: string;
  from?: Date;
  enabled?: boolean;
}): Date | null {
  if (input.enabled === false) {
    return null;
  }

  if (input.scheduleType === "once") {
    if (!input.runAt) return null;
    const runAt = new Date(input.runAt);
    return Number.isNaN(runAt.getTime()) || runAt <= (input.from ?? new Date()) ? null : runAt;
  }

  if (!input.cronExpression) {
    return null;
  }

  const interval = parser.parseExpression(input.cronExpression, {
    currentDate: input.from ?? new Date(),
    tz: input.timezone ?? "Europe/Paris",
  });

  return interval.next().toDate();
}
