const errorResponse = {
  description: "Erreur",
  content: {
    "application/json": {
      schema: { $ref: "#/components/schemas/Error" },
    },
  },
};

const authErrors = {
  "401": errorResponse,
  "403": errorResponse,
};

const json = (schema: Record<string, unknown>) => ({
  "application/json": { schema },
});

const operation = (summary: string, scopes: string[], extra: Record<string, unknown> = {}) => ({
  summary,
  security: [{ bearerAuth: [] }, { apiKey: [] }],
  "x-cron-master-scopes": scopes,
  responses: {
    "200": { description: "OK" },
    ...authErrors,
  },
  ...extra,
});

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Cron Master API",
    version: "1.1.0",
    description: "API publique pour piloter Cron Master avec des tokens scopés créés dans l'interface web.",
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "Cron Master API token",
      },
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          requiredScopes: { type: "array", items: { type: "string" } },
        },
      },
      Schedule: {
        oneOf: [
          { type: "object", required: ["mode", "value"], properties: { mode: { enum: ["every_minutes"] }, value: { type: "number", minimum: 1, maximum: 59 } } },
          { type: "object", required: ["mode"], properties: { mode: { enum: ["hourly"] }, value: { type: "number", minimum: 1, maximum: 23, default: 1 } } },
          { type: "object", required: ["mode"], properties: { mode: { enum: ["daily"] }, time: { type: "string", example: "09:00" } } },
          { type: "object", required: ["mode"], properties: { mode: { enum: ["weekly"] }, weekday: { type: "number", minimum: 0, maximum: 6 }, time: { type: "string", example: "09:00" } } },
          { type: "object", required: ["mode"], properties: { mode: { enum: ["monthly"] }, day: { type: "number", minimum: 1, maximum: 28 }, time: { type: "string", example: "09:00" } } },
          { type: "object", required: ["mode", "runAt"], properties: { mode: { enum: ["once"] }, runAt: { type: "string", format: "date-time" } } },
          { type: "object", required: ["mode", "expression"], properties: { mode: { enum: ["cron"] }, expression: { type: "string", example: "*/5 * * * *" } } },
        ],
      },
      JobInput: {
        type: "object",
        required: ["name", "type", "schedule"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          type: { enum: ["notification", "date_reminder", "website_check", "machine_check", "network_monitor", "script"] },
          schedule: { $ref: "#/components/schemas/Schedule" },
          timezone: { type: "string", default: "Europe/Paris" },
          enabled: { type: "boolean", default: true },
          config: { type: "object", additionalProperties: true },
        },
      },
      DeadmanInput: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          slug: { type: "string", pattern: "^[a-z0-9-]+$", description: "Optionnel. Si absent, Cron Master génère un slug secret." },
          expectedIntervalMinutes: { type: "number", minimum: 1, default: 60 },
          graceMinutes: { type: "number", minimum: 0, default: 10 },
          severity: { enum: ["info", "warning", "critical"], default: "critical" },
          reminderMinutes: { type: "number", minimum: 0, default: 0 },
          notifyOnMissing: { type: "boolean", default: true },
          notifyOnRecovery: { type: "boolean", default: true },
          enabled: { type: "boolean", default: true },
        },
      },
    },
  },
  paths: {
    "/api/v1/health": {
      get: operation("Vérifier le token et la disponibilité API", [], {
        responses: {
          "200": { description: "API disponible", content: json({ type: "object", properties: { ok: { type: "boolean" }, version: { type: "string" } } }) },
          ...authErrors,
        },
      }),
    },
    "/api/v1/openapi.json": { get: operation("Lire cette description OpenAPI", []) },
    "/api/v1/dashboard": { get: operation("Lire le résumé opérationnel", ["status:read"]) },
    "/api/v1/status": { get: operation("Lire le status JSON public", ["status:read"]) },
    "/api/v1/templates": { get: operation("Lister les templates de jobs", ["jobs:read"]) },
    "/api/v1/jobs": {
      get: operation("Lister les jobs", ["jobs:read"], {
        parameters: [{ name: "limit", in: "query" }, { name: "offset", in: "query" }],
      }),
      post: operation("Créer un job", ["jobs:write"], {
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/JobInput" }) },
        responses: { "201": { description: "Job créé" }, ...authErrors, "400": errorResponse },
      }),
    },
    "/api/v1/jobs/test": {
      post: operation("Exécuter un payload de job sans sauvegarde", ["jobs:run"], {
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/JobInput" }) },
      }),
    },
    "/api/v1/jobs/{id}": {
      get: operation("Lire un job", ["jobs:read"]),
      put: operation("Remplacer un job", ["jobs:write"], {
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/JobInput" }) },
      }),
      delete: operation("Supprimer un job", ["jobs:write"], { responses: { "204": { description: "Supprimé" }, ...authErrors } }),
    },
    "/api/v1/jobs/{id}/duplicate": { post: operation("Dupliquer un job en pause", ["jobs:write"]) },
    "/api/v1/jobs/{id}/pause": { post: operation("Mettre un job en pause", ["jobs:write"]) },
    "/api/v1/jobs/{id}/resume": { post: operation("Reprendre un job", ["jobs:write"]) },
    "/api/v1/jobs/{id}/run": { post: operation("Lancer un job maintenant", ["jobs:run"]) },
    "/api/v1/jobs/{id}/webhook": { post: operation("Déclencher un job par webhook avec signature HMAC optionnelle", ["jobs:run"]) },
    "/api/v1/jobs/{id}/runs": { get: operation("Lister les runs d'un job", ["jobs:read"]) },
    "/api/v1/stats/runs": { get: operation("Lire les statistiques journalières de runs", ["status:read"]) },
    "/api/v1/deadman": {
      post: operation("Créer un dead-man switch", ["deadman:write"], {
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/DeadmanInput" }) },
        responses: { "201": { description: "Dead-man créé" }, ...authErrors, "400": errorResponse },
      }),
    },
    "/api/v1/deadman/{slug}/ping": { post: operation("Ping d'un dead-man switch", ["deadman:write"]) },
  },
};
