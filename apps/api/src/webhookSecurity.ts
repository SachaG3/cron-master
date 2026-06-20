import { createHmac, timingSafeEqual } from "node:crypto";
import { Request } from "express";
import { Job } from "./db.js";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

function signatureFromHeader(value: unknown) {
  if (typeof value !== "string") return "";
  return value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
}

export function verifyWebhookSignature(req: Request, job: Job) {
  const secret = typeof job.config.webhookSecret === "string" ? job.config.webhookSecret : "";
  if (!secret) return true;

  const provided = Buffer.from(signatureFromHeader(req.headers["x-cron-master-signature"]), "hex");
  const payload = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("hex"), "hex");

  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
