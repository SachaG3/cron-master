export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Cron Master API",
    version: "1.0.0",
  },
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
      },
    },
  },
  paths: {
    "/api/v1/health": { get: { summary: "API health" } },
    "/api/v1/dashboard": { get: { summary: "Dashboard summary" } },
    "/api/v1/status": { get: { summary: "Public status JSON" } },
    "/api/v1/jobs": {
      get: { summary: "List jobs", parameters: [{ name: "limit", in: "query" }, { name: "offset", in: "query" }] },
      post: { summary: "Create a job" },
    },
    "/api/v1/jobs/test": { post: { summary: "Execute a job payload without saving it" } },
    "/api/v1/jobs/{id}/run": { post: { summary: "Run a saved job now" } },
    "/api/v1/jobs/{id}/webhook": { post: { summary: "Trigger a saved job by webhook; supports x-cron-master-signature when webhookSecret is configured" } },
    "/api/v1/jobs/{id}/runs": { get: { summary: "List job runs" } },
    "/api/v1/stats/runs": { get: { summary: "Daily run statistics" } },
    "/api/v1/deadman": { post: { summary: "Create a dead-man switch" } },
    "/api/v1/deadman/{slug}/ping": { post: { summary: "Ping a dead-man switch" } },
  },
};
