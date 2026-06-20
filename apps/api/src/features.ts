import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
  description: z.string().optional().default(""),
  slug: z.string().trim().min(2).regex(/^[a-z0-9-]+$/).optional().or(z.literal("")),
  expectedIntervalMinutes: z.number().int().min(1).max(10080).default(60),
  graceMinutes: z.number().int().min(0).max(10080).default(10),
  severity: z.enum(["info", "warning", "critical"]).default("critical"),
  reminderMinutes: z.number().int().min(0).max(10080).default(0),
  notifyOnMissing: z.boolean().default(true),
  notifyOnRecovery: z.boolean().default(true),
  enabled: z.boolean().default(true),
});

export const deadmanUpdateSchema = deadmanSchema.omit({ slug: true }).partial();

const credentialsSecret = process.env.CREDENTIALS_SECRET ?? process.env.SESSION_SECRET ?? "cron-master-dev-credentials-secret";
const credentialsKey = createHash("sha256").update(credentialsSecret).digest();

function encryptCredential(value: Record<string, unknown>) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialsKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptCredential(value: string) {
  const [ivValue, authTagValue, encryptedValue] = value.split(".");
  if (!ivValue || !authTagValue || !encryptedValue) return {};
  const decipher = createDecipheriv("aes-256-gcm", credentialsKey, Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(authTagValue, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64")), decipher.final()]).toString("utf8");
  return JSON.parse(decrypted) as Record<string, unknown>;
}

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
      encrypted_value TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE credentials ADD COLUMN IF NOT EXISTS encrypted_value TEXT;

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
      muted_until TIMESTAMPTZ,
      escalated_at TIMESTAMPTZ,
      last_message TEXT NOT NULL DEFAULT '',
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
    ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS deadman_checks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      expected_interval_minutes INTEGER NOT NULL DEFAULT 60,
      grace_minutes INTEGER NOT NULL DEFAULT 10,
      severity TEXT NOT NULL DEFAULT 'critical',
      reminder_minutes INTEGER NOT NULL DEFAULT 0,
      notify_on_missing BOOLEAN NOT NULL DEFAULT TRUE,
      notify_on_recovery BOOLEAN NOT NULL DEFAULT TRUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_ping_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      missing_since TIMESTAMPTZ,
      last_notification_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'critical';
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS reminder_minutes INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS notify_on_missing BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS notify_on_recovery BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS missing_since TIMESTAMPTZ;
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS last_notification_at TIMESTAMPTZ;
    ALTER TABLE deadman_checks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE TABLE IF NOT EXISTS api_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      last_four TEXT NOT NULL,
      scopes JSONB NOT NULL DEFAULT '["status:read", "jobs:read"]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status, opened_at DESC);
    CREATE INDEX IF NOT EXISTS maintenance_active_idx ON maintenance_windows(enabled, starts_at, ends_at);
    CREATE INDEX IF NOT EXISTS api_tokens_active_idx ON api_tokens(revoked_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS deadman_checks_enabled_status_idx ON deadman_checks(enabled, status);
  `);
}

export async function listCredentials() {
  const result = await pool.query("SELECT id, name, type, created_at FROM credentials ORDER BY created_at DESC");
  return result.rows;
}

export async function createCredential(input: unknown) {
  const credential = credentialSchema.parse(input);
  const result = await pool.query(
    "INSERT INTO credentials (name, type, value, encrypted_value) VALUES ($1, $2, $3, $4) RETURNING id, name, type, created_at",
    [credential.name, credential.type, { redacted: true }, encryptCredential(credential.value)],
  );
  return result.rows[0];
}

export async function getCredentialValue(id: string) {
  const result = await pool.query<{ value: Record<string, unknown>; encrypted_value: string | null }>("SELECT value, encrypted_value FROM credentials WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row) return {};
  return row.encrypted_value ? decryptCredential(row.encrypted_value) : row.value;
}

export async function deleteCredential(id: string) {
  await pool.query("DELETE FROM credentials WHERE id = $1", [id]);
}

export async function listMaintenance() {
  const result = await pool.query("SELECT * FROM maintenance_windows ORDER BY starts_at DESC LIMIT 100");
  return result.rows;
}

export async function listMaintenanceCalendar() {
  const result = await pool.query(
    `SELECT id, name AS title, starts_at AS start, ends_at AS end, enabled, job_id
     FROM maintenance_windows
     ORDER BY starts_at ASC
     LIMIT 500`,
  );
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

export async function muteIncident(id: string, minutes: number) {
  const result = await pool.query(
    "UPDATE incidents SET muted_until = now() + ($2::int * interval '1 minute') WHERE id = $1 RETURNING *",
    [id, Math.max(1, Math.min(10080, minutes))],
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
  escalateAfterMinutes?: number;
}) {
  const existing = await pool.query(
    `SELECT * FROM incidents
     WHERE status = 'open'
       AND (($1::uuid IS NOT NULL AND job_id = $1::uuid) OR ($2::uuid IS NOT NULL AND deadman_id = $2::uuid))
     LIMIT 1`,
    [input.jobId ?? null, input.deadmanId ?? null],
  );
  if (existing.rows[0]) {
    const current = existing.rows[0];
    const mutedUntil = current.muted_until ? new Date(current.muted_until).getTime() : 0;
    const escalateAfterMinutes = Math.max(0, Math.min(10080, input.escalateAfterMinutes ?? 0));
    const shouldEscalate =
      escalateAfterMinutes > 0 &&
      !current.escalated_at &&
      (!mutedUntil || mutedUntil <= Date.now()) &&
      Date.now() - new Date(current.opened_at).getTime() >= escalateAfterMinutes * 60_000;
    const updated = await pool.query(
      `UPDATE incidents
       SET last_message = $1,
           details = $2,
           escalated_at = CASE WHEN $4::boolean THEN now() ELSE escalated_at END
       WHERE id = $3
       RETURNING *`,
      [input.message, input.details ?? {}, current.id, shouldEscalate],
    );
    if (shouldEscalate) {
      await sendNotifications(await getNotificationSettings(), `${input.title}: incident toujours ouvert (${input.message})`);
    }
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
      escalateAfterMinutes: typeof job.config.escalateAfterMinutes === "number" ? job.config.escalateAfterMinutes : undefined,
    });
    return { incident };
  }
  await resolveOpenIncidentFor(job.id);
  return { incident: null };
}

type DeadmanRow = {
  id: string;
  name: string;
  slug: string;
  description: string;
  expected_interval_minutes: number;
  grace_minutes: number;
  severity: string;
  reminder_minutes: number;
  notify_on_missing: boolean;
  notify_on_recovery: boolean;
  enabled: boolean;
  last_ping_at: Date | null;
  status: string;
  missing_since: Date | null;
  last_notification_at: Date | null;
  created_at: Date;
  updated_at: Date;
  next_expected_at: Date;
  missing_after_at: Date;
};

const deadmanSelect = `
  SELECT *,
    COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
    COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at
  FROM deadman_checks
`;

function generateDeadmanSlug() {
  return `dm-${randomBytes(18).toString("hex")}`;
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function shouldNotifyDeadmanMissing(input: {
  wasMissing: boolean;
  notifyOnMissing: boolean;
  reminderMinutes: number;
  lastNotificationAt?: Date | string | null;
  now?: Date;
}) {
  if (!input.notifyOnMissing) return false;
  if (!input.wasMissing) return true;
  if (input.reminderMinutes <= 0) return false;
  const lastNotificationAt = input.lastNotificationAt ? new Date(input.lastNotificationAt).getTime() : 0;
  return !lastNotificationAt || (input.now ?? new Date()).getTime() - lastNotificationAt >= input.reminderMinutes * 60_000;
}

export async function listDeadmen() {
  const result = await pool.query<DeadmanRow>(`${deadmanSelect} ORDER BY created_at DESC`);
  return result.rows;
}

export async function createDeadman(input: unknown) {
  const deadman = deadmanSchema.parse(input);
  const slug = deadman.slug || generateDeadmanSlug();
  const result = await pool.query<DeadmanRow>(
    `INSERT INTO deadman_checks
      (name, slug, description, expected_interval_minutes, grace_minutes, severity, reminder_minutes, notify_on_missing, notify_on_recovery, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *,
       COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
       COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at`,
    [
      deadman.name,
      slug,
      deadman.description,
      deadman.expectedIntervalMinutes,
      deadman.graceMinutes,
      deadman.severity,
      deadman.reminderMinutes,
      deadman.notifyOnMissing,
      deadman.notifyOnRecovery,
      deadman.enabled,
    ],
  );
  return result.rows[0];
}

export async function updateDeadman(id: string, input: unknown) {
  const current = await pool.query<DeadmanRow>(`${deadmanSelect} WHERE id = $1`, [id]);
  const row = current.rows[0];
  if (!row) return null;

  const deadman = deadmanUpdateSchema.parse(input);
  const result = await pool.query<DeadmanRow>(
    `UPDATE deadman_checks
     SET name = $1,
         description = $2,
         expected_interval_minutes = $3,
         grace_minutes = $4,
         severity = $5,
         reminder_minutes = $6,
         notify_on_missing = $7,
         notify_on_recovery = $8,
         enabled = $9,
         status = CASE WHEN $9::boolean = false THEN status ELSE status END,
         updated_at = now()
     WHERE id = $10
     RETURNING *,
       COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
       COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at`,
    [
      deadman.name ?? row.name,
      deadman.description ?? row.description,
      deadman.expectedIntervalMinutes ?? row.expected_interval_minutes,
      deadman.graceMinutes ?? row.grace_minutes,
      deadman.severity ?? row.severity,
      deadman.reminderMinutes ?? row.reminder_minutes,
      deadman.notifyOnMissing ?? row.notify_on_missing,
      deadman.notifyOnRecovery ?? row.notify_on_recovery,
      deadman.enabled ?? row.enabled,
      id,
    ],
  );
  return result.rows[0] ?? null;
}

export async function setDeadmanEnabled(id: string, enabled: boolean) {
  const result = await pool.query<DeadmanRow>(
    `UPDATE deadman_checks
     SET enabled = $1, updated_at = now()
     WHERE id = $2
     RETURNING *,
       COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
       COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at`,
    [enabled, id],
  );
  return result.rows[0] ?? null;
}

export async function rotateDeadmanSlug(id: string) {
  const result = await pool.query<DeadmanRow>(
    `UPDATE deadman_checks
     SET slug = $1, updated_at = now()
     WHERE id = $2
     RETURNING *,
       COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
       COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at`,
    [generateDeadmanSlug(), id],
  );
  return result.rows[0] ?? null;
}

export async function deleteDeadman(id: string) {
  await pool.query("DELETE FROM deadman_checks WHERE id = $1", [id]);
}

export async function pingDeadman(slug: string) {
  const current = await pool.query<DeadmanRow>("SELECT * FROM deadman_checks WHERE slug = $1", [slug]);
  const previous = current.rows[0];
  if (!previous) return null;

  const result = await pool.query(
    `UPDATE deadman_checks
     SET last_ping_at = now(),
         status = 'ok',
         missing_since = NULL,
         updated_at = now()
     WHERE slug = $1
     RETURNING *,
       COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
       COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at`,
    [slug],
  );
  const deadman = result.rows[0] ?? null;

  if (deadman && previous.status === "missing") {
    await pool.query("UPDATE incidents SET status = 'resolved', resolved_at = now() WHERE deadman_id = $1 AND status = 'open'", [deadman.id]);
    if (previous.notify_on_recovery) {
      const duration = previous.missing_since ? ` apres ${formatDuration(Date.now() - new Date(previous.missing_since).getTime())}` : "";
      await sendNotifications(await getNotificationSettings(), `${deadman.name}: ping retabli${duration}`);
    }
  }

  return deadman;
}

export async function pingDeadmanById(id: string) {
  const result = await pool.query<{ slug: string }>("SELECT slug FROM deadman_checks WHERE id = $1", [id]);
  return result.rows[0] ? await pingDeadman(result.rows[0].slug) : null;
}

export async function checkDeadmen() {
  const result = await pool.query<DeadmanRow>(
    `SELECT * FROM deadman_checks
     WHERE enabled = true
       AND COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') < now()
     ORDER BY COALESCE(missing_since, created_at) ASC`,
  );

  const incidents = [];
  const settings = result.rows.length > 0 ? await getNotificationSettings() : null;

  for (const deadman of result.rows) {
    const wasMissing = deadman.status === "missing";
    const missingSince = deadman.missing_since ?? new Date();
    await pool.query(
      `UPDATE deadman_checks
       SET status = 'missing',
           missing_since = COALESCE(missing_since, now()),
           updated_at = now()
       WHERE id = $1`,
      [deadman.id],
    );
    const incident = await openIncident({
      deadmanId: deadman.id,
      title: deadman.name,
      severity: deadman.severity,
      message: "Ping attendu non recu",
      details: {
        lastPingAt: deadman.last_ping_at,
        expectedIntervalMinutes: deadman.expected_interval_minutes,
        graceMinutes: deadman.grace_minutes,
        missingSince,
      },
    });
    incidents.push(incident);

    if (settings?.notifyOnFailure && shouldNotifyDeadmanMissing({
      wasMissing,
      notifyOnMissing: deadman.notify_on_missing,
      reminderMinutes: deadman.reminder_minutes,
      lastNotificationAt: deadman.last_notification_at,
    })) {
      await sendNotifications(settings, `${deadman.name}: ping attendu non recu`);
      await pool.query("UPDATE deadman_checks SET last_notification_at = now(), updated_at = now() WHERE id = $1", [deadman.id]);
    }
  }

  return incidents;
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
    pool.query(
      `SELECT name, status, last_ping_at,
              COALESCE(last_ping_at, created_at) + (expected_interval_minutes * interval '1 minute') AS next_expected_at,
              COALESCE(last_ping_at, created_at) + ((expected_interval_minutes + grace_minutes) * interval '1 minute') AS missing_after_at
       FROM deadman_checks
       ORDER BY name`,
    ),
  ]);
  return {
    status: (incidents.rowCount ?? 0) > 0 || deadmen.rows.some((row) => row.status === "missing") ? "degraded" : "ok",
    jobs: jobs.rows,
    incidents: incidents.rows,
    deadmen: deadmen.rows,
  };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export async function getPublicStatusHtml() {
  const status = await getPublicStatus();
  const incidentItems = status.incidents
    .map((incident) => `<li><strong>${escapeHtml(incident.title)}</strong> (${escapeHtml(incident.severity)}): ${escapeHtml(incident.last_message)}</li>`)
    .join("");
  const deadmanItems = status.deadmen
    .map((deadman) => `<li><strong>${escapeHtml(deadman.name)}</strong>: ${escapeHtml(deadman.status)}${deadman.last_ping_at ? `, dernier ping ${escapeHtml(String(deadman.last_ping_at))}` : ""}</li>`)
    .join("");

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cron Master Status</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #111827; background: #f9fafb; }
    main { max-width: 760px; margin: 0 auto; }
    .badge { display: inline-block; padding: .35rem .55rem; border-radius: .35rem; background: ${status.status === "ok" ? "#dcfce7" : "#fee2e2"}; }
    section { margin-top: 1.5rem; padding: 1rem; background: white; border: 1px solid #e5e7eb; border-radius: .5rem; }
  </style>
</head>
<body>
  <main>
    <h1>Cron Master Status</h1>
    <p class="badge">${escapeHtml(status.status)}</p>
    <section><h2>Incidents ouverts</h2><ul>${incidentItems || "<li>Aucun incident ouvert</li>"}</ul></section>
    <section><h2>Dead-men</h2><ul>${deadmanItems || "<li>Aucun dead-man configure</li>"}</ul></section>
  </main>
</body>
</html>`;
}

export async function exportData() {
  const [jobs, credentials, maintenance, deadmen] = await Promise.all([
    pool.query("SELECT * FROM jobs ORDER BY created_at"),
    pool.query("SELECT name, type, true AS redacted FROM credentials ORDER BY created_at"),
    pool.query("SELECT name, job_id, starts_at, ends_at, enabled FROM maintenance_windows ORDER BY created_at"),
    pool.query(
      `SELECT name, slug, description, expected_interval_minutes, grace_minutes, severity,
              reminder_minutes, notify_on_missing, notify_on_recovery, enabled
       FROM deadman_checks
       ORDER BY created_at`,
    ),
  ]);
  return {
    exportedAt: new Date().toISOString(),
    jobs: jobs.rows,
    credentials: credentials.rows,
    maintenance: maintenance.rows,
    deadmen: deadmen.rows,
  };
}

export function validateImportData(data: { jobs?: Job[]; deadmen?: Array<Record<string, unknown>> }) {
  const errors: string[] = [];
  for (const [index, job] of (data.jobs ?? []).entries()) {
    if (!job.name) errors.push(`jobs[${index}].name manquant`);
    if (!["notification", "date_reminder", "website_check", "machine_check", "network_monitor", "script"].includes(job.type)) errors.push(`jobs[${index}].type invalide`);
    if (!["cron", "once"].includes(job.schedule_type)) errors.push(`jobs[${index}].schedule_type invalide`);
    if (job.schedule_type === "cron" && !job.cron_expression) errors.push(`jobs[${index}].cron_expression manquant`);
  }
  for (const [index, deadman] of (data.deadmen ?? []).entries()) {
    if (typeof deadman.name !== "string" || !deadman.name.trim()) errors.push(`deadmen[${index}].name manquant`);
    if (typeof deadman.slug === "string" && deadman.slug && !/^[a-z0-9-]+$/.test(deadman.slug)) errors.push(`deadmen[${index}].slug invalide`);
  }
  return {
    ok: errors.length === 0,
    errors,
    counts: { jobs: data.jobs?.length ?? 0, deadmen: data.deadmen?.length ?? 0 },
  };
}

export async function importData(data: { jobs?: Job[]; deadmen?: Array<Record<string, unknown>> }) {
  const validation = validateImportData(data);
  if (!validation.ok) {
    throw new Error(`Import invalide: ${validation.errors.join(", ")}`);
  }

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

  let importedDeadmen = 0;
  for (const deadman of data.deadmen ?? []) {
    await createDeadman({
      name: deadman.name,
      slug: deadman.slug,
      description: deadman.description,
      expectedIntervalMinutes: deadman.expected_interval_minutes ?? deadman.expectedIntervalMinutes,
      graceMinutes: deadman.grace_minutes ?? deadman.graceMinutes,
      severity: deadman.severity,
      reminderMinutes: deadman.reminder_minutes ?? deadman.reminderMinutes,
      notifyOnMissing: deadman.notify_on_missing ?? deadman.notifyOnMissing,
      notifyOnRecovery: deadman.notify_on_recovery ?? deadman.notifyOnRecovery,
      enabled: deadman.enabled,
    });
    importedDeadmen += 1;
  }

  return { importedJobs, importedDeadmen };
}
