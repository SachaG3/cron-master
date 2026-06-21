import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { pool } from "./db.js";

export const publicApiScopes = [
  "status:read",
  "jobs:read",
  "jobs:write",
  "jobs:run",
  "deadman:read",
  "deadman:write",
] as const;

export type PublicApiNamedScope = (typeof publicApiScopes)[number];
export type PublicApiScope = PublicApiNamedScope | "*";

export const publicApiProbeTargets = [
  {
    id: "health",
    label: "Disponibilite API",
    method: "GET",
    path: "/api/v1/health",
    requiredScopes: [],
    liveSafe: true,
    destructive: false,
  },
  {
    id: "me",
    label: "Introspection token",
    method: "GET",
    path: "/api/v1/me",
    requiredScopes: [],
    liveSafe: true,
    destructive: false,
  },
  {
    id: "status",
    label: "Status public",
    method: "GET",
    path: "/api/v1/status",
    requiredScopes: ["status:read"],
    liveSafe: true,
    destructive: false,
  },
  {
    id: "jobs-read",
    label: "Lecture jobs",
    method: "GET",
    path: "/api/v1/jobs?limit=1",
    requiredScopes: ["jobs:read"],
    liveSafe: true,
    destructive: false,
  },
  {
    id: "jobs-write",
    label: "Ecriture jobs",
    method: "POST",
    path: "/api/v1/jobs",
    requiredScopes: ["jobs:write"],
    liveSafe: false,
    destructive: true,
  },
  {
    id: "jobs-run",
    label: "Execution jobs",
    method: "POST",
    path: "/api/v1/jobs/test",
    requiredScopes: ["jobs:run"],
    liveSafe: false,
    destructive: false,
  },
  {
    id: "deadman-read",
    label: "Lecture dead-man",
    method: "GET",
    path: "/api/v1/deadman",
    requiredScopes: ["deadman:read"],
    liveSafe: true,
    destructive: false,
  },
  {
    id: "deadman-write",
    label: "Ecriture dead-man",
    method: "POST",
    path: "/api/v1/deadman",
    requiredScopes: ["deadman:write"],
    liveSafe: false,
    destructive: true,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  method: string;
  path: string;
  requiredScopes: readonly PublicApiNamedScope[];
  liveSafe: boolean;
  destructive: boolean;
}>;

type ApiTokenRow = {
  id: string;
  name: string;
  description: string;
  token_prefix: string;
  last_four: string;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
  last_used_ip: string | null;
  last_used_user_agent: string | null;
  usage_count: number;
  expires_at: Date | null;
  revoked_at: Date | null;
};

const apiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(""),
  scopes: z.array(z.enum(publicApiScopes)).min(1).optional().default(["status:read", "jobs:read"]),
  expiresAt: z.string().datetime().refine((value) => new Date(value).getTime() > Date.now(), "Expiration dans le futur requise").optional().nullable(),
});

const apiTokenUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  scopes: z.array(z.enum(publicApiScopes)).min(1).optional(),
  expiresAt: z.string().datetime().refine((value) => new Date(value).getTime() > Date.now(), "Expiration dans le futur requise").optional().nullable(),
});

