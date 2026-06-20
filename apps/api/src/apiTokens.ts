import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { pool } from "./db.js";

export const publicApiScopes = [
  "status:read",
  "jobs:read",
  "jobs:write",
  "jobs:run",
  "deadman:write",
] as const;

export type PublicApiScope = (typeof publicApiScopes)[number] | "*";

type ApiTokenRow = {
  id: string;
  name: string;
  description: string;
  token_prefix: string;
  last_four: string;
  scopes: string[];
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

const apiTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().default(""),
  scopes: z.array(z.enum(publicApiScopes)).min(1).optional().default(["status:read", "jobs:read"]),
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

function safeEqualString(a: string, b: string) {
  const left = Buffer.from(hashToken(a), "hex");
  const right = Buffer.from(hashToken(b), "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function rowToApiToken(row: ApiTokenRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tokenPrefix: row.token_prefix,
    lastFour: row.last_four,
    scopes: row.scopes,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

function tokenFromRequest(req: Request) {
  const auth = req.headers.authorization;
  const headerKey = req.headers["x-api-key"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (typeof headerKey === "string") return headerKey.trim();
  return "";
}

function hasScopes(actual: PublicApiScope[], required: PublicApiScope[]) {
  if (actual.includes("*")) return true;
  return required.every((scope) => actual.includes(scope));
}

export async function listApiTokens() {
  const result = await pool.query<ApiTokenRow>(
    `SELECT id, name, description, token_prefix, last_four, scopes, created_at, last_used_at, revoked_at
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
  const token = `cm_${randomBytes(32).toString("base64url")}`;
  const result = await pool.query<ApiTokenRow>(
    `INSERT INTO api_tokens (name, description, token_hash, token_prefix, last_four, scopes)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, name, description, token_prefix, last_four, scopes, created_at, last_used_at, revoked_at`,
    [parsed.name, parsed.description, hashToken(token), token.slice(0, 10), token.slice(-4), JSON.stringify(parsed.scopes)],
  );

  return {
    token,
    apiToken: rowToApiToken(result.rows[0]),
  };
}

export async function revokeApiToken(id: string) {
  const result = await pool.query<ApiTokenRow>(
    `UPDATE api_tokens
     SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1
     RETURNING id, name, description, token_prefix, last_four, scopes, created_at, last_used_at, revoked_at`,
    [id],
  );
  return result.rows[0] ? rowToApiToken(result.rows[0]) : null;
}

export async function verifyApiTokenValue(token: string, requiredScopes: PublicApiScope[] = []) {
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
    `SELECT id, name, description, token_prefix, last_four, scopes, created_at, last_used_at, revoked_at
     FROM api_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
     LIMIT 1`,
    [hashToken(token)],
  );
  const row = result.rows[0];
  if (!row) return { ok: false, token: null, reason: "invalid" };

  const scopes = row.scopes as PublicApiScope[];
  if (!hasScopes(scopes, requiredScopes)) {
    return { ok: false, token: { id: row.id, name: row.name, scopes, legacy: false }, reason: "scope" };
  }

  await pool.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
  return { ok: true, token: { id: row.id, name: row.name, scopes, legacy: false }, reason: "ok" };
}

export function requirePublicApiToken(requiredScopes: PublicApiScope[] = []) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const verification = await verifyApiTokenValue(tokenFromRequest(req), requiredScopes);
      if (!verification.ok) {
        const status = verification.reason === "scope" ? 403 : 401;
        const error = verification.reason === "scope" ? "Permission API insuffisante" : "API token manquant ou invalide";
        return res.status(status).json({ error, requiredScopes });
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
  const parsed = z.object({ token: z.string().min(1) }).parse(input);
  const verification = await verifyApiTokenValue(parsed.token);
  return {
    ok: verification.ok,
    reason: verification.reason,
    token: verification.token,
    availableScopes: publicApiScopes,
  };
}
