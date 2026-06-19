import { pool } from "./db.js";

export async function ensureCoreTables() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await pool.query(`
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
  `);
}
