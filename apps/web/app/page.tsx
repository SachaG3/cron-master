"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  CalendarClock,
  CheckCircle2,
  Clock,
  Code2,
  Copy,
  FileJson,
  HelpCircle,
  Download,
  Globe2,
  LogOut,
  PauseCircle,
  Play,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Save,
  Server,
  Settings,
  ShieldAlert,
  Trash2,
  Upload,
  Webhook,
  Wifi,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type JobType = "notification" | "date_reminder" | "website_check" | "machine_check" | "network_monitor" | "script";
type ScheduleType = "cron" | "once";
type ScheduleMode = "interval" | "daily" | "weekly" | "monthly" | "once";
type IntervalUnit = "minutes" | "hours" | "days";
type BlockKind = "notify" | "http" | "tcp" | "wait" | "webhook" | "condition";

type BlockStep = {
  id: string;
  kind: BlockKind;
  message?: string;
  url?: string;
  expectedStatus?: number;
  maxResponseMs?: number;
  host?: string;
  port?: number;
  seconds?: number;
  method?: string;
  body?: string;
  field?: string;
  operator?: string;
  value?: string;
};

type Job = {
  id: string;
  name: string;
  description: string;
  type: JobType;
  schedule_type: ScheduleType;
  cron_expression: string | null;
  run_at: string | null;
  timezone: string;
  enabled: boolean;
  config: Record<string, unknown>;
  next_run_at: string | null;
  last_run_at: string | null;
};

type JobRun = {
  id: string;
  job_id: string;
  status: "success" | "failure";
  started_at: string;
  message: string;
  output: Record<string, unknown>;
};

type NotificationSettings = {
  discordWebhookUrl: string;
  ntfyServer: string;
  ntfyTopic: string;
  ntfyToken: string;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
};

type Template = { id: string; name: string; description: string; job: { type: string; config: Record<string, unknown> } };
type Incident = { id: string; title: string; severity: string; status: string; opened_at: string; last_message: string };
type Deadman = { id: string; name: string; slug: string; expected_interval_minutes: number; grace_minutes: number; status: string; last_ping_at: string | null };
type Credential = { id: string; name: string; type: string; created_at: string };
type Maintenance = { id: string; name: string; starts_at: string; ends_at: string; enabled: boolean };
type Dashboard = { activeJobs: number; openIncidents: number; missingDeadmen: number; runs24h: { total: number; success: number; failure: number } };
type AuthUser = { id: string; email: string };

const API_URL = "/api/backend";

const weekDays = [
  { value: 1, label: "lundi" },
  { value: 2, label: "mardi" },
  { value: 3, label: "mercredi" },
  { value: 4, label: "jeudi" },
  { value: 5, label: "vendredi" },
  { value: 6, label: "samedi" },
  { value: 0, label: "dimanche" },
];

const jobTypes: Array<{ value: JobType; icon: React.ComponentType<{ className?: string }>; label: string; hint: string }> = [
  { value: "website_check", icon: Globe2, label: "Site", hint: "HTTP + temps de réponse" },
  { value: "machine_check", icon: Server, label: "Machine", hint: "Port TCP" },
  { value: "network_monitor", icon: Wifi, label: "Réseau", hint: "Ping + timer panne" },
  { value: "script", icon: Code2, label: "Workflow", hint: "Blocs visuels" },
  { value: "notification", icon: Bell, label: "Notif", hint: "Message planifié" },
  { value: "date_reminder", icon: CalendarClock, label: "Rappel", hint: "Date précise" },
];

const viewTabs: Array<{
  value: "dashboard" | "jobs" | "incidents" | "ops" | "settings" | "docs";
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}> = [
  { value: "dashboard", icon: Activity, label: "Dashboard" },
  { value: "jobs", icon: Server, label: "Jobs" },
  { value: "incidents", icon: ShieldAlert, label: "Incidents" },
  { value: "ops", icon: Webhook, label: "Automations" },
  { value: "settings", icon: Settings, label: "Settings" },
  { value: "docs", icon: HelpCircle, label: "Docs" },
];


const defaultBlocks: BlockStep[] = [
  { id: "a", kind: "http", url: "https://example.com", expectedStatus: 200, maxResponseMs: 2000 },
  { id: "b", kind: "condition", field: "RESPONSE_TIME", operator: "<", value: "2000", message: "Site trop lent" },
  { id: "c", kind: "notify", message: "$JOB_NAME OK en $RESPONSE_TIME ms" },
];

