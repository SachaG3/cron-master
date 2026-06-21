import cors from "cors";
import express from "express";
import { z, ZodError } from "zod";
import { createApiToken, listApiTokens, revokeApiToken, rotateApiToken, testApiToken, updateApiToken } from "./apiTokens.js";
import { authRouter, requireAdminSession, sessionMiddleware } from "./auth.js";
import { buildTransientJob, createJob, deleteJob, duplicateJob, getJob, getRunStats, jobInputSchema, listJobs, listRuns, setJobEnabled, updateJob } from "./jobs.js";
import { runMigrations } from "./migrations.js";
import { sendNotifications } from "./notify.js";
import { executeJob } from "./executor.js";
import { getNotificationSettings, notificationSettingsSchema, updateNotificationSettings } from "./settings.js";
import { runJobNow, startWorker } from "./worker.js";
import {
  createCredential,
  createDeadman,
  createMaintenance,
  deleteCredential,
  deleteDeadman,
  deleteMaintenance,
  exportData,
  getDashboard,
  getPublicStatus,
  getPublicStatusHtml,
  importData,
  listCredentials,
  listDeadmen,
  listIncidents,
  listMaintenance,
  listMaintenanceCalendar,
  muteIncident,
  pingDeadmanById,
  pingDeadman,
  resolveIncident,
  rotateDeadmanSlug,
  setDeadmanEnabled,
  templates,
  updateDeadman,
  validateImportData,
} from "./features.js";
import { publicApiRouter } from "./publicApi.js";
import { openApiDocument } from "./openapi.js";
import { verifyWebhookSignature } from "./webhookSecurity.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);
const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).passthrough();
const statsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
}).passthrough();
const allowedCorsOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function corsOrigin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
  if (allowedCorsOrigins.length === 0) {
    callback(null, process.env.NODE_ENV !== "production");
    return;
  }
  callback(null, !origin || allowedCorsOrigins.includes(origin));
}

app.set("trust proxy", 1);
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  }),
);
app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => {
  (req as express.Request).rawBody = Buffer.from(buf);
} }));
app.use(sessionMiddleware);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function paginationFromQuery(req: express.Request) {
  return paginationQuerySchema.parse(req.query);
}

app.use("/api/v1", publicApiRouter);
app.use("/auth", authRouter);

app.get("/openapi.json", (_req, res) => {
  res.json(openApiDocument);
});

app.all("/ping/:slug", async (req, res, next) => {
  try {
    const deadman = await pingDeadman(req.params.slug);
    if (!deadman) return res.status(404).json({ error: "Ping introuvable" });
    res.json({ ok: true, deadman });
  } catch (error) {
    next(error);
  }
});

