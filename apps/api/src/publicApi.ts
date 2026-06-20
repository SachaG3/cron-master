import { Request, Router } from "express";
import { z } from "zod";
import { requirePublicApiToken } from "./apiTokens.js";
import { executeJob } from "./executor.js";
import { createDeadman, getDashboard, getPublicStatus, pingDeadman, templates } from "./features.js";
import { buildTransientJob, createJob, deleteJob, duplicateJob, getJob, getRunStats, jobInputSchema, listJobs, listRuns, setJobEnabled, updateJob } from "./jobs.js";
import { openApiDocument } from "./openapi.js";
import { runJobNow } from "./worker.js";
import { verifyWebhookSignature } from "./webhookSecurity.js";

const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("every_minutes"), value: z.number().min(1).max(59) }),
  z.object({ mode: z.literal("hourly"), value: z.number().min(1).max(23).default(1) }),
  z.object({ mode: z.literal("daily"), time: z.string().regex(/^\d{2}:\d{2}$/).default("09:00") }),
  z.object({ mode: z.literal("weekly"), weekday: z.number().min(0).max(6).default(1), time: z.string().regex(/^\d{2}:\d{2}$/).default("09:00") }),
  z.object({ mode: z.literal("monthly"), day: z.number().min(1).max(28).default(1), time: z.string().regex(/^\d{2}:\d{2}$/).default("09:00") }),
  z.object({ mode: z.literal("once"), runAt: z.string() }),
  z.object({ mode: z.literal("cron"), expression: z.string().min(3) }),
]);

const publicJobSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  type: z.enum(["notification", "date_reminder", "website_check", "machine_check", "network_monitor", "script"]),
  schedule: scheduleSchema,
  timezone: z.string().optional().default("Europe/Paris"),
  enabled: z.boolean().optional().default(true),
  config: z.record(z.unknown()).optional().default({}),
});

function toCron(input: z.infer<typeof scheduleSchema>) {
  if (input.mode === "once") return { scheduleType: "once" as const, cronExpression: null, runAt: input.runAt, label: `Une fois ${input.runAt}` };
  if (input.mode === "cron") return { scheduleType: "cron" as const, cronExpression: input.expression, runAt: null, label: "Cron custom" };
  if (input.mode === "every_minutes") return { scheduleType: "cron" as const, cronExpression: `*/${input.value} * * * *`, runAt: null, label: `Toutes les ${input.value} minutes` };
  if (input.mode === "hourly") return { scheduleType: "cron" as const, cronExpression: `0 */${input.value} * * *`, runAt: null, label: `Toutes les ${input.value} heures` };

  const [hour, minute] = input.time.split(":").map(Number);
  if (input.mode === "daily") return { scheduleType: "cron" as const, cronExpression: `${minute} ${hour} * * *`, runAt: null, label: `Tous les jours à ${input.time}` };
  if (input.mode === "weekly") return { scheduleType: "cron" as const, cronExpression: `${minute} ${hour} * * ${input.weekday}`, runAt: null, label: `Chaque semaine à ${input.time}` };
  return { scheduleType: "cron" as const, cronExpression: `${minute} ${hour} ${input.day} * *`, runAt: null, label: `Chaque mois à ${input.time}` };
}

function paginationFromQuery(req: Request) {
  return {
    limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
    offset: typeof req.query.offset === "string" ? Number(req.query.offset) : undefined,
  };
}

function toJobInput(input: z.infer<typeof publicJobSchema>) {
  const schedule = toCron(input.schedule);
  const scheduleLabel = typeof input.config.scheduleLabel === "string" ? input.config.scheduleLabel : schedule.label;
  return jobInputSchema.parse({
    name: input.name,
    description: input.description,
    type: input.type,
    scheduleType: schedule.scheduleType,
    cronExpression: schedule.cronExpression,
    runAt: schedule.runAt,
    timezone: input.timezone,
    enabled: input.enabled,
    config: { ...input.config, scheduleLabel },
  });
}

