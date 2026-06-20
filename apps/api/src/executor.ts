import net from "node:net";
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { promisify } from "node:util";
import { Job } from "./db.js";
import { getCredentialValue } from "./features.js";
import { renderTemplate, sendNotifications } from "./notify.js";
import { patchRuntimeState } from "./runtimeState.js";
import { getNotificationSettings } from "./settings.js";

const execFileAsync = promisify(execFile);
const blockPrivateTargets = process.env.CRON_MASTER_BLOCK_PRIVATE_TARGETS === "true";

type ExecutionResult = {
  status: "success" | "failure";
  message: string;
  output: Record<string, unknown>;
};

function contextFor(job: Job) {
  return {
    JOB_NAME: job.name,
    NOW: new Date().toISOString(),
    SEVERITY: typeof job.config.severity === "string" ? job.config.severity : "warning",
  };
}

function stringConfig(config: Record<string, unknown>, key: string, fallback = "") {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number) {
  const value = config[key];
  return typeof value === "number" ? value : fallback;
}

function booleanConfig(config: Record<string, unknown>, key: string, fallback: boolean) {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

async function withNotificationSettings(config: Record<string, unknown>) {
  const credentialConfig = typeof config.credentialId === "string" ? await getCredentialValue(config.credentialId) : {};
  const configured = { ...credentialConfig, ...config };
  if (config.useGlobalNotifications === false) {
    return configured;
  }

  const settings = await getNotificationSettings();
  return {
    ...settings,
    ...configured,
    discordWebhookUrl: stringConfig(configured, "discordWebhookUrl", settings.discordWebhookUrl),
    slackWebhookUrl: stringConfig(configured, "slackWebhookUrl", settings.slackWebhookUrl),
    ntfyServer: stringConfig(configured, "ntfyServer", settings.ntfyServer),
    ntfyTopic: stringConfig(configured, "ntfyTopic", settings.ntfyTopic),
    ntfyToken: stringConfig(configured, "ntfyToken", settings.ntfyToken),
    telegramBotToken: stringConfig(configured, "telegramBotToken", settings.telegramBotToken),
    telegramChatId: stringConfig(configured, "telegramChatId", settings.telegramChatId),
    gotifyUrl: stringConfig(configured, "gotifyUrl", settings.gotifyUrl),
    gotifyToken: stringConfig(configured, "gotifyToken", settings.gotifyToken),
    webhookUrl: stringConfig(configured, "webhookUrl", settings.webhookUrl),
    emailSmtpUrl: stringConfig(configured, "emailSmtpUrl", settings.emailSmtpUrl),
    emailFrom: stringConfig(configured, "emailFrom", settings.emailFrom),
    emailTo: stringConfig(configured, "emailTo", settings.emailTo),
    notifyOnSuccess: booleanConfig(configured, "notifyOnSuccess", settings.notifyOnSuccess),
    notifyOnFailure: booleanConfig(configured, "notifyOnFailure", settings.notifyOnFailure),
  };
}

async function checkHttp(url: string, expectedStatus: number, timeoutMs = 10000) {
  await assertAllowedUrl(url);
  return fetchWithTimeout(url, { method: "GET" }, timeoutMs).then((response) => ({
    ok: response.status === expectedStatus,
    status: response.status,
    durationMs: response.durationMs,
  }));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return { response, status: response.status, ok: response.ok, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

function isPrivateAddress(address: string) {
  if (net.isIPv4(address)) {
    const parts = address.split(".").map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254) ||
      address === "0.0.0.0"
    );
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80") || normalized === "::";
}

async function assertAllowedHost(host: string) {
  if (!host.trim()) throw new Error("Cible reseau manquante");
  if (!blockPrivateTargets) return;
  const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error(`Cible reseau privee refusee: ${host}`);
  }
}

async function assertAllowedUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Seules les URLs HTTP/HTTPS sont autorisees");
  }
  await assertAllowedHost(url.hostname);
}

