import { pool } from "./db.js";

type Migration = {
  id: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    id: 1,
    name: "core_schema",
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK (type IN ('notification', 'date_reminder', 'website_check', 'machine_check', 'network_monitor', 'script')),
        schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'once')),
        cron_expression TEXT,
        run_at TIMESTAMPTZ,
        timezone TEXT NOT NULL DEFAULT 'Europe/Paris',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        next_run_at TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS job_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        message TEXT NOT NULL DEFAULT '',
        output JSONB NOT NULL DEFAULT '{}'::jsonb
      );

      CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (enabled, next_run_at);
      CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs (job_id, started_at DESC);
    `,
  },
  {
    id: 2,
    name: "settings_auth_sessions",
    sql: `
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      INSERT INTO app_settings (key, value)
      VALUES ('notifications', '{}'::jsonb)
      ON CONFLICT (key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS admin_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS "session" (
        sid VARCHAR NOT NULL PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      );

      CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" (expire);
      DROP TABLE IF EXISTS admin_sessions;
    `,
  },
  {
    id: 3,
    name: "product_tables",
    sql: `
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
    `,
  },
  {
    id: 4,
    name: "runtime_state",
    sql: `
      CREATE TABLE IF NOT EXISTS job_runtime_state (
        job_id UUID PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
        state JSONB NOT NULL DEFAULT '{}'::jsonb,
        worker_claimed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS job_runtime_worker_claim_idx ON job_runtime_state(worker_claimed_at);
    `,
  },
  {
    id: 5,
    name: "backfill_product_columns",
    sql: `
      ALTER TABLE credentials ADD COLUMN IF NOT EXISTS encrypted_value TEXT;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS muted_until TIMESTAMPTZ;
      ALTER TABLE incidents ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
    `,
  },
];

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const migration of migrations) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [migration.id]);
      if ((existing.rowCount ?? 0) === 0) {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [migration.id, migration.name]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function ensureCoreTables() {
  await runMigrations();
}
