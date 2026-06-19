import { pool, Job } from "./db.js";
import { executeJob } from "./executor.js";
import { checkDeadmen, isInMaintenance, recordJobOutcome } from "./features.js";
import { computeNextRun } from "./schedule.js";

let running = false;
const claimTimeoutMinutes = 10;

export async function runJobNow(job: Job, options: { preserveSchedule?: boolean } = {}) {
  const startedAt = new Date();
  const retryCount = typeof job.config.retryCount === "number" ? Math.max(0, Math.min(5, job.config.retryCount)) : 0;
  const retryDelaySeconds = typeof job.config.retryDelaySeconds === "number" ? Math.max(1, Math.min(300, job.config.retryDelaySeconds)) : 10;
  let result = await executeJob(job);
  let attempts = 1;

  while (result.status === "failure" && attempts <= retryCount) {
    await new Promise((resolve) => setTimeout(resolve, retryDelaySeconds * 1000));
    result = await executeJob(job);
    attempts += 1;
  }

  const finishedAt = new Date();

  await pool.query(
    `INSERT INTO job_runs (job_id, status, started_at, finished_at, message, output)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.id, result.status, startedAt, finishedAt, result.message, { ...result.output, attempts }],
  );

  await recordJobOutcome(job, { ...result, output: { ...result.output, attempts } });

  const nextRunAt = options.preserveSchedule
    ? job.next_run_at
    : job.schedule_type === "once"
      ? null
      : computeNextRun({
          scheduleType: "cron",
          cronExpression: job.cron_expression,
          timezone: job.timezone,
          from: finishedAt,
          enabled: job.enabled,
        });

  await pool.query(
    `UPDATE jobs
     SET last_run_at = $1,
         next_run_at = $2,
         enabled = CASE WHEN $4::boolean = false AND schedule_type = 'once' THEN false ELSE enabled END,
         config = config - 'workerClaimedAt',
         updated_at = now()
     WHERE id = $3`,
    [finishedAt, nextRunAt, job.id, options.preserveSchedule === true],
  );

  return result;
}

async function tick() {
  if (running) return;
  running = true;

  try {
    await pool.query(
      `UPDATE jobs
       SET next_run_at = now(),
           config = config - 'workerClaimedAt',
           updated_at = now()
       WHERE enabled = true
         AND next_run_at IS NULL
         AND config ? 'workerClaimedAt'
         AND (config->>'workerClaimedAt')::timestamptz < now() - ($1::int * interval '1 minute')`,
      [claimTimeoutMinutes],
    );

    const result = await pool.query<Job>(
      `UPDATE jobs
       SET next_run_at = NULL,
           config = config || jsonb_build_object('workerClaimedAt', now())
       WHERE id IN (
         SELECT id FROM jobs
         WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= now()
         ORDER BY next_run_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
    );

    for (const job of result.rows) {
      if (await isInMaintenance(job)) {
        const nextRunAt =
          job.schedule_type === "once"
            ? job.run_at
            : computeNextRun({
                scheduleType: "cron",
                cronExpression: job.cron_expression,
                timezone: job.timezone,
                from: new Date(),
                enabled: job.enabled,
              });
        await pool.query("UPDATE jobs SET next_run_at = $1, updated_at = now() WHERE id = $2", [nextRunAt, job.id]);
        continue;
      }
      await runJobNow(job);
    }

    await checkDeadmen();
  } finally {
    running = false;
  }
}

export function startWorker() {
  setInterval(() => {
    tick().catch((error) => console.error("worker tick failed", error));
  }, 5000);

  tick().catch((error) => console.error("worker initial tick failed", error));
}
