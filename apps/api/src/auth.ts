import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { NextFunction, Request, Response, Router } from "express";
import { z } from "zod";
import { pool } from "./db.js";

const scrypt = promisify(scryptCallback);
const sessionCookieName = "cron_master_session";
const sessionTtlDays = 30;

const authInputSchema = z.object({
  email: z.string().trim().email("Email invalide").transform((email) => email.toLowerCase()),
  password: z.string().min(8, "Le mot de passe doit contenir au moins 8 caracteres").max(256),
});

type AdminUser = {
  id: string;
  email: string;
};

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

export async function ensureAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions(expires_at);
  `);
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
}

async function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function authErrorMessage(error: unknown) {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? "Identifiants invalides";
  }
  return null;
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header: string | undefined) {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

function setSessionCookie(res: Response, token: string) {
  const maxAge = sessionTtlDays * 24 * 60 * 60;
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: maxAge * 1000,
    path: "/",
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

async function createSession(userId: string, res: Response) {
  const token = randomBytes(32).toString("base64url");
  await pool.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
  await pool.query(
    `INSERT INTO admin_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3::int * interval '1 day'))`,
    [userId, hashToken(token), sessionTtlDays],
  );
  setSessionCookie(res, token);
}

async function createSessionWithClient(client: Pick<typeof pool, "query">, userId: string) {
  const token = randomBytes(32).toString("base64url");
  await client.query("DELETE FROM admin_sessions WHERE expires_at <= now()");
  await client.query(
    `INSERT INTO admin_sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3::int * interval '1 day'))`,
    [userId, hashToken(token), sessionTtlDays],
  );
  return token;
}

async function findUserFromRequest(req: Request) {
  const token = parseCookies(req.headers.cookie).get(sessionCookieName);
  if (!token) return null;
  const result = await pool.query<AdminUser>(
    `SELECT u.id, u.email
     FROM admin_sessions s
     JOIN admin_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()
     LIMIT 1`,
    [hashToken(token)],
  );
  return result.rows[0] ?? null;
}

async function adminCount() {
  const result = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM admin_users");
  return result.rows[0]?.count ?? 0;
}

async function createInitialAdminSession(email: string, passwordHash: string) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE admin_users IN EXCLUSIVE MODE");

    const existingAdmins = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM admin_users");
    if ((existingAdmins.rows[0]?.count ?? 0) > 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const result = await client.query<AdminUser>(
      "INSERT INTO admin_users (email, password_hash) VALUES ($1, $2) RETURNING id, email",
      [email, passwordHash],
    );
    const user = result.rows[0];
    const token = await createSessionWithClient(client, user.id);

    await client.query("COMMIT");
    return { user, token };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await findUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Connexion requise" });
    req.adminUser = user;
    next();
  } catch (error) {
    next(error);
  }
}

export const authRouter = Router();

authRouter.get("/setup-status", async (_req, res, next) => {
  try {
    res.json({ needsSetup: (await adminCount()) === 0 });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", async (req, res, next) => {
  try {
    const user = await findUserFromRequest(req);
    if (!user) return res.status(401).json({ error: "Connexion requise" });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const input = authInputSchema.parse(req.body);
    const passwordHash = await hashPassword(input.password);
    const session = await createInitialAdminSession(input.email, passwordHash);
    if (!session) return res.status(409).json({ error: "Un compte administrateur existe deja" });

    setSessionCookie(res, session.token);
    res.status(201).json({ user: session.user });
  } catch (error) {
    const message = authErrorMessage(error);
    if (message) return res.status(400).json({ error: message });
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const input = authInputSchema.parse(req.body);
    const result = await pool.query<AdminUser & { password_hash: string }>(
      "SELECT id, email, password_hash FROM admin_users WHERE email = $1",
      [input.email],
    );
    const user = result.rows[0];
    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }
    await createSession(user.id, res);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    const message = authErrorMessage(error);
    if (message) return res.status(400).json({ error: message });
    next(error);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie).get(sessionCookieName);
    if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [hashToken(token)]);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
