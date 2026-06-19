import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderTemplate, sendNotifications } from "./notify.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("renderTemplate replaces known variables and leaves unknown variables intact", () => {
  const rendered = renderTemplate("$JOB_NAME finished at $NOW with $UNKNOWN", {
    JOB_NAME: "Backup",
    NOW: "2026-06-19T10:00:00.000Z",
  });

  assert.equal(rendered, "Backup finished at 2026-06-19T10:00:00.000Z with $UNKNOWN");
});

test("sendNotifications returns no deliveries when no target is configured", async () => {
  const deliveries = await sendNotifications({}, "hello");

  assert.deepEqual(deliveries, []);
});

test("sendNotifications posts to Discord and ntfy targets", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const deliveries = await sendNotifications(
    {
      discordWebhookUrl: "https://discord.example/webhook",
      ntfyServer: "https://ntfy.example/",
      ntfyTopic: "ops alerts",
      ntfyToken: "secret",
    },
    "Service restored",
  );

  assert.deepEqual(deliveries, [
    { target: "discord", ok: true, status: 204 },
    { target: "ntfy", ok: true, status: 204 },
  ]);
  assert.equal(calls[0].url, "https://discord.example/webhook");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ content: "Service restored" }));
  assert.equal(calls[1].url, "https://ntfy.example/ops%20alerts");
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer secret");
});
