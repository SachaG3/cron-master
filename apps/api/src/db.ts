import pg from "pg";

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://cronmaster:cronmaster@localhost:5432/cronmaster",
});

export type Job = {
  id: string;
  name: string;
  description: string;
  type: "notification" | "date_reminder" | "website_check" | "machine_check" | "network_monitor" | "script";
  schedule_type: "cron" | "once";
  cron_expression: string | null;
  run_at: Date | null;
  timezone: string;
  enabled: boolean;
  config: Record<string, unknown>;
  next_run_at: Date | null;
  last_run_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type JobRuntimeState = {
  job_id: string;
  state: Record<string, unknown>;
  worker_claimed_at: Date | null;
  updated_at: Date;
};

export type JobRun = {
  id: string;
  job_id: string;
  status: "success" | "failure";
  started_at: Date;
  finished_at: Date;
  message: string;
  output: Record<string, unknown>;
};
