import { z } from "zod";
import parser from "cron-parser";
import { pool, Job } from "./db.js";
import { computeNextRun } from "./schedule.js";

const blockSchema = z.discriminatedUnion("kind", [
  z.object({ id: z.string().optional(), kind: z.literal("notify"), message: z.string().optional() }),
  z.object({ id: z.string().optional(), kind: z.literal("http"), url: z.string().url(), expectedStatus: z.number().int().min(100).max(599).optional(), maxResponseMs: z.number().int().min(1).max(120_000).optional() }),
  z.object({ id: z.string().optional(), kind: z.literal("tcp"), host: z.string().min(1), port: z.number().int().min(1).max(65_535) }),
  z.object({ id: z.string().optional(), kind: z.literal("wait"), seconds: z.number().min(0).max(30).optional() }),
  z.object({ id: z.string().optional(), kind: z.literal("webhook"), url: z.string().url(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(), body: z.string().optional() }),
  z.object({ id: z.string().optional(), kind: z.literal("condition"), field: z.string().optional(), operator: z.enum(["=", "!=", ">", "<", "contains"]).optional(), value: z.string().optional(), message: z.string().optional() }),
]);

function validateConfig(input: { type: string; config: Record<string, unknown> }, ctx: z.RefinementCtx) {
  const config = input.config;
  const addIssue = (path: Array<string | number>, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["config", ...path], message });

  if (input.type === "website_check") {
    const parsed = z.object({
      url: z.string().url(),
      expectedStatus: z.number().int().min(100).max(599).optional(),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).passthrough().safeParse(config);
    if (!parsed.success) parsed.error.issues.forEach((issue) => addIssue(issue.path, issue.message));
  }

  if (input.type === "machine_check") {
    const parsed = z.object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535).optional(),
      timeoutMs: z.number().int().min(100).max(120_000).optional(),
    }).passthrough().safeParse(config);
    if (!parsed.success) parsed.error.issues.forEach((issue) => addIssue(issue.path, issue.message));
  }

  if (input.type === "network_monitor") {
    const hasTargets =
      Array.isArray(config.targets) &&
      config.targets.some((target) => Boolean(target && typeof target === "object" && "host" in target && typeof target.host === "string" && target.host.trim()));
    const hasHosts = typeof config.hosts === "string" && config.hosts.trim().length > 0;
    if (!hasTargets && !hasHosts) addIssue(["targets"], "Au moins une cible reseau est requise");
  }

  if (input.type === "script") {
    if (Array.isArray(config.blocks)) {
      const parsed = z.array(blockSchema).min(1).safeParse(config.blocks);
      if (!parsed.success) parsed.error.issues.forEach((issue) => addIssue(["blocks", ...issue.path], issue.message));
    } else if (typeof config.script !== "string" || !config.script.trim()) {
      addIssue(["script"], "Un script texte ou au moins un bloc est requis");
    }
  }
}

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
}).superRefine((input, ctx) => {
  if (input.scheduleType === "cron" && !input.cronExpression) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Expression cron requise" });
  } else if (input.scheduleType === "cron" && input.cronExpression) {
    try {
      parser.parseExpression(input.cronExpression, { tz: input.timezone });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cronExpression"], message: "Expression cron invalide" });
    }
  }
  if (input.scheduleType === "once") {
    const timestamp = input.runAt ? new Date(input.runAt).getTime() : NaN;
    if (Number.isNaN(timestamp)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runAt"], message: "Date d'execution invalide" });
    }
  }
  validateConfig(input, ctx);
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