declare global {
  namespace Express {
    interface Request {
      publicApiToken?: {
        id: string | null;
        name: string;
        scopes: PublicApiScope[];
        legacy: boolean;
      };
    }
  }
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function generateTokenValue() {
  return `cm_live_${randomBytes(32).toString("base64url")}`;
}

function safeEqualString(a: string, b: string) {
  const left = Buffer.from(hashToken(a), "hex");
  const right = Buffer.from(hashToken(b), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function rowToApiToken(row: ApiTokenRow) {
  const expired = row.expires_at ? row.expires_at.getTime() <= Date.now() : false;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tokenPrefix: row.token_prefix,
    lastFour: row.last_four,
    scopes: row.scopes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    lastUsedUserAgent: row.last_used_user_agent,
    usageCount: row.usage_count,
    expiresAt: row.expires_at,
    expired,
    revokedAt: row.revoked_at,
  };
}

function tokenFromRequest(req: Request) {
  const auth = req.headers.authorization;
  const headerKey = req.headers["x-api-key"];
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  if (typeof headerKey === "string") return headerKey.trim();
  if (Array.isArray(headerKey)) return headerKey[0]?.trim() ?? "";
  return "";
}

function hasScopes(actual: PublicApiScope[], required: PublicApiScope[]) {
  if (actual.includes("*")) return true;
  return required.every((scope) => actual.includes(scope));
}

export async function listApiTokens() {
  const result = await pool.query<ApiTokenRow>(
    `SELECT id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
            last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at
     FROM api_tokens
     ORDER BY created_at DESC`,
  );

  return {
    tokens: result.rows.map(rowToApiToken),
    availableScopes: publicApiScopes,
    legacyEnabled: Boolean(process.env.CRON_MASTER_API_KEY),
  };
}

export async function createApiToken(input: unknown) {
  const parsed = apiTokenInputSchema.parse(input);
  const token = generateTokenValue();
  const result = await pool.query<ApiTokenRow>(
    `INSERT INTO api_tokens (name, description, token_hash, token_prefix, last_four, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
               last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at`,
    [parsed.name, parsed.description, hashToken(token), token.slice(0, 16), token.slice(-4), JSON.stringify(parsed.scopes), parsed.expiresAt ?? null],
  );

  return {
    token,
    apiToken: rowToApiToken(result.rows[0]),
  };
}

export async function updateApiToken(id: string, input: unknown) {
  const current = await pool.query<ApiTokenRow>(
    `SELECT id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
            last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at
     FROM api_tokens
     WHERE id = $1`,
    [id],
  );
  const row = current.rows[0];
  if (!row) return null;

  const parsed = apiTokenUpdateSchema.parse(input);
  const result = await pool.query<ApiTokenRow>(
    `UPDATE api_tokens
     SET name = $1,
         description = $2,
         scopes = $3::jsonb,
         expires_at = $4,
         updated_at = now()
     WHERE id = $5
     RETURNING id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
               last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at`,
    [
      parsed.name ?? row.name,
      parsed.description ?? row.description,
      JSON.stringify(parsed.scopes ?? row.scopes),
      parsed.expiresAt === undefined ? row.expires_at : parsed.expiresAt,
      id,
    ],
  );
  return result.rows[0] ? rowToApiToken(result.rows[0]) : null;
}

export async function rotateApiToken(id: string) {
  const token = generateTokenValue();
  const result = await pool.query<ApiTokenRow>(
    `UPDATE api_tokens
     SET token_hash = $1,
         token_prefix = $2,
         last_four = $3,
         last_used_at = NULL,
         last_used_ip = NULL,
         last_used_user_agent = NULL,
         usage_count = 0,
         revoked_at = NULL,
         updated_at = now()
     WHERE id = $4
     RETURNING id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
               last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at`,
    [hashToken(token), token.slice(0, 16), token.slice(-4), id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { token, apiToken: rowToApiToken(row) };
}

export async function revokeApiToken(id: string) {
  const result = await pool.query<ApiTokenRow>(
    `UPDATE api_tokens
     SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
     WHERE id = $1
     RETURNING id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
               last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at`,
    [id],
  );
  return result.rows[0] ? rowToApiToken(result.rows[0]) : null;
}

function statusForReason(reason: string) {
  return reason === "scope" ? 403 : reason === "ok" ? 200 : 401;
}

function messageForReason(reason: string, destructive = false) {
  if (reason === "ok") return destructive ? "Scope valide, appel reel non lance pour eviter une modification." : "Autorise";
  if (reason === "scope") return "Scope manquant";
  if (reason === "expired") return "Token expire";
  if (reason === "missing") return "Token absent";
  return "Token invalide";
}

export async function verifyApiTokenValue(
  token: string,
  requiredScopes: PublicApiScope[] = [],
  context: { ip?: string; userAgent?: string; recordUsage?: boolean } = {},
) {
  const configuredKey = process.env.CRON_MASTER_API_KEY;
  if (configuredKey && safeEqualString(token, configuredKey)) {
    return {
      ok: hasScopes(["*"], requiredScopes),
      token: { id: null, name: "CRON_MASTER_API_KEY", scopes: ["*" as PublicApiScope], legacy: true },
      reason: "ok",
    };
  }

  if (!token) {
    return { ok: false, token: null, reason: "missing" };
  }

  const result = await pool.query<ApiTokenRow>(
    `SELECT id, name, description, token_prefix, last_four, scopes, created_at, updated_at,
            last_used_at, last_used_ip, last_used_user_agent, usage_count, expires_at, revoked_at
     FROM api_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
     LIMIT 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, token: null, reason: "invalid" };
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
    return { ok: false, token: { id: row.id, name: row.name, scopes: row.scopes as PublicApiScope[], legacy: false }, reason: "expired" };
  }

  const scopes = row.scopes as PublicApiScope[];
  if (!hasScopes(scopes, requiredScopes)) {
    return { ok: false, token: { id: row.id, name: row.name, scopes, legacy: false }, reason: "scope" };
  }

  if (context.recordUsage !== false) {
    await pool.query(
      `UPDATE api_tokens
       SET last_used_at = now(),
           last_used_ip = $2,
           last_used_user_agent = $3,
           usage_count = usage_count + 1,
           updated_at = now()
       WHERE id = $1`,
      [row.id, context.ip ?? null, context.userAgent?.slice(0, 500) ?? null],
    );
  }
  return { ok: true, token: { id: row.id, name: row.name, scopes, legacy: false }, reason: "ok" };
}

export function requirePublicApiToken(requiredScopes: PublicApiScope[] = []) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const verification = await verifyApiTokenValue(tokenFromRequest(req), requiredScopes, {
        ip: req.ip,
        userAgent: req.headers["user-agent"],
      });
      if (!verification.ok) {
        const status = verification.reason === "scope" ? 403 : 401;
        const error =
          verification.reason === "scope"
            ? "Permission API insuffisante"
            : verification.reason === "expired"
              ? "API token expire"
              : "API token manquant ou invalide";
        return res.status(status).json({ error, reason: verification.reason, requiredScopes });
      }

      if (!verification.token) return res.status(401).json({ error: "API token manquant ou invalide", requiredScopes });
      req.publicApiToken = verification.token;
      next();
    } catch (error) {
      next(error);
    }
  };
}

export async function testApiToken(input: unknown) {
  const parsed = z.object({ token: z.string().min(1), scopes: z.array(z.enum(publicApiScopes)).optional().default([]) }).parse(input);
  const verification = await verifyApiTokenValue(parsed.token, parsed.scopes, { recordUsage: false });
  const selectedScopes = new Set(parsed.scopes);
  const targets = publicApiProbeTargets.filter((target) => {
    return target.requiredScopes.length === 0 || parsed.scopes.length === 0 || target.requiredScopes.some((scope) => selectedScopes.has(scope));
  });
  const probes = await Promise.all(targets.map(async (target) => {
    const probe = await verifyApiTokenValue(parsed.token, [...target.requiredScopes], { recordUsage: false });
    return {
      id: target.id,
      label: target.label,
      method: target.method,
      path: target.path,
      requiredScopes: target.requiredScopes,
      liveSafe: target.liveSafe,
      destructive: target.destructive,
      ok: probe.ok,
      reason: probe.reason,
      status: statusForReason(probe.reason),
      message: messageForReason(probe.reason, target.destructive),
    };
  }));
  return {
    ok: verification.ok,
    reason: verification.reason,
    token: verification.token,
    requestedScopes: parsed.scopes,
    probes,
    availableScopes: publicApiScopes,
  };
}
