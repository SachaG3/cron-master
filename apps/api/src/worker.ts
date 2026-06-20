import { pool, Job } from "./db.js";
import { executeJob } from "./executor.js";
import { checkDeadmen, isInMaintenance, recordJobOutcome } from "./features.js";
import { clearWorkerClaim, mergeRuntimeState } from "./runtimeState.js";
import { computeNextRun } from "./schedule.js";

let running = false;
const claimTimeoutMinutes = 10;

export async function runJobNow(job: Job, options: { preserveSchedule?: boolean } = {}) {
  const executableJob = await mergeRuntimeState(job);
  const startedAt = new Date();
  const retryCount = typeof executableJob.config.retryCount === "number" ? Math.max(0, Math.min(5, executableJob.config.retryCount)) : 0;
  const retryDelaySeconds = typeof executableJob.config.retryDelaySeconds === "number" ? Math.max(1, Math.min(300, executableJob.config.retryDelaySeconds)) : 10;
  let result = await executeJob(executableJob);
  let attempts = 1;

  while (result.status === "failure" && attempts <= retryCount) {
    await new Promise((resolve) => setTimeout(resolve, retryDelaySeconds * 1000));
    result = await executeJob(await mergeRuntimeState(job));
    attempts += 1;
  }

  const finishedAt = new Date();

  await pool.query(
    `INSERT INTO job_runs (job_id, status, started_at, finished_at, message, output)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [job.id, result.status, startedAt, finishedAt, result.message, { ...result.output, attempts }],
  );

  await recordJobOutcome(executableJob, { ...result, output: { ...result.output, attempts } });

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
         updated_at = now()
     WHERE id = $3`,
    [finishedAt, nextRunAt, job.id, options.preserveSchedule === true],
  );
  await clearWorkerClaim(job.id);

  return result;
}

async function tick() {
  if (running) return;
  running = true;

  try {
    await pool.query(
      `UPDATE jobs j
       SET next_run_at = now(),
           updated_at = now()
       FROM job_runtime_state s
       WHERE j.id = s.job_id
         AND j.enabled = true
         AND j.next_run_at IS NULL
         AND s.worker_claimed_at IS NOT NULL
         AND s.worker_claimed_at < now() - ($1::int * interval '1 minute')`,
      [claimTimeoutMinutes],
    );
    await pool.query(
      `UPDATE job_runtime_state
       SET worker_claimed_at = NULL,
           updated_at = now()
       WHERE worker_claimed_at IS NOT NULL
         AND worker_claimed_at < now() - ($1::int * interval '1 minute')`,
      [claimTimeoutMinutes],
    );

    const result = await pool.query<Job>(
       `WITH due AS (
         SELECT j.id
         FROM jobs j
         WHERE j.enabled = true
           AND j.next_run_at IS NOT NULL
           AND j.next_run_at <= now()
           AND NOT EXISTS (
             SELECT 1
             FROM job_runtime_state s
             WHERE s.job_id = j.id
               AND s.worker_claimed_at IS NOT NULL
           )
         ORDER BY j.next_run_at ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED
       ),
       claims AS (
         INSERT INTO job_runtime_state (job_id, worker_claimed_at, updated_at)
         SELECT id, now(), now() FROM due
         ON CONFLICT (job_id) DO UPDATE
           SET worker_claimed_at = EXCLUDED.worker_claimed_at,
               updated_at = now()
         RETURNING job_id
       )
       UPDATE jobs j
       SET next_run_at = NULL,
           updated_at = now()
       WHERE j.id IN (SELECT job_id FROM claims)
       RETURNING j.*`,
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
        await clearWorkerClaim(job.id);
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
