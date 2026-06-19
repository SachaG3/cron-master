import { z } from "zod";
import { pool, Job } from "./db.js";
import { sendNotifications } from "./notify.js";
import { getNotificationSettings } from "./settings.js";

export const credentialSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["discord", "ntfy", "webhook", "email", "telegram", "slack", "gotify"]),
  value: z.record(z.unknown()).default({}),
});

export const maintenanceSchema = z.object({
  name: z.string().min(1),
  jobId: z.string().uuid().optional().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  enabled: z.boolean().default(true),
});

export const deadmanSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/),
  expectedIntervalMinutes: z.number().min(1).default(60),
  graceMinutes: z.number().min(0).default(10),
  enabled: z.boolean().default(true),
});

export const templates = [
  {
    id: "website",
    name: "Surveiller un site",
    description: "Teste une URL et alerte si le statut n'est pas OK.",
    job: { type: "website_check", config: { url: "https://example.com", expectedStatus: 200, severity: "critical", retryCount: 2 } },
  },
  {
    id: "ssh",
    name: "Verifier SSH",
    description: "Teste un port SSH ou autre port TCP.",
    job: { type: "machine_check", config: { host: "server.local", port: 22, severity: "warning", retryCount: 2 } },
  },
  {
    id: "network",
    name: "Suivre un reseau",
    description: "Ping plusieurs machines et notifie quand le reseau revient apres une panne.",
    job: {
      type: "network_monitor",
      config: {
        targets: [
          { host: "192.168.1.1", label: "Routeur" },
          { host: "1.1.1.1", label: "DNS Cloudflare" },
        ],
        minOnline: 1,
        timeoutMs: 2000,
        failureThreshold: 2,
        recoveryThreshold: 2,
        reminderMinutes: 30,
        notifyOnDown: false,
        notifyOnRecovery: true,
        severity: "critical",
      },
    },
  },
  {
    id: "birthday",
    name: "Rappel anniversaire",
    description: "Envoie une notification a une date precise.",
    job: { type: "date_reminder", config: { message: "Rappel: anniversaire aujourd'hui", severity: "info" } },
  },
  {
    id: "deadman",
    name: "Backup attendu",
    description: "Cree un controle qui doit recevoir un ping regulier.",
    job: { type: "deadman", config: { expectedIntervalMinutes: 1440, graceMinutes: 60, severity: "critical" } },
  },
  {
    id: "blocks",
    name: "Workflow par blocs",
    description: "Enchaine notification, checks, attente et webhook.",
    job: {
      type: "script",
      config: {
        blocks: [
          { id: "a", kind: "notify", message: "Debut $JOB_NAME" },
          { id: "b", kind: "http", url: "https://example.com", expectedStatus: 200 },
          { id: "c", kind: "notify", message: "Fin $JOB_NAME" },
        ],
      },
    },
  },
];

export async function ensureProductTables() {
  await pool.query(`
    ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_type_check;
    ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
      CHECK (type IN ('notification', 'date_reminder', 'website_check', 'machine_check', 'network_monitor', 'script'));

    CREATE TABLE IF NOT EXISTS credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS maintenance_windows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      job_id UUID REFERENCES jobs(id) ON DELETE CASCADE,
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID REFERENCES jobs(id) ON DELETE SET NULL,
      deadman_id UUID,
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      status TEXT NOT NULL DEFAULT 'open',
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      last_message TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS deadman_checks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      expected_interval_minutes INTEGER NOT NULL DEFAULT 60,
      grace_minutes INTEGER NOT NULL DEFAULT 10,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_ping_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status, opened_at DESC);
    CREATE INDEX IF NOT EXISTS maintenance_active_idx ON maintenance_windows(enabled, starts_at, ends_at);
  `);
}

export async function listCredentials() {
  const result = await pool.query("SELECT id, name, type, created_at FROM credentials ORDER BY created_at DESC");
  return result.rows;
}

export async function createCredential(input: unknown) {
  const credential = credentialSchema.parse(input);
  const result = await pool.query(
    "INSERT INTO credentials (name, type, value) VALUES ($1, $2, $3) RETURNING id, name, type, created_at",
    [credential.name, credential.type, credential.value],
  );
  return result.rows[0];
}

