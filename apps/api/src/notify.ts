import nodemailer from "nodemailer";

type NotifyConfig = {
  message?: string;
  discordWebhookUrl?: string;
  slackWebhookUrl?: string;
  ntfyServer?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  gotifyUrl?: string;
  gotifyToken?: string;
  webhookUrl?: string;
  emailSmtpUrl?: string;
  emailFrom?: string;
  emailTo?: string;
};

const notificationTimeoutMs = 10000;

export function renderTemplate(value: string, context: Record<string, string>) {
  return Object.entries(context).reduce((text, [key, replacement]) => {
    return text.replaceAll(`$${key}`, replacement);
  }, value);
}

function assertHttpUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Seules les URLs HTTP/HTTPS sont autorisees");
  }
  return url;
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  assertHttpUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), notificationTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendNotifications(config: NotifyConfig, message: string) {
  const deliveries: Array<{ target: string; ok: boolean; status?: number; error?: string }> = [];

  if (config.discordWebhookUrl) {
    try {
      const response = await fetchWithTimeout(config.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      deliveries.push({ target: "discord", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "discord", ok: false, error: String(error) });
    }
  }

  if (config.slackWebhookUrl) {
    try {
      const response = await fetchWithTimeout(config.slackWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      deliveries.push({ target: "slack", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "slack", ok: false, error: String(error) });
    }
  }

  if (config.ntfyTopic) {
    try {
      const server = (config.ntfyServer || process.env.DEFAULT_NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
      const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
      if (config.ntfyToken) {
        headers.authorization = `Bearer ${config.ntfyToken}`;
      }

      const response = await fetchWithTimeout(`${server}/${encodeURIComponent(config.ntfyTopic)}`, {
        method: "POST",
        headers,
        body: message,
      });
      deliveries.push({ target: "ntfy", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "ntfy", ok: false, error: String(error) });
    }
  }

  if (config.telegramBotToken && config.telegramChatId) {
    try {
      const response = await fetchWithTimeout(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegramChatId, text: message }),
      });
      deliveries.push({ target: "telegram", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "telegram", ok: false, error: String(error) });
    }
  }

  if (config.gotifyUrl && config.gotifyToken) {
    try {
      const response = await fetchWithTimeout(`${config.gotifyUrl.replace(/\/$/, "")}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-gotify-key": config.gotifyToken },
        body: JSON.stringify({ title: "Cron Master", message }),
      });
      deliveries.push({ target: "gotify", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "gotify", ok: false, error: String(error) });
    }
  }

  if (config.webhookUrl) {
    try {
      const response = await fetchWithTimeout(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, source: "cron-master", sentAt: new Date().toISOString() }),
      });
      deliveries.push({ target: "webhook", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "webhook", ok: false, error: String(error) });
    }
  }

  if (config.emailSmtpUrl && config.emailFrom && config.emailTo) {
    try {
      const transport = nodemailer.createTransport(config.emailSmtpUrl);
      await transport.sendMail({
        from: config.emailFrom,
        to: config.emailTo,
        subject: "Cron Master",
        text: message,
      });
      deliveries.push({ target: "email", ok: true });
    } catch (error) {
      deliveries.push({ target: "email", ok: false, error: String(error) });
    }
  }

  return deliveries;
}