async function checkTcp(host: string, port: number, timeoutMs = 5000) {
  await assertAllowedHost(host);
  return new Promise<{ ok: boolean; durationMs: number; error?: string }>((resolve) => {
    const started = Date.now();
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ ok: true, durationMs: Date.now() - started });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, durationMs: Date.now() - started, error: "timeout" });
    });
    socket.once("error", (error) => {
      resolve({ ok: false, durationMs: Date.now() - started, error: error.message });
    });
  });
}

async function pingHost(host: string, timeoutMs = 2000) {
  await assertAllowedHost(host);
  const started = Date.now();
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  try {
    await execFileAsync("ping", ["-c", "1", "-W", String(timeoutSeconds), host], { timeout: timeoutMs + 1000 });
    return { ok: true, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function getNetworkTargets(config: Record<string, unknown>) {
  const targets = config.targets;
  if (Array.isArray(targets)) {
    return targets
      .map((target) => {
        if (!target || typeof target !== "object") return null;
        const host = "host" in target && typeof target.host === "string" ? target.host.trim() : "";
        const label = "label" in target && typeof target.label === "string" ? target.label.trim() : host;
        return host ? { host, label: label || host } : null;
      })
      .filter((target): target is { host: string; label: string } => Boolean(target));
  }

  const hosts = stringConfig(config, "hosts");
  return hosts
    .split(/\r?\n|,/)
    .map((host) => host.trim())
    .filter(Boolean)
    .map((host) => ({ host, label: host }));
}

async function runNetworkMonitor(job: Job, notifyConfig: Record<string, unknown>): Promise<ExecutionResult> {
  const targets = getNetworkTargets(job.config);
  if (targets.length === 0) throw new Error("Aucune cible reseau configuree");

  const timeoutMs = numberConfig(job.config, "timeoutMs", 2000);
  const minOnline = Math.max(1, Math.min(targets.length, numberConfig(job.config, "minOnline", 1)));
  const failureThreshold = Math.max(1, Math.min(20, numberConfig(job.config, "failureThreshold", 1)));
  const recoveryThreshold = Math.max(1, Math.min(20, numberConfig(job.config, "recoveryThreshold", 1)));
  const reminderMinutes = Math.max(0, Math.min(1440, numberConfig(job.config, "reminderMinutes", 0)));
  const previousStatus = stringConfig(job.config, "networkStatus", "unknown");
  const previousOutageStartedAt = stringConfig(job.config, "outageStartedAt", "");
  const previousFailures = typeof job.config.networkConsecutiveFailures === "number" ? job.config.networkConsecutiveFailures : 0;
  const previousSuccesses = typeof job.config.networkConsecutiveSuccesses === "number" ? job.config.networkConsecutiveSuccesses : 0;
  const previousNotificationAt = stringConfig(job.config, "networkLastNotificationAt", "");
  const results = await Promise.all(targets.map(async (target) => ({ ...target, ...(await pingHost(target.host, timeoutMs)) })));
  const onlineCount = results.filter((result) => result.ok).length;
  const rawUp = onlineCount >= minOnline;
  const now = new Date();
  const consecutiveFailures = rawUp ? 0 : previousFailures + 1;
  const consecutiveSuccesses = rawUp ? previousSuccesses + 1 : 0;
  const confirmedDown = !rawUp && consecutiveFailures >= failureThreshold;
  const confirmedRecovery = rawUp && previousStatus === "down" && consecutiveSuccesses >= recoveryThreshold;

  let outageStartedAt = previousOutageStartedAt;
  let lastRecoveryDurationMs: number | null = typeof job.config.lastRecoveryDurationMs === "number" ? job.config.lastRecoveryDurationMs : null;
  let transition: "none" | "pending_down" | "down" | "pending_recovery" | "recovered" = "none";
  let nextStatus = previousStatus === "down" ? "down" : "up";
  let networkLastNotificationAt = previousNotificationAt || null;

  if (!rawUp && !confirmedDown && previousStatus !== "down") {
    transition = "pending_down";
    nextStatus = previousStatus === "unknown" ? "up" : previousStatus;
  }

  if (rawUp && previousStatus === "down" && !confirmedRecovery) {
    transition = "pending_recovery";
    nextStatus = "down";
  }

  if (confirmedDown && previousStatus !== "down") {
    transition = "down";
    outageStartedAt = now.toISOString();
    nextStatus = "down";
    if (booleanConfig(job.config, "notifyOnDown", false)) {
      await sendNotifications(notifyConfig, `${job.name}: reseau indisponible, timer demarre (${onlineCount}/${targets.length} repondent)`);
      networkLastNotificationAt = now.toISOString();
    }
  }

  if (confirmedRecovery) {
    transition = "recovered";
    const started = previousOutageStartedAt ? new Date(previousOutageStartedAt) : now;
    lastRecoveryDurationMs = now.getTime() - started.getTime();
    outageStartedAt = "";
    nextStatus = "up";
    if (booleanConfig(job.config, "notifyOnRecovery", true)) {
      await sendNotifications(notifyConfig, `${job.name}: reseau retabli apres ${formatDuration(lastRecoveryDurationMs)} (${onlineCount}/${targets.length} repondent)`);
      networkLastNotificationAt = now.toISOString();
    }
  }

  if (rawUp && previousStatus !== "down") {
    nextStatus = "up";
  }

  if (nextStatus === "down" && previousStatus === "down" && reminderMinutes > 0 && previousOutageStartedAt) {
    const lastNotificationMs = previousNotificationAt ? new Date(previousNotificationAt).getTime() : 0;
    const shouldRemind = !lastNotificationMs || now.getTime() - lastNotificationMs >= reminderMinutes * 60_000;
    if (shouldRemind) {
      await sendNotifications(notifyConfig, `${job.name}: reseau toujours indisponible depuis ${formatDuration(now.getTime() - new Date(previousOutageStartedAt).getTime())} (${onlineCount}/${targets.length} repondent)`);
      networkLastNotificationAt = now.toISOString();
    }
  }

  await patchRuntimeState(job.id, {
    networkStatus: nextStatus,
    outageStartedAt: outageStartedAt || null,
    lastCheckedAt: now.toISOString(),
    lastRecoveryDurationMs,
    lastNetworkResults: results,
    networkConsecutiveFailures: consecutiveFailures,
    networkConsecutiveSuccesses: consecutiveSuccesses,
    networkLastNotificationAt,
  });

  const okForOutcome = nextStatus !== "down";
  return {
    status: okForOutcome ? "success" : "failure",
    message: okForOutcome ? (transition === "recovered" ? `Reseau retabli apres ${formatDuration(lastRecoveryDurationMs ?? 0)}` : "Reseau disponible") : "Reseau indisponible",
    output: {
      targets,
      results,
      onlineCount,
      minOnline,
      failureThreshold,
      recoveryThreshold,
      reminderMinutes,
      previousStatus,
      rawStatus: rawUp ? "up" : "down",
      networkStatus: nextStatus,
      transition,
      outageStartedAt,
      lastRecoveryDurationMs,
      consecutiveFailures,
      consecutiveSuccesses,
    },
  };
}

function parseArgs(line: string) {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

async function runScript(job: Job): Promise<ExecutionResult> {
  const script = stringConfig(job.config, "script");
  const lines = script.split(/\r?\n/);
  const steps: unknown[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const [command = "", ...args] = parseArgs(line);
    if (command === "notify") {
      const message = renderTemplate(args.join(" "), contextFor(job));
      const deliveries = await sendNotifications(job.config, message);
      steps.push({ command, message, deliveries });
      continue;
    }

    if (command === "http") {
      const url = args[0];
      const expectedStatus = args[1] === "status" ? Number(args[2]) : 200;
      if (!url || Number.isNaN(expectedStatus)) throw new Error(`Commande http invalide: ${line}`);
      const result = await checkHttp(url, expectedStatus);
      steps.push({ command, url, expectedStatus, ...result });
      if (!result.ok) throw new Error(`HTTP ${url} a retourne ${result.status}, attendu ${expectedStatus}`);
      continue;
    }

    if (command === "tcp") {
      const host = args[0];
      const port = Number(args[1]);
      if (!host || Number.isNaN(port)) throw new Error(`Commande tcp invalide: ${line}`);
      const result = await checkTcp(host, port);
      steps.push({ command, host, port, ...result });
      if (!result.ok) throw new Error(`TCP ${host}:${port} indisponible`);
      continue;
    }

    if (command === "sleep") {
      const ms = Number(args[0]);
      if (Number.isNaN(ms) || ms < 0 || ms > 30000) throw new Error(`Commande sleep invalide: ${line}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      steps.push({ command, ms });
      continue;
    }

    if (command === "fail") {
      throw new Error(args.join(" ") || "Echec force par le script");
    }

    throw new Error(`Commande inconnue: ${command}`);
  }

  return { status: "success", message: "Script termine", output: { steps } };
}

type BlockStep =
  | { kind: "notify"; message?: string }
  | { kind: "http"; url?: string; expectedStatus?: number; maxResponseMs?: number }
  | { kind: "tcp"; host?: string; port?: number }
  | { kind: "wait"; seconds?: number }
  | { kind: "webhook"; url?: string; method?: string; body?: string }
  | { kind: "condition"; field?: string; operator?: string; value?: string; message?: string };

function getBlocks(job: Job): BlockStep[] {
  const blocks = job.config.blocks;
  return Array.isArray(blocks) ? (blocks as BlockStep[]) : [];
}

async function runBlocks(job: Job, notifyConfig: Record<string, unknown>): Promise<ExecutionResult> {
  const blocks = getBlocks(job);
  const steps: unknown[] = [];
  const variables: Record<string, string> = contextFor(job);

  for (const block of blocks) {
    if (block.kind === "notify") {
      const message = renderTemplate(block.message || `Notification: ${job.name}`, variables);
      const deliveries = await sendNotifications(notifyConfig, message);
      steps.push({ block: "notify", message, deliveries });
      continue;
    }

    if (block.kind === "http") {
      const expectedStatus = block.expectedStatus || 200;
      if (!block.url) throw new Error("Bloc site web incomplet");
      const result = await checkHttp(block.url, expectedStatus);
      variables.STATUS = String(result.status);
      variables.RESPONSE_TIME = String(result.durationMs);
      variables.URL = block.url;
      steps.push({ block: "http", url: block.url, expectedStatus, ...result });
      if (!result.ok) throw new Error(`Site web indisponible ou statut inattendu`);
      if (block.maxResponseMs && result.durationMs > block.maxResponseMs) {
        throw new Error(`Site trop lent (${result.durationMs}ms > ${block.maxResponseMs}ms)`);
      }
      continue;
    }

    if (block.kind === "tcp") {
      if (!block.host || !block.port) throw new Error("Bloc machine incomplet");
      const result = await checkTcp(block.host, block.port);
      variables.HOST = block.host;
      variables.PORT = String(block.port);
      variables.RESPONSE_TIME = String(result.durationMs);
      steps.push({ block: "tcp", host: block.host, port: block.port, ...result });
      if (!result.ok) throw new Error("Machine ou port indisponible");
      continue;
    }

    if (block.kind === "wait") {
      const seconds = Math.max(0, Math.min(30, block.seconds || 1));
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      steps.push({ block: "wait", seconds });
      continue;
    }

    if (block.kind === "webhook") {
      if (!block.url) throw new Error("Bloc webhook incomplet");
      await assertAllowedUrl(block.url);
      const { response } = await fetchWithTimeout(block.url, {
        method: block.method || "POST",
        headers: { "content-type": "application/json" },
        body: block.body ? renderTemplate(block.body, variables) : JSON.stringify({ job: job.name, at: variables.NOW }),
      }, 10000);
      steps.push({ block: "webhook", url: block.url, status: response.status, ok: response.ok });
      if (!response.ok) throw new Error(`Webhook retourne ${response.status}`);
      continue;
    }

    if (block.kind === "condition") {
      const actual = variables[block.field || "STATUS"] || "";
      const expected = block.value || "";
      const numericActual = Number(actual);
      const numericExpected = Number(expected);
      const ok =
        block.operator === "!="
          ? actual !== expected
          : block.operator === ">"
            ? numericActual > numericExpected
            : block.operator === "<"
              ? numericActual < numericExpected
              : block.operator === "contains"
                ? actual.includes(expected)
                : actual === expected;
      steps.push({ block: "condition", field: block.field, operator: block.operator || "=", expected, actual, ok });
      if (!ok) {
        throw new Error(renderTemplate(block.message || `Condition non respectee: ${block.field}`, variables));
      }
      continue;
    }
  }

  return { status: "success", message: "Blocs termines", output: { steps } };
}

export async function executeJob(job: Job): Promise<ExecutionResult> {
  try {
    const notifyConfig = await withNotificationSettings(job.config);
    if (job.type === "notification" || job.type === "date_reminder") {
      const message = renderTemplate(stringConfig(job.config, "message", job.name), contextFor(job));
      const deliveries = await sendNotifications(notifyConfig, message);
      const failed = deliveries.some((delivery) => !delivery.ok);
      return {
        status: failed ? "failure" : "success",
        message: failed ? "Notification partiellement echouee" : "Notification envoyee",
        output: { deliveries, message },
      };
    }

    if (job.type === "website_check") {
      const url = stringConfig(job.config, "url");
      const expectedStatus = numberConfig(job.config, "expectedStatus", 200);
      const result = await checkHttp(url, expectedStatus);
      if (!result.ok) {
        await sendNotifications(notifyConfig, `${job.name}: site en erreur (${result.status}, attendu ${expectedStatus})`);
      } else if (booleanConfig(notifyConfig, "notifyOnSuccess", false)) {
        await sendNotifications(notifyConfig, `${job.name}: site disponible (${result.status})`);
      }
      return {
        status: result.ok ? "success" : "failure",
        message: result.ok ? "Site disponible" : "Statut HTTP inattendu",
        output: { url, expectedStatus, ...result },
      };
    }

    if (job.type === "machine_check") {
      const host = stringConfig(job.config, "host");
      const port = numberConfig(job.config, "port", 22);
      const result = await checkTcp(host, port);
      if (!result.ok) {
        await sendNotifications(notifyConfig, `${job.name}: machine indisponible (${host}:${port})`);
      } else if (booleanConfig(notifyConfig, "notifyOnSuccess", false)) {
        await sendNotifications(notifyConfig, `${job.name}: machine disponible (${host}:${port})`);
      }
      return {
        status: result.ok ? "success" : "failure",
        message: result.ok ? "Port TCP disponible" : "Port TCP indisponible",
        output: { host, port, ...result },
      };
    }

    if (job.type === "network_monitor") {
      return await runNetworkMonitor(job, notifyConfig);
    }

    if (getBlocks(job).length > 0) {
      const result = await runBlocks(job, notifyConfig);
      if (booleanConfig(notifyConfig, "notifyOnSuccess", false)) {
        await sendNotifications(notifyConfig, `${job.name}: blocs termines`);
      }
      return result;
    }

    return await runScript({ ...job, config: notifyConfig });
  } catch (error) {
    try {
      const notifyConfig = await withNotificationSettings(job.config);
      if (booleanConfig(notifyConfig, "notifyOnFailure", true)) {
        await sendNotifications(notifyConfig, `${job.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch {
      // The original execution error is more useful than a secondary notification failure.
    }
    return {
      status: "failure",
      message: error instanceof Error ? error.message : String(error),
      output: {},
    };
  }
}