export async function deleteCredential(id: string) {
  await pool.query("DELETE FROM credentials WHERE id = $1", [id]);
}

export async function listMaintenance() {
  const result = await pool.query("SELECT * FROM maintenance_windows ORDER BY starts_at DESC LIMIT 100");
  return result.rows;
}

export async function createMaintenance(input: unknown) {
  const maintenance = maintenanceSchema.parse(input);
  const result = await pool.query(
    `INSERT INTO maintenance_windows (name, job_id, starts_at, ends_at, enabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [maintenance.name, maintenance.jobId ?? null, maintenance.startsAt, maintenance.endsAt, maintenance.enabled],
  );
  return result.rows[0];
}

export async function deleteMaintenance(id: string) {
  await pool.query("DELETE FROM maintenance_windows WHERE id = $1", [id]);
}

export async function isInMaintenance(job: Job) {
  const result = await pool.query(
    `SELECT 1 FROM maintenance_windows
     WHERE enabled = true
       AND starts_at <= now()
       AND ends_at >= now()
       AND (job_id IS NULL OR job_id = $1)
     LIMIT 1`,
    [job.id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listIncidents() {
  const result = await pool.query("SELECT * FROM incidents ORDER BY opened_at DESC LIMIT 100");
  return result.rows;
}

export async function resolveIncident(id: string) {
  const result = await pool.query(
    "UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE id = $1 RETURNING *",
    [id],
  );
  return result.rows[0] ?? null;
}

async function openIncident(input: {
  jobId?: string | null;
  deadmanId?: string | null;
  title: string;
  severity?: string;
  message: string;
  details?: Record<string, unknown>;
}) {
  const existing = await pool.query(
    `SELECT * FROM incidents
     WHERE status = 'open'
       AND (($1::uuid IS NOT NULL AND job_id = $1::uuid) OR ($2::uuid IS NOT NULL AND deadman_id = $2::uuid))
     LIMIT 1`,
    [input.jobId ?? null, input.deadmanId ?? null],
  );
  if (existing.rows[0]) {
    const updated = await pool.query(
      "UPDATE incidents SET last_message = $1, details = $2 WHERE id = $3 RETURNING *",
      [input.message, input.details ?? {}, existing.rows[0].id],
    );
    return updated.rows[0];
  }

  const result = await pool.query(
    `INSERT INTO incidents (job_id, deadman_id, title, severity, last_message, details)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.jobId ?? null, input.deadmanId ?? null, input.title, input.severity ?? "warning", input.message, input.details ?? {}],
  );
  return result.rows[0];
}

async function resolveOpenIncidentFor(jobId: string) {
  await pool.query(
    "UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE job_id = $1 AND status = 'open'",
    [jobId],
  );
}

export async function recordJobOutcome(job: Job, result: { status: "success" | "failure"; message: string; output: Record<string, unknown> }) {
  if (result.status === "failure") {
    const incident = await openIncident({
      jobId: job.id,
      title: job.name,
      severity: typeof job.config.severity === "string" ? job.config.severity : "warning",
      message: result.message,
      details: result.output,
    });
    return { incident };
  }
  await resolveOpenIncidentFor(job.id);
  return { incident: null };
}

export async function listDeadmen() {
  const result = await pool.query("SELECT * FROM deadman_checks ORDER BY created_at DESC");
  return result.rows;
}

