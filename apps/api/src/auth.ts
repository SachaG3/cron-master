import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import connectPgSimple from "connect-pg-simple";
import { NextFunction, Request, Response, Router } from "express";
import session from "express-session";
import { z } from "zod";
import { pool } from "./db.js";

const scrypt = promisify(scryptCallback);
const PgSessionStore = connectPgSimple(session);
const sessionCookieName = "cron_master_session";
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;

const credentialsSchema = z.object({
  email: z.string().trim().email("Email invalide").transform((email) => email.toLowerCase()),
  password: z.string().min(8, "Le mot de passe doit contenir au moins 8 caracteres").max(256),
});

type AdminUser = {
  id: string;
  email: string;
};

declare module "express-session" {
  interface SessionData {
    adminUserId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      adminUser?: AdminUser;
    }
  }
}

export const sessionMiddleware = session({
  name: sessionCookieName,
  secret: process.env.SESSION_SECRET ?? "cron-master-dev-session-secret-change-me",
  resave: false,
  saveUninitialized: false,
  store: new PgSessionStore({
    pool,
    tableName: "session",
    createTableIfMissing: true,
  }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.SESSION_COOKIE_SECURE === "true",
    maxAge: sessionTtlMs,
    path: "/",
  },
});

export async function ensureAuthTables() {
  await pool.query(`
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

function validationMessage(error: unknown) {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Identifiants invalides";
  return null;
}

function saveSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function destroySession(req: Request) {
  return new Promise<void>((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
}

async function signIn(req: Request, userId: string) {
  await regenerateSession(req);
  req.session.adminUserId = userId;
  await saveSession(req);
}

async function findUserById(id: string) {
  const result = await pool.query<AdminUser>("SELECT id, email FROM admin_users WHERE id = $1 LIMIT 1", [id]);
  return result.rows[0] ?? null;
}

async function findUserByEmail(email: string) {
  const result = await pool.query<AdminUser & { password_hash: string }>("SELECT id, email, password_hash FROM admin_users WHERE email = $1 LIMIT 1", [email]);
  return result.rows[0] ?? null;
}

async function adminCount() {
  const result = await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM admin_users");
  return result.rows[0]?.count ?? 0;
}

async function createInitialAdmin(email: string, passwordHash: string) {
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
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function requireAdminSession(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.session.adminUserId;
    const user = userId ? await findUserById(userId) : null;

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
    const userId = req.session.adminUserId;
    const user = userId ? await findUserById(userId) : null;

    if (!user) return res.status(401).json({ error: "Connexion requise" });

    res.json({ user });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const input = credentialsSchema.parse(req.body);
    const user = await createInitialAdmin(input.email, await hashPassword(input.password));

    if (!user) return res.status(409).json({ error: "Un compte administrateur existe deja" });

    try {
      await signIn(req, user.id);
    } catch (error) {
      await pool.query("DELETE FROM admin_users WHERE id = $1", [user.id]).catch(() => undefined);
      throw error;
    }

    res.status(201).json({ user });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return res.status(400).json({ error: message });
    next(error);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const input = credentialsSchema.parse(req.body);
    const user = await findUserByEmail(input.email);

    if (!user || !(await verifyPassword(input.password, user.password_hash))) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    await signIn(req, user.id);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    const message = validationMessage(error);
    if (message) return res.status(400).json({ error: message });
    next(error);
  }
});

authRouter.post("/logout", async (req, res, next) => {
  try {
    await destroySession(req);
    res.clearCookie(sessionCookieName, { path: "/" });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
