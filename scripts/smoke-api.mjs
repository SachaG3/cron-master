const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000";
const apiKey = process.env.CRON_MASTER_API_KEY ?? "change-me-dev-key";
const headers = {
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${text}`);
  }
  return { response, body };
}

const createdIds = [];

try {
  await request("/api/v1/health");

  const createResult = await request("/api/v1/jobs", {
    method: "POST",
    body: JSON.stringify({
      name: `CI smoke ${Date.now()}`,
      type: "notification",
      schedule: { mode: "every_minutes", value: 10 },
      config: { message: "CI smoke test", severity: "info" },
    }),
  });
  const job = createResult.body;
  createdIds.push(job.id);

  const pauseResult = await request(`/api/v1/jobs/${job.id}/pause`, { method: "POST", body: "{}" });
  if (pauseResult.body.enabled !== false || pauseResult.body.next_run_at !== null) {
    throw new Error("pause endpoint did not disable the job");
  }

  const resumeResult = await request(`/api/v1/jobs/${job.id}/resume`, { method: "POST", body: "{}" });
  if (resumeResult.body.enabled !== true || !resumeResult.body.next_run_at) {
    throw new Error("resume endpoint did not enable and reschedule the job");
  }

  const duplicateResult = await request(`/api/v1/jobs/${job.id}/duplicate`, { method: "POST", body: "{}" });
  createdIds.push(duplicateResult.body.id);
  if (duplicateResult.body.enabled !== false) {
    throw new Error("duplicate endpoint should create a paused job");
  }

  const runResult = await request(`/api/v1/jobs/${job.id}/run`, { method: "POST", body: JSON.stringify({ source: "ci" }) });
  if (runResult.body.status !== "success") {
    throw new Error(`run endpoint returned ${runResult.body.status}`);
  }

  const runsResult = await request(`/api/v1/jobs/${job.id}/runs`);
  if (!Array.isArray(runsResult.body) || runsResult.body.length === 0) {
    throw new Error("runs endpoint did not return the smoke run");
  }

  console.log("Smoke test passed");
} finally {
  for (const id of createdIds.reverse()) {
    try {
      await request(`/api/v1/jobs/${id}`, { method: "DELETE" });
    } catch (error) {
      console.warn(`cleanup failed for ${id}:`, error);
    }
  }
}