app.get("/status", async (_req, res, next) => {
  try {
    res.json(await getPublicStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/status.html", async (_req, res, next) => {
  try {
    res.type("html").send(await getPublicStatusHtml());
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    if (!verifyWebhookSignature(req, job)) return res.status(401).json({ error: "Signature webhook invalide" });
    res.json(await runJobNow({ ...job, config: { ...job.config, webhookPayload: req.body } }, { preserveSchedule: true }));
  } catch (error) {
    next(error);
  }
});

app.use(requireAdminSession);

app.get("/api-tokens", async (_req, res, next) => {
  try {
    res.json(await listApiTokens());
  } catch (error) {
    next(error);
  }
});

app.post("/api-tokens", async (req, res, next) => {
  try {
    res.status(201).json(await createApiToken(req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/api-tokens/test", async (req, res, next) => {
  try {
    res.json(await testApiToken(req.body));
  } catch (error) {
    next(error);
  }
});

app.put("/api-tokens/:id", async (req, res, next) => {
  try {
    const token = await updateApiToken(req.params.id, req.body);
    if (!token) return res.status(404).json({ error: "Token API introuvable" });
    res.json(token);
  } catch (error) {
    next(error);
  }
});

app.post("/api-tokens/:id/rotate", async (req, res, next) => {
  try {
    const token = await rotateApiToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token API introuvable" });
    res.json(token);
  } catch (error) {
    next(error);
  }
});

app.post("/api-tokens/:id/revoke", async (req, res, next) => {
  try {
    const token = await revokeApiToken(req.params.id);
    if (!token) return res.status(404).json({ error: "Token API introuvable" });
    res.json(token);
  } catch (error) {
    next(error);
  }
});

app.get("/settings/notifications", async (_req, res, next) => {
  try {
    res.json(await getNotificationSettings());
  } catch (error) {
    next(error);
  }
});

app.put("/settings/notifications", async (req, res, next) => {
  try {
    res.json(await updateNotificationSettings(notificationSettingsSchema.parse(req.body)));
  } catch (error) {
    next(error);
  }
});

app.post("/settings/notifications/test", async (_req, res, next) => {
  try {
    const settings = await getNotificationSettings();
    const deliveries = await sendNotifications(settings, "Test Cron Master: notifications configurees");
    res.json({ deliveries });
  } catch (error) {
    next(error);
  }
});

app.get("/dashboard", async (_req, res, next) => {
  try {
    res.json(await getDashboard());
  } catch (error) {
    next(error);
  }
});

app.get("/stats/runs", async (req, res, next) => {
  try {
    const { days } = statsQuerySchema.parse(req.query);
    res.json(await getRunStats(days));
  } catch (error) {
    next(error);
  }
});

app.get("/templates", (_req, res) => {
  res.json(templates);
});

app.get("/credentials", async (_req, res, next) => {
  try {
    res.json(await listCredentials());
  } catch (error) {
    next(error);
  }
});

app.post("/credentials", async (req, res, next) => {
  try {
    res.status(201).json(await createCredential(req.body));
  } catch (error) {
    next(error);
  }
});

app.delete("/credentials/:id", async (req, res, next) => {
  try {
    await deleteCredential(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/maintenance", async (_req, res, next) => {
  try {
    res.json(await listMaintenance());
  } catch (error) {
    next(error);
  }
});

app.get("/maintenance/calendar", async (_req, res, next) => {
  try {
    res.json(await listMaintenanceCalendar());
  } catch (error) {
    next(error);
  }
});

app.post("/maintenance", async (req, res, next) => {
  try {
    res.status(201).json(await createMaintenance(req.body));
  } catch (error) {
    next(error);
  }
});

app.delete("/maintenance/:id", async (req, res, next) => {
  try {
    await deleteMaintenance(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/incidents", async (_req, res, next) => {
  try {
    res.json(await listIncidents());
  } catch (error) {
    next(error);
  }
});

app.post("/incidents/:id/resolve", async (req, res, next) => {
  try {
    const incident = await resolveIncident(req.params.id);
    if (!incident) return res.status(404).json({ error: "Incident introuvable" });
    res.json(incident);
  } catch (error) {
    next(error);
  }
});

app.post("/incidents/:id/mute", async (req, res, next) => {
  try {
    const minutes = typeof req.body?.minutes === "number" ? req.body.minutes : 60;
    const incident = await muteIncident(req.params.id, minutes);
    if (!incident) return res.status(404).json({ error: "Incident introuvable" });
    res.json(incident);
  } catch (error) {
    next(error);
  }
});

app.get("/deadman", async (_req, res, next) => {
  try {
    res.json(await listDeadmen());
  } catch (error) {
    next(error);
  }
});

app.post("/deadman", async (req, res, next) => {
  try {
    res.status(201).json(await createDeadman(req.body));
  } catch (error) {
    next(error);
  }
});

app.put("/deadman/:id", async (req, res, next) => {
  try {
    const deadman = await updateDeadman(req.params.id, req.body);
    if (!deadman) return res.status(404).json({ error: "Dead-man introuvable" });
    res.json(deadman);
  } catch (error) {
    next(error);
  }
});

app.post("/deadman/:id/ping", async (req, res, next) => {
  try {
    const deadman = await pingDeadmanById(req.params.id);
    if (!deadman) return res.status(404).json({ error: "Dead-man introuvable" });
    res.json({ ok: true, deadman });
  } catch (error) {
    next(error);
  }
});

app.post("/deadman/:id/rotate", async (req, res, next) => {
  try {
    const deadman = await rotateDeadmanSlug(req.params.id);
    if (!deadman) return res.status(404).json({ error: "Dead-man introuvable" });
    res.json(deadman);
  } catch (error) {
    next(error);
  }
});

app.post("/deadman/:id/pause", async (req, res, next) => {
  try {
    const deadman = await setDeadmanEnabled(req.params.id, false);
    if (!deadman) return res.status(404).json({ error: "Dead-man introuvable" });
    res.json(deadman);
  } catch (error) {
    next(error);
  }
});

app.post("/deadman/:id/resume", async (req, res, next) => {
  try {
    const deadman = await setDeadmanEnabled(req.params.id, true);
    if (!deadman) return res.status(404).json({ error: "Dead-man introuvable" });
    res.json(deadman);
  } catch (error) {
    next(error);
  }
});

app.delete("/deadman/:id", async (req, res, next) => {
  try {
    await deleteDeadman(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/export", async (_req, res, next) => {
  try {
    res.json(await exportData());
  } catch (error) {
    next(error);
  }
});

app.post("/import", async (req, res, next) => {
  try {
    res.json(await importData(req.body));
  } catch (error) {
    next(error);
  }
});

app.post("/import/validate", async (req, res, next) => {
  try {
    res.json(validateImportData(req.body));
  } catch (error) {
    next(error);
  }
});

app.get("/jobs", async (req, res, next) => {
  try {
    res.json(await listJobs(paginationFromQuery(req)));
  } catch (error) {
    next(error);
  }
});

app.post("/jobs", async (req, res, next) => {
  try {
    const input = jobInputSchema.parse(req.body);
    res.status(201).json(await createJob(input));
  } catch (error) {
    next(error);
  }
});

app.post("/jobs/test", async (req, res, next) => {
  try {
    const input = jobInputSchema.parse(req.body);
    res.json(await executeJob(buildTransientJob(input)));
  } catch (error) {
    next(error);
  }
});

app.put("/jobs/:id", async (req, res, next) => {
  try {
    const input = jobInputSchema.parse(req.body);
    const job = await updateJob(req.params.id, input);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.delete("/jobs/:id", async (req, res, next) => {
  try {
    await deleteJob(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/jobs/:id/duplicate", async (req, res, next) => {
  try {
    const job = await duplicateJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

app.post("/jobs/:id/pause", async (req, res, next) => {
  try {
    const job = await setJobEnabled(req.params.id, false);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.post("/jobs/:id/resume", async (req, res, next) => {
  try {
    const job = await setJobEnabled(req.params.id, true);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(job);
  } catch (error) {
    next(error);
  }
});

app.post("/jobs/:id/run", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(await runJobNow(job, { preserveSchedule: true }));
  } catch (error) {
    next(error);
  }
});

app.get("/runs", async (req, res, next) => {
  try {
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
    res.json(await listRuns(jobId, paginationFromQuery(req)));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  if (error instanceof ZodError) {
    return res.status(400).json({ error: "Payload invalide", details: error.flatten() });
  }
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "Erreur interne" });
});

async function main() {
  await runMigrations();
  app.listen(port, () => {
    console.log(`Cron Master API listening on :${port}`);
    startWorker();
  });
}

main().catch((error) => {
  console.error("Cron Master API failed to start", error);
  process.exit(1);
});
