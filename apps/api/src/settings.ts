import { z } from "zod";
import { pool } from "./db.js";

export const notificationSettingsSchema = z.object({
  discordWebhookUrl: z.string().optional().default(""),
  ntfyServer: z.string().optional().default("https://ntfy.sh"),
  ntfyTopic: z.string().optional().default(""),
  ntfyToken: z.string().optional().default(""),
  notifyOnSuccess: z.boolean().optional().default(false),
  notifyOnFailure: z.boolean().optional().default(true),
});

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export async function ensureSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('notifications', '{}'::jsonb)
    ON CONFLICT (key) DO NOTHING
  `);
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const result = await pool.query("SELECT value FROM app_settings WHERE key = 'notifications'");
  return notificationSettingsSchema.parse(result.rows[0]?.value ?? {});
}

export async function updateNotificationSettings(input: NotificationSettings) {
  const settings = notificationSettingsSchema.parse(input);
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('notifications', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [settings],
  );
  return settings;
}