export async function createDeadman(input: unknown) {
  const deadman = deadmanSchema.parse(input);
  const result = await pool.query(
    `INSERT INTO deadman_checks (name, slug, expected_interval_minutes, grace_minutes, enabled)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [deadman.name, deadman.slug, deadman.expectedIntervalMinutes, deadman.graceMinutes, deadman.enabled],
  );
  return result.rows[0];
}

export async function deleteDeadman(id: string) {
  await pool.query("DELETE FROM deadman_checks WHERE id = $1", [id]);
}

export async function pingDeadman(slug: string) {
  const result = await pool.query(
    "UPDATE deadman_checks SET last_ping_at = now(), status = 'ok' WHERE slug = $1 RETURNING *",
    [slug],
  );
  if (result.rows[0]) {
    await pool.query(
      "UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE deadman_id = $1 AND status = 'open'",
      [result.rows[0].id],
    );
  }
  return result.rows[0] ?? null;
}

export async function checkDeadmen() {
  const result = await pool.query(
    `SELECT * FROM deadman_checks
     WHERE enabled = true
       AND (
         last_ping_at IS NULL
         OR last_ping_at + ((expected_interval_minutes + grace_minutes) * interval '1 minute') < now()
       )`,
  );

  for (const deadman of result.rows) {
    await pool.query("UPDATE deadman_checks SET status = 'missing' WHERE id = $1", [deadman.id]);
    const incident = await openIncident({
      deadmanId: deadman.id,
      title: deadman.name,
      severity: "critical",
      message: "Ping attendu non recu",
      details: { slug: deadman.slug, lastPingAt: deadman.last_ping_at },
    });
    const settings = await getNotificationSettings();
    if (settings.notifyOnFailure) {
      await sendNotifications(settings, `${deadman.name}: ping attendu non recu`);
    }
    return incident;
  }
}

export async function getDashboard() {
  const [jobs, runs, incidents, deadmen] = await Promise.all([
    pool.query("SELECT count(*)::int AS count FROM jobs WHERE enabled = true"),
    pool.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'success')::int AS success,
        count(*) FILTER (WHERE status = 'failure')::int AS failure
      FROM job_runs
      WHERE started_at > now() - interval '24 hours'
    `),
    pool.query("SELECT count(*)::int AS open FROM incidents WHERE status = 'open'"),
    pool.query("SELECT count(*)::int AS missing FROM deadman_checks WHERE status = 'missing'"),
  ]);
  return {
    activeJobs: jobs.rows[0].count,
    runs24h: runs.rows[0],
    openIncidents: incidents.rows[0].open,
    missingDeadmen: deadmen.rows[0].missing,
  };
}

export async function getPublicStatus() {
  const [jobs, incidents, deadmen] = await Promise.all([
    pool.query("SELECT id, name, type, enabled, last_run_at FROM jobs ORDER BY name"),
    pool.query("SELECT title, severity, opened_at, last_message FROM incidents WHERE status = 'open' ORDER BY opened_at DESC"),
    pool.query("SELECT name, slug, status, last_ping_at FROM deadman_checks ORDER BY name"),
  ]);
  return {
    status: (incidents.rowCount ?? 0) > 0 || deadmen.rows.some((row) => row.status === "missing") ? "degraded" : "ok",
    jobs: jobs.rows,
    incidents: incidents.rows,
    deadmen: deadmen.rows,
  };
}

export async function exportData() {
  const [jobs, credentials, maintenance, deadmen] = await Promise.all([
    pool.query("SELECT * FROM jobs ORDER BY created_at"),
    pool.query("SELECT name, type, value FROM credentials ORDER BY created_at"),
    pool.query("SELECT name, job_id, starts_at, ends_at, enabled FROM maintenance_windows ORDER BY created_at"),
    pool.query("SELECT name, slug, expected_interval_minutes, grace_minutes, enabled FROM deadman_checks ORDER BY created_at"),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    jobs: jobs.rows,
    credentials: credentials.rows,
    maintenance: maintenance.rows,
    deadmen: deadmen.rows,
  };
}

export async function importData(data: { jobs?: Job[] }) {
  let importedJobs = 0;
  for (const job of data.jobs ?? []) {
    await pool.query(
      `INSERT INTO jobs (name, description, type, schedule_type, cron_expression, run_at, timezone, enabled, config, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        job.name,
        job.description ?? "",
        job.type,
        job.schedule_type,
        job.cron_expression,
        job.run_at,
        job.timezone ?? "Europe/Paris",
        job.enabled,
        job.config ?? {},
        job.next_run_at,
      ],
    );
    importedJobs += 1;
  }
  return { importedJobs };
}