export const publicApiRouter = Router();

publicApiRouter.get("/health", requirePublicApiToken(), (_req, res) => {
  res.json({ ok: true, version: "v1" });
});

publicApiRouter.get("/openapi.json", requirePublicApiToken(), (_req, res) => {
  res.json(openApiDocument);
});

publicApiRouter.get("/dashboard", requirePublicApiToken(["status:read"]), async (_req, res, next) => {
  try {
    res.json(await getDashboard());
  } catch (error) {
    next(error);
  }
});

publicApiRouter.get("/stats/runs", requirePublicApiToken(["status:read"]), async (req, res, next) => {
  try {
    const days = typeof req.query.days === "string" ? Number(req.query.days) : undefined;
    res.json(await getRunStats(days));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.get("/status", requirePublicApiToken(["status:read"]), async (_req, res, next) => {
  try {
    res.json(await getPublicStatus());
  } catch (error) {
    next(error);
  }
});

publicApiRouter.get("/templates", requirePublicApiToken(["jobs:read"]), (_req, res) => {
  res.json(templates);
});

publicApiRouter.get("/jobs", requirePublicApiToken(["jobs:read"]), async (req, res, next) => {
  try {
    res.json(await listJobs(paginationFromQuery(req)));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs", requirePublicApiToken(["jobs:write"]), async (req, res, next) => {
  try {
    const input = publicJobSchema.parse(req.body);
    const job = await createJob(toJobInput(input));
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs/test", requirePublicApiToken(["jobs:run"]), async (req, res, next) => {
  try {
    const input = publicJobSchema.parse(req.body);
    res.json(await executeJob(buildTransientJob(toJobInput(input))));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.get("/jobs/:id", requirePublicApiToken(["jobs:read"]), async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

publicApiRouter.put("/jobs/:id", requirePublicApiToken(["jobs:write"]), async (req, res, next) => {
  try {
    const input = publicJobSchema.parse(req.body);
    const job = await updateJob(req.params.id, toJobInput(input));
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

publicApiRouter.delete("/jobs/:id", requirePublicApiToken(["jobs:write"]), async (req, res, next) => {
  try {
    await deleteJob(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs/:id/duplicate", requirePublicApiToken(["jobs:write"]), async (req, res, next) => {
  try {
    const job = await duplicateJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs/:id/pause", requirePublicApiToken(["jobs:write"]), async (req, res, next) => {
  try {
    const job = await setJobEnabled(req.params.id, false);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs/:id/resume", requirePublicApiToken(["jobs:write"]), async (req, res, next) => {
  try {
    const job = await setJobEnabled(req.params.id, true);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs/:id/run", requirePublicApiToken(["jobs:run"]), async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(await runJobNow({ ...job, config: { ...job.config, apiPayload: req.body } }, { preserveSchedule: true }));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/jobs/:id/webhook", requirePublicApiToken(["jobs:run"]), async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    if (!verifyWebhookSignature(req, job)) return res.status(401).json({ error: "Signature webhook invalide" });
    res.json(await runJobNow({ ...job, config: { ...job.config, webhookPayload: req.body } }, { preserveSchedule: true }));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.get("/jobs/:id/runs", requirePublicApiToken(["jobs:read"]), async (req, res, next) => {
  try {
    res.json(await listRuns(req.params.id, paginationFromQuery(req)));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.post("/deadman", requirePublicApiToken(["deadman:write"]), async (req, res, next) => {
  try {
    res.status(201).json(await createDeadman(req.body));
  } catch (error) {
    next(error);
  }
});

publicApiRouter.all("/deadman/:slug/ping", requirePublicApiToken(["deadman:write"]), async (req, res, next) => {
  try {
    const deadman = await pingDeadman(req.params.slug);
    if (!deadman) return res.status(404).json({ error: "Ping introuvable" });
    res.json({ ok: true, deadman });
  } catch (error) {
    next(error);
  }
});
