type NotifyConfig = {
  message?: string;
  discordWebhookUrl?: string;
  ntfyServer?: string;
  ntfyTopic?: string;
  ntfyToken?: string;
};

export function renderTemplate(value: string, context: Record<string, string>) {
  return Object.entries(context).reduce((text, [key, replacement]) => {
    return text.replaceAll(`$${key}`, replacement);
  }, value);
}

export async function sendNotifications(config: NotifyConfig, message: string) {
  const deliveries: Array<{ target: string; ok: boolean; status?: number; error?: string }> = [];

  if (config.discordWebhookUrl) {
    try {
      const response = await fetch(config.discordWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
      deliveries.push({ target: "discord", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "discord", ok: false, error: String(error) });
    }
  }

  if (config.ntfyTopic) {
    try {
      const server = (config.ntfyServer || process.env.DEFAULT_NTFY_SERVER || "https://ntfy.sh").replace(/\/$/, "");
      const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
      if (config.ntfyToken) {
        headers.authorization = `Bearer ${config.ntfyToken}`;
      }

      const response = await fetch(`${server}/${encodeURIComponent(config.ntfyTopic)}`, {
        method: "POST",
        headers,
        body: message,
      });
      deliveries.push({ target: "ntfy", ok: response.ok, status: response.status });
    } catch (error) {
      deliveries.push({ target: "ntfy", ok: false, error: String(error) });
    }
  }

  return deliveries;
}
