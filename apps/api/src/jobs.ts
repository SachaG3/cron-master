import { z } from "zod";
import { pool, Job } from "./db.js";
import { computeNextRun } from "./schedule.js";

export const jobInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  type: z.enum(["notification", "date_reminder", "website_check", "machine_check", "network_monitor", "script"]),
  scheduleType: z.enum(["cron", "once"]),
  cronExpression: z.string().optional().nullable(),
  runAt: z.string().optional().nullable(),
  timezone: z.string().optional().default("Europe/Paris"),
  enabled: z.boolean().optional().default(true),
  config: z.record(z.unknown()).optional().default({}),
});

export type JobInput = z.infer<typeof jobInputSchema>;

export async function listJobs() {
  const result = await pool.query<Job>("SELECT * FROM jobs ORDER BY created_at DESC");
  return result.rows;
}

export async function getJob(id: string) {
  const result = await pool.query<Job>("SELECT * FROM jobs WHERE id = $1", [id]);
  return result.rows[0] ?? null;
}

export async function createJob(input: JobInput) {
  const nextRunAt = computeNextRun({
    scheduleType: input.scheduleType,
    cronExpression: input.cronExpression,
    runAt: input.runAt,
    timezone: input.timezone,
    enabled: input.enabled,
  });

  const result = await pool.query<Job>(
    `INSERT INTO jobs
      (name, description, type, schedule_type, cron_expression, run_at, timezone, enabled, config, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.name,
      input.description,
      input.type,
      input.scheduleType,
      input.cronExpression || null,
      input.runAt || null,
      input.timezone,
      input.enabled,
      input.config,
      nextRunAt,
    ],
  );

  return result.rows[0];
}

export async function updateJob(id: string, input: JobInput) {
  const nextRunAt = computeNextRun({
    scheduleType: input.scheduleType,
    cronExpression: input.cronExpression,
    runAt: input.runAt,
    timezone: input.timezone,
    enabled: input.enabled,
  });

  const result = await pool.query<Job>(
    `UPDATE jobs SET
      name = $1,
      description = $2,
      type = $3,
      schedule_type = $4,
      cron_expression = $5,
      run_at = $6,
      timezone = $7,
      enabled = $8,
      config = $9,
      next_run_at = $10,
      updated_at = now()
     WHERE id = $11
     RETURNING *`,
    [
      input.name,
      input.description,
      input.type,
      input.scheduleType,
      input.cronExpression || null,
      input.runAt || null,
      input.timezone,
      input.enabled,
      input.config,
      nextRunAt,
      id,
    ],
  );

  return result.rows[0] ?? null;
}

export async function deleteJob(id: string) {
  await pool.query("DELETE FROM jobs WHERE id = $1", [id]);
}

export async function setJobEnabled(id: string, enabled: boolean) {
  const current = await getJob(id);
  if (!current) return null;
  const nextRunAt = computeNextRun({
    scheduleType: current.schedule_type,
    cronExpression: current.cron_expression,
    runAt: current.run_at?.toISOString(),
    timezone: current.timezone,
    enabled,
  });
  const result = await pool.query<Job>(
    "UPDATE jobs SET enabled = $1, next_run_at = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [enabled, nextRunAt, id],
  );
  return result.rows[0] ?? null;
}

export async function duplicateJob(id: string) {
  const current = await getJob(id);
  if (!current) return null;
  return await createJob({
    name: `${current.name} copie`,
    description: current.description,
    type: current.type,
    scheduleType: current.schedule_type,
    cronExpression: current.cron_expression,
    runAt: current.run_at?.toISOString(),
    timezone: current.timezone,
    enabled: false,
    config: {
      ...current.config,
      networkStatus: undefined,
      outageStartedAt: undefined,
      lastCheckedAt: undefined,
      lastRecoveryDurationMs: undefined,
      lastNetworkResults: undefined,
      networkConsecutiveFailures: undefined,
      networkConsecutiveSuccesses: undefined,
      networkLastNotificationAt: undefined,
    },
  });
}

export async function listRuns(jobId?: string) {
  const result = jobId
    ? await pool.query("SELECT * FROM job_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 100", [jobId])
    : await pool.query("SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 100");
  return result.rows;
}