function formatDate(value: string | null) {
  if (!value) return "Aucune";
  return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function selectClassName() {
  return "h-9 rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
}

function parseTime(value: string) {
  const [hour = "9", minute = "0"] = value.split(":");
  return { hour: Number(hour) || 0, minute: Number(minute) || 0 };
}

function scheduleText(job: Job) {
  return typeof job.config.scheduleLabel === "string" ? job.config.scheduleLabel : job.schedule_type === "once" ? formatDate(job.run_at) : "Planifié";
}

function formatDurationMs(value: unknown) {
  const ms = typeof value === "number" ? value : 0;
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function networkSummary(job: Job) {
  if (job.type !== "network_monitor") return "";
  const status = String(job.config.networkStatus || "unknown");
  const outageStartedAt = typeof job.config.outageStartedAt === "string" ? job.config.outageStartedAt : "";
  const results = Array.isArray(job.config.lastNetworkResults) ? job.config.lastNetworkResults : [];
  const online = results.filter((result) => result && typeof result === "object" && "ok" in result && result.ok === true).length;
  const targetText = results.length > 0 ? ` · ${online}/${results.length} cibles répondent` : "";
  const lastChecked = typeof job.config.lastCheckedAt === "string" ? ` · check ${formatDate(job.config.lastCheckedAt)}` : "";
  if (status === "down" && outageStartedAt) return `Panne depuis ${formatDate(outageStartedAt)}${targetText}${lastChecked}`;
  if (status === "up" && typeof job.config.lastRecoveryDurationMs === "number") return `Dernière panne: ${formatDurationMs(job.config.lastRecoveryDurationMs)}${targetText}${lastChecked}`;
  if (status === "up") return `Réseau disponible${targetText}${lastChecked}`;
  return "En attente du premier ping";
}

function cx(...classes: Array<string | false | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" | "info" }) {
  return (
    <span
      className={cx(
        "inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium",
        tone === "ok" && "border-emerald-200 bg-emerald-50 text-emerald-700",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-800",
        tone === "bad" && "border-red-200 bg-red-50 text-red-700",
        tone === "info" && "border-sky-200 bg-sky-50 text-sky-700",
        tone === "neutral" && "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

function SectionTitle({ icon: Icon, title, aside }: { icon: React.ComponentType<{ className?: string }>; title: string; aside?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-4 w-4 text-primary" />
        {title}
      </h2>
      {aside}
    </div>
  );
}

function HelpText({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
      <div className="flex gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{children}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [deadmen, setDeadmen] = useState<Deadman[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [maintenance, setMaintenance] = useState<Maintenance[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [settings, setSettings] = useState<NotificationSettings>({
    discordWebhookUrl: "",
    ntfyServer: "https://ntfy.sh",
    ntfyTopic: "",
    ntfyToken: "",
    notifyOnSuccess: false,
    notifyOnFailure: true,
  });
  const [error, setError] = useState("");
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [logJobId, setLogJobId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"dashboard" | "jobs" | "incidents" | "ops" | "settings" | "docs">("dashboard");
  const [composerOpen, setComposerOpen] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [jobSeverityFilter, setJobSeverityFilter] = useState("all");
  const [jobStatusFilter, setJobStatusFilter] = useState("all");

  const [type, setType] = useState<JobType>("website_check");
  const [name, setName] = useState("Surveillance site");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>("interval");
  const [intervalValue, setIntervalValue] = useState(5);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("minutes");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState("09:00");
  const [monthlyDay, setMonthlyDay] = useState(1);
  const [monthlyTime, setMonthlyTime] = useState("09:00");
  const [runAt, setRunAt] = useState("");
  const [message, setMessage] = useState("Notification $JOB_NAME");
  const [url, setUrl] = useState("https://example.com");
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [host, setHost] = useState("example.com");
  const [port, setPort] = useState(443);
  const [networkTargets, setNetworkTargets] = useState("Routeur | 192.168.1.1\nDNS Cloudflare | 1.1.1.1");
  const [networkMinOnline, setNetworkMinOnline] = useState(1);
  const [networkTimeoutMs, setNetworkTimeoutMs] = useState(2000);
  const [networkFailureThreshold, setNetworkFailureThreshold] = useState(2);
  const [networkRecoveryThreshold, setNetworkRecoveryThreshold] = useState(2);
  const [networkReminderMinutes, setNetworkReminderMinutes] = useState(30);
  const [networkNotifyOnDown, setNetworkNotifyOnDown] = useState(false);
  const [networkNotifyOnRecovery, setNetworkNotifyOnRecovery] = useState(true);
  const [useGlobalNotifications, setUseGlobalNotifications] = useState(true);
  const [localDiscord, setLocalDiscord] = useState("");
  const [localNtfyTopic, setLocalNtfyTopic] = useState("");
  const [severity, setSeverity] = useState("warning");
  const [tags, setTags] = useState("prod");
  const [retryCount, setRetryCount] = useState(2);
  const [retryDelaySeconds, setRetryDelaySeconds] = useState(10);
  const [blocks, setBlocks] = useState<BlockStep[]>(defaultBlocks);
  const [deadmanName, setDeadmanName] = useState("Backup quotidien");
  const [deadmanSlug, setDeadmanSlug] = useState("backup-daily");
  const [credentialName, setCredentialName] = useState("Webhook prod");
  const [maintenanceName, setMaintenanceName] = useState("Maintenance");
  const [maintenanceStart, setMaintenanceStart] = useState("");
  const [maintenanceEnd, setMaintenanceEnd] = useState("");

  const openIncidents = incidents.filter((incident) => incident.status === "open");
  const resolvedIncidents = incidents.filter((incident) => incident.status !== "open");
  const selectedLogJob = jobs.find((job) => job.id === logJobId);
  const selectedRuns = useMemo(() => (logJobId ? runs.filter((run) => run.job_id === logJobId) : runs).slice(0, 12), [logJobId, runs]);
  const currentJob = jobs.find((job) => job.id === editingId);
  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      const haystack = `${job.name} ${job.description} ${job.type} ${String(job.config.severity || "")} ${
        Array.isArray(job.config.tags) ? job.config.tags.join(" ") : ""
      }`.toLowerCase();
      const matchesSearch = haystack.includes(jobSearch.toLowerCase());
      const matchesSeverity = jobSeverityFilter === "all" || job.config.severity === jobSeverityFilter;
      const matchesStatus = jobStatusFilter === "all" || (jobStatusFilter === "active" ? job.enabled : !job.enabled);
      return matchesSearch && matchesSeverity && matchesStatus;
    });
  }, [jobs, jobSearch, jobSeverityFilter, jobStatusFilter]);

  async function readError(response: Response) {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text);
      return typeof parsed.error === "string" ? parsed.error : text;
    } catch {
      return text || response.statusText;
    }
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, { ...init, credentials: "include" });
    if (response.status === 401) {
      setAuthUser(null);
      throw new Error("Connexion requise");
    }
    if (!response.ok) throw new Error(await readError(response));
    if (response.status === 204) return undefined as T;
    return response.json();
  }

  async function checkAuth() {
    setAuthLoading(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
      if (response.ok) {
        const data = (await response.json()) as { user: AuthUser };
        setAuthUser(data.user);
        setNeedsSetup(false);
        return;
      }
      const setupResponse = await fetch(`${API_URL}/auth/setup-status`, { credentials: "include" });
      const setupData = (await setupResponse.json()) as { needsSetup: boolean };
      setNeedsSetup(setupData.needsSetup);
      setAuthUser(null);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : String(authError));
    } finally {
      setAuthLoading(false);
    }
  }

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const response = await fetch(`${API_URL}/auth/${needsSetup ? "register" : "login"}`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: authEmail, password: authPassword }),
    });
    if (!response.ok) {
      setError(await readError(response));
      return;
    }
    const data = (await response.json()) as { user: AuthUser };
    setAuthUser(data.user);
    setNeedsSetup(false);
    setAuthPassword("");
  }

  async function logout() {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    setAuthUser(null);
    await checkAuth();
  }

  async function refresh() {
    setError("");
    try {
      const [jobsData, runsData, settingsData, templatesData, incidentsData, deadmenData, credentialsData, maintenanceData, dashboardData] = await Promise.all([
        api<Job[]>("/jobs"),
        api<JobRun[]>("/runs"),
        api<NotificationSettings>("/settings/notifications"),
        api<Template[]>("/templates"),
        api<Incident[]>("/incidents"),
        api<Deadman[]>("/deadman"),
        api<Credential[]>("/credentials"),
        api<Maintenance[]>("/maintenance"),
        api<Dashboard>("/dashboard"),
      ]);
      setJobs(jobsData);
      setRuns(runsData);
      setSettings(settingsData);
      setTemplates(templatesData);
      setIncidents(incidentsData);
      setDeadmen(deadmenData);
      setCredentials(credentialsData);
      setMaintenance(maintenanceData);
      setDashboard(dashboardData);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    }
  }

  useEffect(() => {
    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!authUser) return;
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUser]);

  function buildSchedule(): { scheduleType: ScheduleType; cronExpression: string | null; runAt: string | null; label: string } {
    if (scheduleMode === "once") {
      return { scheduleType: "once", cronExpression: null, runAt: runAt ? new Date(runAt).toISOString() : null, label: runAt ? formatDate(new Date(runAt).toISOString()) : "Une fois" };
    }
    if (scheduleMode === "daily") {
      const { hour, minute } = parseTime(dailyTime);
      return { scheduleType: "cron", cronExpression: `${minute} ${hour} * * *`, runAt: null, label: `Tous les jours à ${dailyTime}` };
    }
    if (scheduleMode === "weekly") {
      const { hour, minute } = parseTime(weeklyTime);
      return { scheduleType: "cron", cronExpression: `${minute} ${hour} * * ${weeklyDay}`, runAt: null, label: `Chaque ${weekDays.find((d) => d.value === weeklyDay)?.label} à ${weeklyTime}` };
    }
    if (scheduleMode === "monthly") {
      const { hour, minute } = parseTime(monthlyTime);
      const day = Math.max(1, Math.min(28, monthlyDay || 1));
      return { scheduleType: "cron", cronExpression: `${minute} ${hour} ${day} * *`, runAt: null, label: `Le ${day} de chaque mois à ${monthlyTime}` };
    }
    const value = Math.max(1, intervalValue || 1);
    if (intervalUnit === "hours") return { scheduleType: "cron", cronExpression: `0 */${value} * * *`, runAt: null, label: `Toutes les ${value} h` };
    if (intervalUnit === "days") return { scheduleType: "cron", cronExpression: `0 9 */${value} * *`, runAt: null, label: `Tous les ${value} j à 09:00` };
    return { scheduleType: "cron", cronExpression: `*/${value} * * * *`, runAt: null, label: `Toutes les ${value} min` };
  }

  function buildConfig(scheduleLabel: string) {
    const targets = networkTargets
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [labelOrHost = "", hostValue = ""] = line.split("|").map((part) => part.trim());
        return hostValue ? { label: labelOrHost, host: hostValue } : { label: labelOrHost, host: labelOrHost };
      });
    const base = {
      message,
      scheduleLabel,
      severity,
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      retryCount,
      retryDelaySeconds,
      useGlobalNotifications,
      discordWebhookUrl: useGlobalNotifications ? undefined : localDiscord || undefined,
      ntfyTopic: useGlobalNotifications ? undefined : localNtfyTopic || undefined,
    };
    if (type === "website_check") return { ...base, url, expectedStatus };
    if (type === "machine_check") return { ...base, host, port };
    if (type === "network_monitor") {
      return {
        ...base,
        targets,
        minOnline: networkMinOnline,
        timeoutMs: networkTimeoutMs,
        failureThreshold: networkFailureThreshold,
        recoveryThreshold: networkRecoveryThreshold,
        reminderMinutes: networkReminderMinutes,
        notifyOnDown: networkNotifyOnDown,
        notifyOnRecovery: networkNotifyOnRecovery,
      };
    }
    if (type === "script") return { ...base, blocks };
    return base;
  }

  async function submitJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const schedule = buildSchedule();
    await api(editingId ? `/jobs/${editingId}` : "/jobs", {
      method: editingId ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description,
        type,
        scheduleType: schedule.scheduleType,
        cronExpression: schedule.cronExpression,
        runAt: schedule.runAt,
        timezone: "Europe/Paris",
        enabled,
        config: buildConfig(schedule.label),
      }),
    });
    setEditingId(null);
    setComposerOpen(false);
    await refresh();
  }

  function resetComposer() {
    setEditingId(null);
    setName("Surveillance site");
    setDescription("");
    setType("website_check");
    setSeverity("warning");
    setNetworkTargets("Routeur | 192.168.1.1\nDNS Cloudflare | 1.1.1.1");
    setNetworkMinOnline(1);
    setNetworkTimeoutMs(2000);
    setNetworkFailureThreshold(2);
    setNetworkRecoveryThreshold(2);
    setNetworkReminderMinutes(30);
    setNetworkNotifyOnDown(false);
    setNetworkNotifyOnRecovery(true);
    setBlocks(defaultBlocks);
    setComposerOpen(true);
  }

  function editJob(job: Job) {
    setEditingId(job.id);
    setType(job.type);
    setName(job.name);
    setDescription(job.description);
    setEnabled(job.enabled);
    setMessage(String(job.config.message || ""));
    setUrl(String(job.config.url || "https://example.com"));
    setExpectedStatus(Number(job.config.expectedStatus || 200));
    setHost(String(job.config.host || "example.com"));
    setPort(Number(job.config.port || 443));
    setNetworkTargets(
      Array.isArray(job.config.targets)
        ? job.config.targets
            .map((target) => {
              if (!target || typeof target !== "object") return "";
              const hostValue = "host" in target && typeof target.host === "string" ? target.host : "";
              const label = "label" in target && typeof target.label === "string" ? target.label : hostValue;
              return label && label !== hostValue ? `${label} | ${hostValue}` : hostValue;
            })
            .filter(Boolean)
            .join("\n")
        : "Routeur | 192.168.1.1\nDNS Cloudflare | 1.1.1.1",
    );
    setNetworkMinOnline(Number(job.config.minOnline || 1));
    setNetworkTimeoutMs(Number(job.config.timeoutMs || 2000));
    setNetworkFailureThreshold(Number(job.config.failureThreshold || 2));
    setNetworkRecoveryThreshold(Number(job.config.recoveryThreshold || 2));
    setNetworkReminderMinutes(Number(job.config.reminderMinutes || 0));
    setNetworkNotifyOnDown(job.config.notifyOnDown === true);
    setNetworkNotifyOnRecovery(job.config.notifyOnRecovery !== false);
    setSeverity(String(job.config.severity || "warning"));
    setTags(Array.isArray(job.config.tags) ? job.config.tags.join(", ") : "");
    setRetryCount(Number(job.config.retryCount || 0));
    setRetryDelaySeconds(Number(job.config.retryDelaySeconds || 10));
    setUseGlobalNotifications(job.config.useGlobalNotifications !== false);
    setBlocks(Array.isArray(job.config.blocks) ? (job.config.blocks as BlockStep[]) : defaultBlocks);
    setComposerOpen(true);
  }

  function applyTemplate(template: Template) {
    if (template.id === "deadman") {
      setDeadmanName(template.name);
      setDeadmanSlug("backup-daily");
      setActiveView("ops");
      setComposerOpen(false);
      return;
    }
    setType(template.job.type === "deadman" ? "script" : (template.job.type as JobType));
    setName(template.name);
    setDescription(template.description);
    setSeverity(String(template.job.config.severity || "warning"));
    if (template.job.config.url) setUrl(String(template.job.config.url));
    if (template.job.config.host) setHost(String(template.job.config.host));
    if (template.job.config.port) setPort(Number(template.job.config.port));
    if (Array.isArray(template.job.config.targets)) {
      setNetworkTargets(
        template.job.config.targets
          .map((target) => {
            if (!target || typeof target !== "object") return "";
            const hostValue = "host" in target && typeof target.host === "string" ? target.host : "";
            const label = "label" in target && typeof target.label === "string" ? target.label : hostValue;
            return label && label !== hostValue ? `${label} | ${hostValue}` : hostValue;
          })
          .filter(Boolean)
          .join("\n"),
      );
    }
    if (template.job.config.minOnline) setNetworkMinOnline(Number(template.job.config.minOnline));
    if (template.job.config.timeoutMs) setNetworkTimeoutMs(Number(template.job.config.timeoutMs));
    if (template.job.config.failureThreshold) setNetworkFailureThreshold(Number(template.job.config.failureThreshold));
    if (template.job.config.recoveryThreshold) setNetworkRecoveryThreshold(Number(template.job.config.recoveryThreshold));
    if (typeof template.job.config.reminderMinutes === "number") setNetworkReminderMinutes(Number(template.job.config.reminderMinutes));
    if (typeof template.job.config.notifyOnDown === "boolean") setNetworkNotifyOnDown(template.job.config.notifyOnDown);
    if (typeof template.job.config.notifyOnRecovery === "boolean") setNetworkNotifyOnRecovery(template.job.config.notifyOnRecovery);
    if (Array.isArray(template.job.config.blocks)) setBlocks(template.job.config.blocks as BlockStep[]);
    setComposerOpen(true);
  }

  function addBlock(kind: BlockKind) {
    const id = `block-${Date.now()}`;
    const block: BlockStep =
      kind === "notify"
        ? { id, kind, message: "Message $JOB_NAME" }
        : kind === "http"
          ? { id, kind, url: "https://example.com", expectedStatus: 200, maxResponseMs: 2000 }
          : kind === "tcp"
            ? { id, kind, host: "example.com", port: 443 }
            : kind === "webhook"
              ? { id, kind, url: "https://example.com/webhook", method: "POST", body: "{\"job\":\"$JOB_NAME\"}" }
              : kind === "condition"
                ? { id, kind, field: "STATUS", operator: "=", value: "200", message: "Condition non respectée" }
                : { id, kind, seconds: 1 };
    setBlocks([...blocks, block]);
  }

  function updateBlock(id: string, patch: Partial<BlockStep>) {
    setBlocks(blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)));
  }

  async function saveSettings() {
    await api("/settings/notifications", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    await refresh();
  }

  async function createDeadman() {
    await api("/deadman", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: deadmanName, slug: deadmanSlug, expectedIntervalMinutes: 1440, graceMinutes: 60, enabled: true }),
    });
    await refresh();
  }

  async function createCredential() {
    await api("/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: credentialName, type: "webhook", value: {} }),
    });
    await refresh();
  }

  async function createMaintenance() {
    await api("/maintenance", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: maintenanceName, startsAt: new Date(maintenanceStart).toISOString(), endsAt: new Date(maintenanceEnd).toISOString(), enabled: true }),
    });
    await refresh();
  }

  async function exportAll() {
    const data = await api<Record<string, unknown>>("/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "cron-master-export.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importAll(value: string) {
    await api("/import", { method: "POST", headers: { "content-type": "application/json" }, body: value });
    await refresh();
  }

  const schedule = buildSchedule();

  if (authLoading) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4">
        <Card className="w-full max-w-sm p-5">
          <p className="text-sm font-medium">Chargement de la session...</p>
        </Card>
      </main>
    );
  }

  if (!authUser) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-4">
        <Card className="w-full max-w-sm p-5">
          <div className="mb-5">
            <h1 className="text-xl font-semibold">{needsSetup ? "Créer le compte admin" : "Connexion"}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {needsSetup ? "Ce premier compte protegera l'interface d'administration." : "Connecte-toi pour gerer les jobs et les alertes."}
            </p>
          </div>
          {error && <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <form onSubmit={submitAuth} className="grid gap-3">
            <div className="grid gap-1">
              <Label>Email</Label>
              <Input type="email" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required />
            </div>
            <div className="grid gap-1">
              <Label>Mot de passe</Label>
              <Input type="password" minLength={8} value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required />
            </div>
            <Button type="submit">{needsSetup ? "Créer le compte" : "Se connecter"}</Button>
          </form>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      {composerOpen && (
        <div className="fixed inset-0 z-50 grid place-items-start overflow-y-auto bg-foreground/35 px-4 py-6 backdrop-blur-sm">
          <Card className="mx-auto w-full max-w-4xl overflow-hidden">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div>
                <h2 className="text-lg font-semibold">{editingId ? "Modifier un job" : "Créer un job"}</h2>
                <p className="text-sm text-muted-foreground">Configuration guidée, sans expression cron visible.</p>
              </div>
              <Button type="button" variant="ghost" onClick={() => setComposerOpen(false)}>Fermer</Button>
            </div>

            <form onSubmit={submitJob} className="grid gap-5 p-5 lg:grid-cols-[280px_1fr]">
              <div className="space-y-3">
                <HelpText>Choisis d'abord l'intention du job. Les champs de droite changent automatiquement selon ce choix.</HelpText>
                {jobTypes.map(({ value, icon: Icon, label, hint }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setType(value)}
                    className={cx(
                      "w-full rounded-lg border bg-card p-3 text-left transition hover:bg-muted",
                      type === value && "border-primary bg-primary/5 ring-1 ring-primary",
                    )}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="h-4 w-4 text-primary" />
                      {label}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
                  </button>
                ))}
              </div>

              <div className="space-y-5">
                <div className="grid gap-2">
                  <Label>Identité</Label>
                  <Input placeholder="Nom du job" value={name} onChange={(event) => setName(event.target.value)} required />
                  <Input placeholder="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
                  <div className="grid grid-cols-[130px_1fr_90px] gap-2">
                    <select className={selectClassName()} value={severity} onChange={(event) => setSeverity(event.target.value)}>
                      <option value="info">info</option>
                      <option value="warning">warning</option>
                      <option value="critical">critical</option>
                    </select>
                    <Input placeholder="tags: prod, infra" value={tags} onChange={(event) => setTags(event.target.value)} />
                    <label className="flex items-center gap-2 rounded-md border bg-card px-3 text-sm">
                      <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                      Actif
                    </label>
                  </div>
                </div>

                <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
                  <Label>Planification</Label>
                  <p className="text-xs text-muted-foreground">L'app génère la planification technique en interne. Ici, tu choisis seulement le rythme métier.</p>
                  <div className="grid grid-cols-5 gap-1">
                    {[
                      ["interval", "Régulier"],
                      ["daily", "Jour"],
                      ["weekly", "Semaine"],
                      ["monthly", "Mois"],
                      ["once", "Date"],
                    ].map(([mode, label]) => (
                      <Button key={mode} type="button" size="sm" variant={scheduleMode === mode ? "default" : "outline"} onClick={() => setScheduleMode(mode as ScheduleMode)}>
                        {label}
                      </Button>
                    ))}
                  </div>
                  {scheduleMode === "interval" && (
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <Input type="number" min={1} value={intervalValue} onChange={(event) => setIntervalValue(Number(event.target.value))} />
                      <select className={selectClassName()} value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as IntervalUnit)}>
                        <option value="minutes">minutes</option>
                        <option value="hours">heures</option>
                        <option value="days">jours</option>
                      </select>
                    </div>
                  )}
                  {scheduleMode === "daily" && <Input type="time" value={dailyTime} onChange={(event) => setDailyTime(event.target.value)} />}
                  {scheduleMode === "weekly" && (
                    <div className="grid grid-cols-[1fr_120px] gap-2">
                      <select className={selectClassName()} value={weeklyDay} onChange={(event) => setWeeklyDay(Number(event.target.value))}>
                        {weekDays.map((day) => <option key={day.value} value={day.value}>{day.label}</option>)}
                      </select>
                      <Input type="time" value={weeklyTime} onChange={(event) => setWeeklyTime(event.target.value)} />
                    </div>
                  )}
                  {scheduleMode === "monthly" && (
                    <div className="grid grid-cols-[1fr_120px] gap-2">
                      <Input type="number" min={1} max={28} value={monthlyDay} onChange={(event) => setMonthlyDay(Number(event.target.value))} />
                      <Input type="time" value={monthlyTime} onChange={(event) => setMonthlyTime(event.target.value)} />
                    </div>
                  )}
                  {scheduleMode === "once" && <Input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />}
                  <p className="rounded-md border bg-card px-3 py-2 text-sm">{schedule.label}</p>
                </div>

                <div className="grid gap-2">
                  <Label>Paramètres</Label>
                  {(type === "notification" || type === "date_reminder") && <Textarea value={message} onChange={(event) => setMessage(event.target.value)} />}
                  {type === "website_check" && (
                    <div className="grid grid-cols-[1fr_100px] gap-2">
                      <Input value={url} onChange={(event) => setUrl(event.target.value)} />
                      <Input type="number" value={expectedStatus} onChange={(event) => setExpectedStatus(Number(event.target.value))} />
                    </div>
                  )}
                  {type === "machine_check" && (
                    <div className="grid grid-cols-[1fr_100px] gap-2">
                      <Input value={host} onChange={(event) => setHost(event.target.value)} />
                      <Input type="number" value={port} onChange={(event) => setPort(Number(event.target.value))} />
                    </div>
                  )}
                  {type === "network_monitor" && (
                    <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
                      <HelpText>
                        Ajoute une cible par ligne. Format simple: <code>192.168.1.1</code>. Format lisible: <code>Routeur | 192.168.1.1</code>. Le timer démarre au premier passage en panne et la notification part au rétablissement.
                      </HelpText>
                      <Textarea value={networkTargets} onChange={(event) => setNetworkTargets(event.target.value)} />
                      <div className="grid gap-2 md:grid-cols-2">
                        <div className="grid gap-1">
                          <Label>Cibles minimum qui doivent répondre</Label>
                          <Input type="number" min={1} value={networkMinOnline} onChange={(event) => setNetworkMinOnline(Number(event.target.value))} />
                        </div>
                        <div className="grid gap-1">
                          <Label>Timeout par ping, ms</Label>
                          <Input type="number" min={500} max={30000} step={500} value={networkTimeoutMs} onChange={(event) => setNetworkTimeoutMs(Number(event.target.value))} />
                        </div>
                      </div>
                      <div className="grid gap-2 md:grid-cols-3">
                        <div className="grid gap-1">
                          <Label>Échecs avant panne</Label>
                          <Input type="number" min={1} max={20} value={networkFailureThreshold} onChange={(event) => setNetworkFailureThreshold(Number(event.target.value))} />
                        </div>
                        <div className="grid gap-1">
                          <Label>Succès avant retour OK</Label>
                          <Input type="number" min={1} max={20} value={networkRecoveryThreshold} onChange={(event) => setNetworkRecoveryThreshold(Number(event.target.value))} />
                        </div>
                        <div className="grid gap-1">
                          <Label>Rappel panne, min</Label>
                          <Input type="number" min={0} max={1440} value={networkReminderMinutes} onChange={(event) => setNetworkReminderMinutes(Number(event.target.value))} />
                        </div>
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
                          <input type="checkbox" checked={networkNotifyOnDown} onChange={(event) => setNetworkNotifyOnDown(event.target.checked)} />
                          Notifier au début de panne
                        </label>
                        <label className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
                          <input type="checkbox" checked={networkNotifyOnRecovery} onChange={(event) => setNetworkNotifyOnRecovery(event.target.checked)} />
                          Notifier au rétablissement
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                {type === "script" && (
                  <div className="grid gap-3 rounded-lg border bg-muted/40 p-3">
                    <div className="flex items-center justify-between">
                      <Label>Workflow par blocs</Label>
                      <Badge>{blocks.length} bloc(s)</Badge>
                    </div>
                    <div className="grid grid-cols-6 gap-2">
                      {(["notify", "http", "tcp", "wait", "webhook", "condition"] as BlockKind[]).map((kind) => (
                        <Button key={kind} type="button" variant="outline" size="sm" onClick={() => addBlock(kind)}>{kind}</Button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">Variables disponibles: $JOB_NAME, $NOW, $STATUS, $RESPONSE_TIME, $URL, $HOST, $PORT.</p>
                    <div className="space-y-2">
                      {blocks.map((block, index) => (
                        <div key={block.id} className="rounded-lg border bg-card p-3">
                          <div className="mb-2 flex items-center justify-between text-sm font-medium">
                            <span>{index + 1}. {block.kind}</span>
                            <Button type="button" variant="ghost" size="icon" onClick={() => setBlocks(blocks.filter((item) => item.id !== block.id))}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          {block.kind === "notify" && <Textarea value={block.message || ""} onChange={(event) => updateBlock(block.id, { message: event.target.value })} />}
                          {block.kind === "http" && (
                            <div className="grid grid-cols-[1fr_90px_110px] gap-2">
                              <Input value={block.url || ""} onChange={(event) => updateBlock(block.id, { url: event.target.value })} />
                              <Input type="number" value={block.expectedStatus || 200} onChange={(event) => updateBlock(block.id, { expectedStatus: Number(event.target.value) })} />
                              <Input type="number" value={block.maxResponseMs || 0} onChange={(event) => updateBlock(block.id, { maxResponseMs: Number(event.target.value) })} />
                            </div>
                          )}
                          {block.kind === "tcp" && (
                            <div className="grid grid-cols-[1fr_90px] gap-2">
                              <Input value={block.host || ""} onChange={(event) => updateBlock(block.id, { host: event.target.value })} />
                              <Input type="number" value={block.port || 443} onChange={(event) => updateBlock(block.id, { port: Number(event.target.value) })} />
                            </div>
                          )}
                          {block.kind === "wait" && <Input type="number" value={block.seconds || 1} onChange={(event) => updateBlock(block.id, { seconds: Number(event.target.value) })} />}
                          {block.kind === "webhook" && (
                            <div className="grid gap-2">
                              <Input value={block.url || ""} onChange={(event) => updateBlock(block.id, { url: event.target.value })} />
                              <Textarea value={block.body || ""} onChange={(event) => updateBlock(block.id, { body: event.target.value })} />
                            </div>
                          )}
                          {block.kind === "condition" && (
                            <div className="grid grid-cols-[1fr_100px_1fr] gap-2">
                              <Input value={block.field || "STATUS"} onChange={(event) => updateBlock(block.id, { field: event.target.value })} />
                              <select className={selectClassName()} value={block.operator || "="} onChange={(event) => updateBlock(block.id, { operator: event.target.value })}>
                                <option>=</option>
                                <option>!=</option>
                                <option>&gt;</option>
                                <option>&lt;</option>
                                <option>contains</option>
                              </select>
                              <Input value={block.value || ""} onChange={(event) => updateBlock(block.id, { value: event.target.value })} />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid gap-3 rounded-lg border bg-card p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label>Retry</Label>
                      <Input type="number" min={0} max={5} value={retryCount} onChange={(event) => setRetryCount(Number(event.target.value))} />
                    </div>
                    <div>
                      <Label>Délai retry</Label>
                      <Input type="number" min={1} max={300} value={retryDelaySeconds} onChange={(event) => setRetryDelaySeconds(Number(event.target.value))} />
                    </div>
                  </div>
                  <label className="flex gap-2 text-sm">
                    <input type="checkbox" checked={useGlobalNotifications} onChange={(event) => setUseGlobalNotifications(event.target.checked)} />
                    Utiliser les notifications globales
                  </label>
                  <p className="text-xs text-muted-foreground">Avec les notifications globales, tu configures Discord/ntfy une seule fois dans Settings.</p>
                  {!useGlobalNotifications && (
                    <div className="grid gap-2">
                      <Input placeholder="Discord local" value={localDiscord} onChange={(event) => setLocalDiscord(event.target.value)} />
                      <Input placeholder="Topic ntfy local" value={localNtfyTopic} onChange={(event) => setLocalNtfyTopic(event.target.value)} />
                    </div>
                  )}
                </div>

                <div className="flex justify-end gap-2 border-t pt-4">
                  <Button type="button" variant="outline" onClick={() => setComposerOpen(false)}>Annuler</Button>
                  <Button type="submit">
                    <Save className="h-4 w-4" />
                    {editingId ? "Sauver" : "Créer"}
                  </Button>
                </div>
              </div>
            </form>
          </Card>
        </div>
      )}

      <header className="border-b bg-card">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold">Cron Master</h1>
                <Badge tone={openIncidents.length ? "bad" : "ok"}>{openIncidents.length ? `${openIncidents.length} incident(s)` : "Opérationnel"}</Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Monitoring, rappels, dead-man switch et automatisations.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex h-9 items-center rounded-md border bg-muted px-3 text-sm text-muted-foreground">{authUser.email}</span>
              <Button variant="outline" onClick={() => window.open(`${API_URL}/status`, "_blank")}><Globe2 className="h-4 w-4" />Status</Button>
              <Button variant="outline" onClick={refresh}><RefreshCw className="h-4 w-4" />Actualiser</Button>
              <Button variant="outline" onClick={logout}><LogOut className="h-4 w-4" />Sortir</Button>
              <Button onClick={resetComposer}><Plus className="h-4 w-4" />Nouveau job</Button>
            </div>
          </div>
          <nav className="mt-4 flex gap-1 rounded-lg bg-muted p-1">
            {viewTabs.map(({ value, icon: Icon, label }) => (
              <Button key={value} type="button" variant={activeView === value ? "default" : "ghost"} onClick={() => setActiveView(value)}>
                <Icon className="h-4 w-4" />
                {label}
              </Button>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        {error && <p className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

        {activeView === "dashboard" && (
          <div className="space-y-5">
            <Card className="p-5">
              <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
                <div>
                  <h2 className="text-lg font-semibold">Vue d'ensemble</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {jobs.length === 0
                      ? "Commence par créer un premier check ou utilise un template."
                      : openIncidents.length > 0
                        ? "Des incidents demandent une action."
                        : "Tout est stable pour le moment."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={resetComposer}><Plus className="h-4 w-4" />Créer un job</Button>
                  <Button type="button" variant="outline" onClick={() => setActiveView("settings")}><Settings className="h-4 w-4" />Configurer les alertes</Button>
                </div>
              </div>
            </Card>
            <HelpText>Le dashboard doit répondre à une question simple: est-ce que tout va bien, et où faut-il agir maintenant ?</HelpText>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">Jobs actifs</p>
            <p className="mt-2 text-3xl font-semibold">{dashboard?.activeJobs ?? jobs.filter((job) => job.enabled).length}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">Runs 24h</p>
            <p className="mt-2 text-3xl font-semibold">{dashboard?.runs24h.total ?? 0}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">Échecs 24h</p>
            <p className="mt-2 text-3xl font-semibold">{dashboard?.runs24h.failure ?? 0}</p>
          </Card>
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">Dead-man manquants</p>
            <p className="mt-2 text-3xl font-semibold">{dashboard?.missingDeadmen ?? 0}</p>
          </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-4">
                <SectionTitle icon={ShieldAlert} title="Incidents récents" />
                <div className="mt-3 space-y-2">
                  {openIncidents.slice(0, 5).map((incident) => (
                    <div key={incident.id} className="rounded-lg border p-3">
                      <p className="font-medium">{incident.title}</p>
                      <p className="text-xs text-muted-foreground">{incident.severity} · {incident.last_message}</p>
                    </div>
                  ))}
                  {openIncidents.length === 0 && (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      Aucun incident ouvert. Les prochains échecs seront regroupés ici automatiquement.
                    </div>
                  )}
                </div>
              </Card>
              <Card className="p-4">
                <SectionTitle icon={Clock} title="Dernières exécutions" />
                <div className="mt-3 space-y-2">
                  {runs.slice(0, 5).map((run) => (
                    <div key={run.id} className="rounded-lg border p-3">
                      <p className="flex items-center gap-2 text-sm font-medium">{run.status === "success" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-destructive" />}{run.message}</p>
                      <p className="text-xs text-muted-foreground">{formatDate(run.started_at)}</p>
                    </div>
                  ))}
                  {runs.length === 0 && (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      Aucune exécution pour l'instant. Lance un job manuellement pour tester.
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        )}

        {activeView === "jobs" && (
          <section className="space-y-4">
            <Card className="overflow-hidden">
              <div className="border-b p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <SectionTitle icon={Activity} title="Jobs" />
                  <div className="flex gap-2">
                    <Badge tone="info">{filteredJobs.length}/{jobs.length}</Badge>
                    <Button size="sm" onClick={resetComposer}><Plus className="h-4 w-4" />Nouveau</Button>
                  </div>
                </div>
                <div className="mt-4 grid gap-2 lg:grid-cols-[1fr_160px_140px]">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input className="pl-9" placeholder="Rechercher par nom, tag, type..." value={jobSearch} onChange={(event) => setJobSearch(event.target.value)} />
                  </div>
                  <select className={selectClassName()} value={jobSeverityFilter} onChange={(event) => setJobSeverityFilter(event.target.value)}>
                    <option value="all">Toutes sévérités</option>
                    <option value="critical">critical</option>
                    <option value="warning">warning</option>
                    <option value="info">info</option>
                  </select>
                  <select className={selectClassName()} value={jobStatusFilter} onChange={(event) => setJobStatusFilter(event.target.value)}>
                    <option value="all">Tous états</option>
                    <option value="active">Actifs</option>
                    <option value="paused">En pause</option>
                  </select>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Clique sur un job pour l'éditer. Le bouton webhook copie une URL pour déclencher ce job depuis une autre app.</p>
              </div>
              <div className="divide-y">
                {filteredJobs.map((job) => (
                  <div key={job.id} className={cx("grid gap-3 p-4 transition hover:bg-muted/50 sm:grid-cols-[1fr_auto]", editingId === job.id && "bg-primary/5")}>
                    <button type="button" className="min-w-0 text-left" onClick={() => editJob(job)}>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{job.name}</p>
                        <Badge>{job.type}</Badge>
                        <Badge tone={job.config.severity === "critical" ? "bad" : job.config.severity === "info" ? "info" : "warn"}>{String(job.config.severity || "warning")}</Badge>
                        {job.type === "network_monitor" && (
                          <Badge tone={job.config.networkStatus === "down" ? "bad" : job.config.networkStatus === "up" ? "ok" : "neutral"}>
                            {job.config.networkStatus === "down" ? "réseau down" : job.config.networkStatus === "up" ? "réseau up" : "pas testé"}
                          </Badge>
                        )}
                        {!job.enabled && <Badge>pause</Badge>}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{job.description || scheduleText(job)}</p>
                      {job.type === "network_monitor" && <p className="mt-1 text-xs text-muted-foreground">{networkSummary(job)}</p>}
                      <p className="mt-1 text-xs text-muted-foreground">{scheduleText(job)} · prochain: {formatDate(job.next_run_at)}</p>
                    </button>
                    <div className="flex gap-2 sm:justify-end">
                      <Button type="button" size="icon" variant="outline" title="Exécuter" onClick={() => api(`/jobs/${job.id}/run`, { method: "POST" }).then(refresh)}>
                        <Play className="h-4 w-4" />
                      </Button>
                      <Button type="button" size="icon" variant="outline" title={job.enabled ? "Mettre en pause" : "Reprendre"} onClick={() => api(`/jobs/${job.id}/${job.enabled ? "pause" : "resume"}`, { method: "POST" }).then(refresh)}>
                        {job.enabled ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                      </Button>
                      <Button type="button" size="icon" variant="outline" title="Dupliquer" onClick={() => api(`/jobs/${job.id}/duplicate`, { method: "POST" }).then(refresh)}>
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button type="button" size="icon" variant="outline" title="Logs techniques" onClick={() => { setLogJobId(job.id); setActiveView("incidents"); }}>
                        <FileJson className="h-4 w-4" />
                      </Button>
                      <Button type="button" size="icon" variant="outline" title="Copier webhook" onClick={() => navigator.clipboard.writeText(`${API_URL}/webhooks/${job.id}`)}>
                        <Webhook className="h-4 w-4" />
                      </Button>
                      <Button type="button" size="icon" variant="destructive" title="Supprimer" onClick={() => api(`/jobs/${job.id}`, { method: "DELETE" }).then(refresh)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
                {jobs.length === 0 && (
                  <div className="p-8 text-center">
                    <p className="text-sm font-medium">Aucun job configuré</p>
                    <p className="mt-1 text-sm text-muted-foreground">Crée un check de site, un rappel ou un workflow depuis un template.</p>
                    <Button className="mt-4" onClick={resetComposer}><Plus className="h-4 w-4" />Créer le premier job</Button>
                  </div>
                )}
                {jobs.length > 0 && filteredJobs.length === 0 && (
                  <div className="p-8 text-center">
                    <p className="text-sm font-medium">Aucun résultat</p>
                    <p className="mt-1 text-sm text-muted-foreground">Modifie la recherche ou réinitialise les filtres.</p>
                    <Button className="mt-4" variant="outline" onClick={() => { setJobSearch(""); setJobSeverityFilter("all"); setJobStatusFilter("all"); }}>Réinitialiser</Button>
                  </div>
                )}
              </div>
            </Card>
          </section>
        )}

        {activeView === "incidents" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-4">
                <SectionTitle icon={ShieldAlert} title="Incidents ouverts" />
                <p className="mt-2 text-sm text-muted-foreground">Un incident ouvert demande une action. Au prochain succès du job, il sera aussi résolu automatiquement.</p>
                <div className="mt-3 space-y-2">
                  {openIncidents.slice(0, 8).map((incident) => (
                    <div key={incident.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium">{incident.title}</p>
                            <Badge tone={incident.severity === "critical" ? "bad" : incident.severity === "info" ? "info" : "warn"}>{incident.severity}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{formatDate(incident.opened_at)} · {incident.last_message}</p>
                        </div>
                        <Button type="button" size="sm" variant="outline" onClick={() => api(`/incidents/${incident.id}/resolve`, { method: "POST" }).then(refresh)}>
                          Résoudre
                        </Button>
                      </div>
                    </div>
                  ))}
                  {openIncidents.length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Aucun incident ouvert.</p>}
                </div>

                {resolvedIncidents.length > 0 && (
                  <div className="mt-5 border-t pt-4">
                    <p className="text-sm font-medium">Résolus récents</p>
                    <div className="mt-2 space-y-2">
                      {resolvedIncidents.slice(0, 5).map((incident) => (
                        <div key={incident.id} className="rounded-md border bg-muted/30 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate text-sm">{incident.title}</p>
                            <Badge tone="ok">résolu</Badge>
                          </div>
                          <p className="mt-1 truncate text-xs text-muted-foreground">{incident.last_message}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </Card>

              <Card className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <SectionTitle icon={Clock} title="Historique et logs" />
                    <p className="mt-2 text-sm text-muted-foreground">
                      {selectedLogJob ? `Runs filtrés pour ${selectedLogJob.name}.` : "Dernières exécutions tous jobs confondus."}
                    </p>
                  </div>
                  {logJobId && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setLogJobId(null)}>
                      Tout afficher
                    </Button>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {selectedRuns.map((run) => (
                    <div key={run.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-medium">
                            {run.status === "success" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-destructive" />}
                            {run.message}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">{formatDate(run.started_at)} · tentatives: {String(run.output.attempts || 1)}</p>
                        </div>
                        <Badge tone={run.status === "success" ? "ok" : "bad"}>{run.status}</Badge>
                      </div>
                      <details className="mt-3 rounded-md border bg-muted/30 p-2">
                        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Logs techniques</summary>
                        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(run.output, null, 2)}</pre>
                      </details>
                    </div>
                  ))}
                  {selectedRuns.length === 0 && (
                    <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                      Aucune exécution à afficher. Lance un job manuellement pour générer un run.
                    </div>
                  )}
                </div>
              </Card>
            </div>
        )}

        {activeView === "settings" && (
          <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-4">
                <SectionTitle icon={Plus} title="Templates" />
                <p className="mt-2 text-sm text-muted-foreground">Les templates pré-remplissent la modale de création. Tu peux ajuster tous les champs avant de sauvegarder.</p>
                <div className="mt-3 space-y-2">
                  {templates.map((template) => (
                    <button key={template.id} type="button" className="w-full rounded-lg border p-3 text-left transition hover:bg-muted" onClick={() => applyTemplate(template)}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium">{template.name}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
                        </div>
                        <Badge tone="info">Utiliser</Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </Card>
              <Card className="p-4">
                <SectionTitle icon={Settings} title="Notifications" />
                <div className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Ces destinations sont utilisées par défaut par les jobs. Un job peut toujours les remplacer dans sa modale.
                </div>
                <div className="mt-3 grid gap-2">
                  <Input placeholder="Discord webhook" value={settings.discordWebhookUrl} onChange={(event) => setSettings({ ...settings, discordWebhookUrl: event.target.value })} />
                  <Input placeholder="Serveur ntfy" value={settings.ntfyServer} onChange={(event) => setSettings({ ...settings, ntfyServer: event.target.value })} />
                  <Input placeholder="Topic ntfy" value={settings.ntfyTopic} onChange={(event) => setSettings({ ...settings, ntfyTopic: event.target.value })} />
                  <label className="flex gap-2 text-sm">
                    <input type="checkbox" checked={settings.notifyOnFailure} onChange={(event) => setSettings({ ...settings, notifyOnFailure: event.target.checked })} />
                    Notifier les échecs
                  </label>
                  <label className="flex gap-2 text-sm">
                    <input type="checkbox" checked={settings.notifyOnSuccess} onChange={(event) => setSettings({ ...settings, notifyOnSuccess: event.target.checked })} />
                    Notifier les retours OK
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button type="button" onClick={saveSettings}><Save className="h-4 w-4" />Sauver</Button>
                    <Button type="button" variant="outline" onClick={() => api("/settings/notifications/test", { method: "POST" })}><Bell className="h-4 w-4" />Tester</Button>
                  </div>
                </div>
              </Card>
          </div>
        )}

        {activeView === "ops" && (
              <div className="space-y-4">
                <HelpText>Automations regroupe les fonctions d'intégration: tâches externes qui pingent l'app, credentials, maintenances et import/export.</HelpText>
                <div className="grid gap-4 lg:grid-cols-3">
                <Card className="p-4">
                  <SectionTitle icon={ShieldAlert} title="Dead-man" />
                  <p className="mt-2 text-sm text-muted-foreground">Surveille une tâche externe qui doit appeler une URL régulièrement.</p>
                  <div className="mt-3 grid gap-2">
                    <Input value={deadmanName} onChange={(event) => setDeadmanName(event.target.value)} />
                    <Input value={deadmanSlug} onChange={(event) => setDeadmanSlug(event.target.value)} />
                    <Button type="button" onClick={createDeadman}><Plus className="h-4 w-4" />Créer ping</Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {deadmen.slice(0, 4).map((deadman) => (
                      <p key={deadman.id} className="rounded-md border p-2 text-sm">
                        {deadman.name} · {deadman.status}
                        <span className="mt-1 block break-all text-xs text-muted-foreground">{API_URL}/ping/{deadman.slug}</span>
                      </p>
                    ))}
                    {deadmen.length === 0 && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Aucun ping externe configuré.</p>}
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle icon={Settings} title="Credentials" />
                  <p className="mt-2 text-sm text-muted-foreground">Prépare les connexions réutilisables pour les prochains blocs et webhooks.</p>
                  <div className="mt-3 grid gap-2">
                    <Input value={credentialName} onChange={(event) => setCredentialName(event.target.value)} />
                    <Button type="button" onClick={createCredential}><Plus className="h-4 w-4" />Ajouter</Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {credentials.slice(0, 5).map((credential) => <p key={credential.id} className="rounded-md border p-2 text-sm">{credential.name} · {credential.type}</p>)}
                    {credentials.length === 0 && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Aucun credential enregistré.</p>}
                  </div>
                </Card>

                <Card className="p-4">
                  <SectionTitle icon={CalendarClock} title="Maintenance" />
                  <p className="mt-2 text-sm text-muted-foreground">Coupe les alertes pendant une période connue de maintenance.</p>
                  <div className="mt-3 grid gap-2">
                    <Input value={maintenanceName} onChange={(event) => setMaintenanceName(event.target.value)} />
                    <Input type="datetime-local" value={maintenanceStart} onChange={(event) => setMaintenanceStart(event.target.value)} />
                    <Input type="datetime-local" value={maintenanceEnd} onChange={(event) => setMaintenanceEnd(event.target.value)} />
                    <Button type="button" onClick={createMaintenance}><Clock className="h-4 w-4" />Planifier</Button>
                  </div>
                  <div className="mt-3 space-y-2">
                    {maintenance.slice(0, 3).map((item) => (
                      <p key={item.id} className="rounded-md border p-2 text-sm">
                        {item.name}
                        <span className="block text-xs text-muted-foreground">{formatDate(item.starts_at)} - {formatDate(item.ends_at)}</span>
                      </p>
                    ))}
                    {maintenance.length === 0 && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Aucune fenêtre de maintenance.</p>}
                  </div>
                </Card>
                </div>

                <Card className="p-4">
                  <SectionTitle icon={Download} title="Import / Export" />
                  <div className="mt-3 grid gap-2">
                    <Button type="button" variant="outline" onClick={exportAll}><Download className="h-4 w-4" />Exporter</Button>
                    <Textarea placeholder="Coller un export JSON ici" onBlur={(event) => event.currentTarget.value.trim() && importAll(event.currentTarget.value)} />
                    <p className="flex items-center gap-2 text-xs text-muted-foreground"><Upload className="h-3 w-3" />Import au changement de champ.</p>
                  </div>
                </Card>
              </div>
        )}

        {activeView === "docs" && (
          <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
            <aside className="lg:sticky lg:top-5 lg:self-start">
              <Card className="p-4">
                <SectionTitle icon={HelpCircle} title="Docs" />
                <div className="mt-4 space-y-1 text-sm">
                  {[
                    ["#start", "Démarrage"],
                    ["#concepts", "Concepts"],
                    ["#jobs-doc", "Types de jobs"],
                    ["#network-doc", "Suivi réseau"],
                    ["#workflow-doc", "Workflows"],
                    ["#ops-doc", "Opérations"],
                    ["#api-doc", "API publique"],
                    ["#troubleshooting-doc", "Dépannage"],
                  ].map(([href, label]) => (
                    <a key={href} href={href} className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                      {label}
                    </a>
                  ))}
                </div>
              </Card>
            </aside>

            <div className="space-y-5">
              <section id="start" className="rounded-lg border bg-card p-5">
                <p className="text-xs font-medium uppercase text-muted-foreground">Guide produit</p>
                <h2 className="mt-2 text-2xl font-semibold">Utiliser Cron Master proprement</h2>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                  Cron Master sert à créer des jobs planifiés, surveiller des services, suivre un réseau, recevoir des webhooks et exposer une API simple à d'autres applications. Le principe: créer un job lisible, le tester manuellement, puis laisser le worker gérer les exécutions, incidents et notifications.
                </p>
                <div className="mt-5 grid gap-3 md:grid-cols-4">
                  {[
                    ["1", "Créer", "Choisir le type de job et sa fréquence."],
                    ["2", "Tester", "Lancer le job une fois manuellement."],
                    ["3", "Observer", "Lire les runs et incidents."],
                    ["4", "Ajuster", "Régler retries, seuils et notifications."],
                  ].map(([step, title, body]) => (
                    <div key={step} className="rounded-md border bg-muted/30 p-3">
                      <p className="text-xs font-medium text-muted-foreground">Étape {step}</p>
                      <p className="mt-1 font-medium">{title}</p>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section id="concepts" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Concepts</h3>
                <div className="mt-4 overflow-hidden rounded-md border">
                  {[
                    ["Job", "Une tâche configurée: check, notification, rappel, workflow ou suivi réseau."],
                    ["Run", "Une exécution d'un job, avec statut, message, durée et détails techniques."],
                    ["Incident", "Un problème ouvert après un échec. Il est dédupliqué par job et résolu au retour OK."],
                    ["Maintenance", "Une période prévue pendant laquelle les alertes sont suspendues."],
                  ].map(([term, description]) => (
                    <div key={term} className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[160px_1fr]">
                      <p className="font-medium">{term}</p>
                      <p className="text-muted-foreground">{description}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section id="jobs-doc" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Choisir le bon type de job</h3>
                <div className="mt-4 overflow-hidden rounded-md border">
                  {[
                    ["Site", "Une API ou une page doit répondre", "URL + statut HTTP attendu"],
                    ["Machine", "Un service doit écouter sur un port", "Host + port TCP"],
                    ["Réseau", "Une box, un réseau ou un VLAN doit rester disponible", "Ping multi-cibles + timer de panne"],
                    ["Notification", "Un message doit partir à une fréquence donnée", "Message + destination"],
                    ["Rappel", "Une date précise ne doit pas être oubliée", "Date unique ou périodique"],
                    ["Workflow", "Plusieurs actions doivent s'enchaîner", "Blocs notify, http, tcp, condition, webhook"],
                  ].map(([typeName, need, config]) => (
                    <div key={typeName} className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[130px_1fr_1fr]">
                      <p className="font-medium">{typeName}</p>
                      <p className="text-muted-foreground">{need}</p>
                      <p className="text-muted-foreground">{config}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section id="network-doc" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Suivi réseau</h3>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Le suivi réseau ping plusieurs cibles depuis le conteneur. Il démarre un timer quand la panne est confirmée, puis calcule la durée au retour OK. Les seuils consécutifs évitent les faux positifs et les retours instables.
                </p>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="overflow-hidden rounded-md border">
                    {[
                      ["Cibles", "Routeur | 192.168.1.1 et DNS | 1.1.1.1"],
                      ["Cibles minimum", "1 si au moins une cible suffit à dire que le réseau répond"],
                      ["Échecs avant panne", "2 ou 3 pour éviter une alerte sur micro-coupure"],
                      ["Succès avant retour OK", "2 pour éviter un rétablissement trop optimiste"],
                      ["Rappel panne", "30 ou 60 minutes, 0 pour désactiver"],
                    ].map(([label, value]) => (
                      <div key={label} className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[150px_1fr]">
                        <p className="font-medium">{label}</p>
                        <p className="text-muted-foreground">{value}</p>
                      </div>
                    ))}
                  </div>
                  <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">{`Routeur | 192.168.1.1
DNS Cloudflare | 1.1.1.1

Fréquence: toutes les 1 à 5 minutes
Échecs avant panne: 2
Succès avant retour OK: 2
Notifier au rétablissement: oui`}</pre>
                </div>
              </section>

              <section id="workflow-doc" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Workflows et variables</h3>
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="overflow-hidden rounded-md border">
                    {[
                      ["notify", "Envoyer une notification"],
                      ["http", "Tester une URL et récupérer STATUS / RESPONSE_TIME"],
                      ["tcp", "Tester un host et un port"],
                      ["condition", "Vérifier une variable avant de continuer"],
                      ["webhook", "Appeler une URL externe"],
                      ["wait", "Attendre quelques secondes"],
                    ].map(([block, role]) => (
                      <div key={block} className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[110px_1fr]">
                        <code>{block}</code>
                        <p className="text-muted-foreground">{role}</p>
                      </div>
                    ))}
                  </div>
                  <div className="rounded-md border p-3">
                    <p className="text-sm font-medium">Variables disponibles</p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {["$JOB_NAME", "$NOW", "$STATUS", "$RESPONSE_TIME", "$URL", "$HOST", "$PORT"].map((variable) => (
                        <code key={variable} className="rounded-md border bg-muted/40 px-2 py-1 text-xs">{variable}</code>
                      ))}
                    </div>
                  </div>
                </div>
              </section>

              <section id="ops-doc" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Opérations courantes</h3>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {[
                    ["Exécuter", "Teste un job immédiatement sans attendre sa prochaine planification."],
                    ["Pause", "Désactive le job et retire son prochain passage."],
                    ["Reprendre", "Réactive le job et recalcule un prochain passage."],
                    ["Dupliquer", "Crée une copie en pause pour préparer une variante."],
                    ["Dead-man", "Surveille une tâche externe qui doit appeler une URL de ping."],
                    ["Maintenance", "Suspend les alertes pendant une intervention prévue."],
                  ].map(([title, body]) => (
                    <div key={title} className="rounded-md border p-3">
                      <p className="text-sm font-medium">{title}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section id="api-doc" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">API publique</h3>
                <p className="mt-3 text-sm text-muted-foreground">
                  Base URL: <code>{API_URL}/api/v1</code>. Authentification: <code>Authorization: Bearer change-me-dev-key</code> ou <code>x-api-key</code>.
                </p>
                <div className="mt-4 overflow-hidden rounded-md border">
                  {[
                    ["GET", "/health", "Santé API"],
                    ["GET", "/jobs", "Lister les jobs"],
                    ["POST", "/jobs", "Créer un job"],
                    ["POST", "/jobs/:id/run", "Lancer maintenant"],
                    ["POST", "/jobs/:id/webhook", "Déclencher avec payload"],
                    ["POST", "/jobs/:id/duplicate", "Dupliquer en pause"],
                    ["POST", "/jobs/:id/pause", "Mettre en pause"],
                    ["POST", "/jobs/:id/resume", "Reprendre"],
                    ["GET", "/jobs/:id/runs", "Lire l'historique"],
                  ].map(([method, route, role]) => (
                    <div key={`${method}-${route}`} className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[80px_220px_1fr]">
                      <code>{method}</code>
                      <code>{route}</code>
                      <p className="text-muted-foreground">{role}</p>
                    </div>
                  ))}
                </div>
                <pre className="mt-4 overflow-x-auto rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">{`curl -X POST ${API_URL}/api/v1/jobs \\
  -H "authorization: Bearer change-me-dev-key" \\
  -H "content-type: application/json" \\
  -d '{
    "name": "Suivi réseau",
    "type": "network_monitor",
    "schedule": { "mode": "every_minutes", "value": 1 },
    "config": {
      "targets": [{ "label": "Routeur", "host": "192.168.1.1" }],
      "failureThreshold": 2,
      "recoveryThreshold": 2,
      "notifyOnRecovery": true
    }
  }'`}</pre>
              </section>

              <section id="troubleshooting-doc" className="rounded-lg border bg-card p-5">
                <h3 className="font-semibold">Dépannage</h3>
                <div className="mt-4 overflow-hidden rounded-md border">
                  {[
                    ["Ping réseau toujours KO", "La cible bloque peut-être ICMP. Essaie 127.0.0.1, puis utilise Machine TCP si ICMP est filtré."],
                    ["Trop d'alertes", "Augmente les seuils consécutifs, ajoute des retries ou crée une maintenance."],
                    ["Pas de notification", "Teste les notifications dans Settings, puis vérifie les destinations locales du job."],
                    ["Job qui ne part pas", "Vérifie qu'il est actif, regarde son prochain passage, puis lance une exécution manuelle."],
                    ["API 401", "Vérifie la clé dans Authorization Bearer ou x-api-key."],
                  ].map(([problem, fix]) => (
                    <div key={problem} className="grid gap-2 border-b p-3 text-sm last:border-b-0 md:grid-cols-[220px_1fr]">
                      <p className="font-medium">{problem}</p>
                      <p className="text-muted-foreground">{fix}</p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
