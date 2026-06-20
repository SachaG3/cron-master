import { Job, pool } from "./db.js";

export async function loadRuntimeState(jobId: string) {
  const result = await pool.query<{ state: Record<string, unknown> }>("SELECT state FROM job_runtime_state WHERE job_id = $1", [jobId]);
  return result.rows[0]?.state ?? {};
}

export async function mergeRuntimeState(job: Job): Promise<Job> {
  return { ...job, config: { ...job.config, ...(await loadRuntimeState(job.id)) } };
}

export async function patchRuntimeState(jobId: string, patch: Record<string, unknown>) {
  await pool.query(
    `INSERT INTO job_runtime_state (job_id, state, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (job_id) DO UPDATE
       SET state = job_runtime_state.state || EXCLUDED.state,
           updated_at = now()`,
    [jobId, patch],
  );
}

export async function clearWorkerClaim(jobId: string) {
  await pool.query(
    `INSERT INTO job_runtime_state (job_id, worker_claimed_at, updated_at)
     VALUES ($1, NULL, now())
     ON CONFLICT (job_id) DO UPDATE
       SET worker_claimed_at = NULL,
           updated_at = now()`,
    [jobId],
  );
}
