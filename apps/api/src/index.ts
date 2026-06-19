import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { createJob, deleteJob, duplicateJob, getJob, jobInputSchema, listJobs, listRuns, setJobEnabled, updateJob } from "./jobs.js";
import { ensureCoreTables } from "./migrations.js";
import { sendNotifications } from "./notify.js";
import { ensureSettingsTable, getNotificationSettings, notificationSettingsSchema, updateNotificationSettings } from "./settings.js";
import { runJobNow, startWorker } from "./worker.js";
import {
  createCredential,
  createDeadman,
  createMaintenance,
  deleteCredential,
  deleteDeadman,
  deleteMaintenance,
  ensureProductTables,
  exportData,
  getDashboard,
  getPublicStatus,
  importData,
  listCredentials,
  listDeadmen,
  listIncidents,
  listMaintenance,
  pingDeadman,
  resolveIncident,
  templates,
} from "./features.js";
import { publicApiRouter } from "./publicApi.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/v1", publicApiRouter);

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

app.delete("/deadman/:id", async (req, res, next) => {
  try {
    await deleteDeadman(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
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

app.get("/jobs", async (_req, res, next) => {
  try {
    res.json(await listJobs());
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
    res.json(await runJobNow(job));
  } catch (error) {
    next(error);
  }
});

app.post("/webhooks/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job introuvable" });
    res.json(await runJobNow({ ...job, config: { ...job.config, webhookPayload: req.body } }));
  } catch (error) {
    next(error);
  }
});

app.get("/runs", async (req, res, next) => {
  try {
    const jobId = typeof req.query.jobId === "string" ? req.query.jobId : undefined;
    res.json(await listRuns(jobId));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) {
    return res.status(400).json({ error: "Payload invalide", details: error.flatten() });
  }
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "Erreur interne" });
});

app.listen(port, () => {
  console.log(`Cron Master API listening on :${port}`);
  ensureCoreTables()
    .then(() => ensureSettingsTable())
    .then(() => ensureProductTables())
    .then(() => startWorker())
    .catch((error) => console.error("database migration failed", error));
});
