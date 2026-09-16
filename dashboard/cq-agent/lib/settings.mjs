import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { odataConfig } from "../../lib/odata.mjs";

const agentDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardDir = join(agentDir, "..");
const DATA_DIR = join(dashboardDir, "data");
const SETTINGS_PATH = join(DATA_DIR, "cq-agent-settings.json");
const SETTINGS_TMP = join(DATA_DIR, "cq-agent-settings.json.tmp");

function loadDashboardEnv() {
  const envPath = join(dashboardDir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 1) continue;
    const key = text.slice(0, eq).trim();
    let val = text.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = val;
  }
}
loadDashboardEnv();

export const DEFAULT_LOOKBACK_MONTHS = 3;

export const DEFAULT_QUESTIONS = [
  { id: "managers", text: "Среднее время реакции по менеджерам", enabled: true, tv: false, months: 3, section: "managers" },
  { id: "openPromises", text: "Что пообещали и не закрыли в чате", enabled: true, tv: false, months: 3, section: "openPromises" },
  { id: "negativity", text: "Клиенты, где в чате есть негатив", enabled: true, tv: false, months: 3, section: "negativity" },
  { id: "dueThisWeek", text: "Кому должны ответ или обещанный срок на этой неделе", enabled: true, tv: false, months: 3, section: "dueThisWeek" },
  { id: "ping", text: "Кого из клиентов стоит пропинговать (молчит / ждёт нас)", enabled: true, tv: false, months: 3, section: "ping" },
  { id: "faqCandidates", text: "Повторяющиеся вопросы — кандидаты в инструкцию / FAQ", enabled: true, tv: false, months: 3, section: "faqCandidates" },
];

function emptySettings() {
  return {
    cukUrl: "",
    ingestToken: "",
    cursorApiKey: "",
    agentId: "",
    odataUrl: "",
    odataUser: "",
    odataPassword: "",
    intervalHours: 2,
    days: [1, 2, 3, 4, 5],
    timeFrom: "09:00",
    timeTo: "18:00",
    timezone: "Europe/Moscow",
    questions: DEFAULT_QUESTIONS.map((q) => ({ ...q })),
    resolvedItems: [],
    lastTick: null,
    lastSlot: null,
  };
}

export function normalizeMonths(value) {
  if (value == null || value === "") return DEFAULT_LOOKBACK_MONTHS;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LOOKBACK_MONTHS;
  if (n <= 0) return 0;
  return Math.min(36, Math.round(n));
}

function normalizeQuestions(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_QUESTIONS.map((q) => ({ ...q }));
  return list
    .map((q, i) => ({
      id: String(q?.id || `q-${i + 1}`).trim() || `q-${i + 1}`,
      text: String(q?.text || "").trim(),
      enabled: q?.enabled !== false,
      tv: q?.tv === true,
      months: normalizeMonths(q?.months),
      section: String(q?.section || "").trim(),
    }))
    .filter((q) => q.text);
}

/** Вычесть календарные месяцы, вернуть ISO. months=0 → null (весь кэш). */
export function monthsAgoIso(months, now = new Date()) {
  const n = normalizeMonths(months);
  if (n <= 0) return null;
  const d = new Date(now.getTime());
  d.setMonth(d.getMonth() - n);
  return d.toISOString();
}

/**
 * Окно анализа по включённым вопросам: самое широкое (max месяцев).
 * months=0 у любого включённого вопроса → весь кэш.
 */
export function analysisWindow(questions, now = new Date()) {
  const enabled = (questions || []).filter((q) => q.enabled !== false);
  const source = enabled.length ? enabled : [{ months: DEFAULT_LOOKBACK_MONTHS }];
  if (source.some((q) => normalizeMonths(q.months) === 0)) {
    return { months: 0, from: null, to: now.toISOString() };
  }
  const months = Math.max(...source.map((q) => normalizeMonths(q.months)));
  return { months, from: monthsAgoIso(months, now), to: now.toISOString() };
}

export function questionPeriodLabel(q) {
  const months = normalizeMonths(q?.months);
  if (months === 0) return "весь кэш";
  const from = monthsAgoIso(months);
  const fromDay = from ? from.slice(0, 10) : "";
  return `последние ${months} мес.${fromDay ? `, с ${fromDay}` : ""}`;
}

function applyEnvFallbacks(s) {
  if (!s.cukUrl) s.cukUrl = String(process.env.CLIENT_QUALITY_POST_URL || "").replace(/\/+$/, "");
  if (!s.ingestToken) s.ingestToken = String(process.env.CLIENT_QUALITY_INGEST_TOKEN || "");
  if (!s.cursorApiKey) s.cursorApiKey = String(process.env.CURSOR_API_KEY || "");
  return s;
}

export function loadSettings() {
  const base = applyEnvFallbacks(emptySettings());
  if (!existsSync(SETTINGS_PATH)) return base;
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    return applyEnvFallbacks({
      ...base,
      ...raw,
      intervalHours: Math.max(1, Number(raw.intervalHours) || 2),
      days: Array.isArray(raw.days) && raw.days.length ? raw.days.map(Number) : base.days,
      questions: normalizeQuestions(raw.questions),
      resolvedItems: Array.isArray(raw.resolvedItems) ? raw.resolvedItems : [],
    });
  } catch (err) {
    console.warn("cq-agent settings read failed:", err.message || err);
    return base;
  }
}

export function saveSettings(next) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_TMP, JSON.stringify(next, null, 2), "utf8");
  try {
    unlinkSync(SETTINGS_PATH);
  } catch {
    /* ok */
  }
  renameSync(SETTINGS_TMP, SETTINGS_PATH);
  return next;
}

export function publicSettings(s) {
  return {
    cukUrl: s.cukUrl || "",
    ingestTokenSet: Boolean(s.ingestToken),
    cursorApiKeySet: Boolean(s.cursorApiKey),
    agentId: s.agentId || "",
    odataUrl: s.odataUrl || "",
    odataUser: s.odataUser || "",
    odataPasswordSet: Boolean(s.odataPassword),
    intervalHours: s.intervalHours,
    days: s.days,
    timeFrom: s.timeFrom,
    timeTo: s.timeTo,
    timezone: s.timezone,
    questions: s.questions,
    resolvedItems: Array.isArray(s.resolvedItems) ? s.resolvedItems : [],
    lastTick: s.lastTick,
    lastSlot: s.lastSlot || null,
  };
}

export function applyPatch(current, patch) {
  const next = { ...current };
  if (patch.cukUrl != null) next.cukUrl = String(patch.cukUrl).trim().replace(/\/+$/, "");
  if (patch.ingestToken != null && String(patch.ingestToken).trim()) {
    let tok = String(patch.ingestToken).trim().replace(/^CLIENT_QUALITY_INGEST_TOKEN\s*=\s*/i, "");
    if ((tok.startsWith('"') && tok.endsWith('"')) || (tok.startsWith("'") && tok.endsWith("'"))) {
      tok = tok.slice(1, -1);
    }
    next.ingestToken = tok.trim();
  }
  if (patch.cursorApiKey != null && String(patch.cursorApiKey).trim()) next.cursorApiKey = String(patch.cursorApiKey).trim();
  if (patch.agentId != null) next.agentId = String(patch.agentId).trim();
  if (patch.odataUrl != null) next.odataUrl = String(patch.odataUrl).trim();
  if (patch.odataUser != null) next.odataUser = String(patch.odataUser).trim();
  if (patch.odataPassword != null && String(patch.odataPassword).trim()) {
    next.odataPassword = String(patch.odataPassword);
  }
  if (patch.intervalHours != null) next.intervalHours = Math.max(1, Number(patch.intervalHours) || 2);
  if (Array.isArray(patch.days)) next.days = patch.days.map(Number).filter((d) => d >= 1 && d <= 7);
  if (patch.timeFrom != null) next.timeFrom = String(patch.timeFrom).trim() || "09:00";
  if (patch.timeTo != null) next.timeTo = String(patch.timeTo).trim() || "18:00";
  if (patch.timezone != null) next.timezone = String(patch.timezone).trim() || "Europe/Moscow";
  if (Array.isArray(patch.questions)) next.questions = normalizeQuestions(patch.questions);
  if (Array.isArray(patch.resolvedItems)) next.resolvedItems = patch.resolvedItems;
  return next;
}

export function tradeCreds(settings) {
  if (settings.odataUrl && settings.odataUser && settings.odataPassword) {
    const url = settings.odataUrl.endsWith("/") ? settings.odataUrl : `${settings.odataUrl}/`;
    return {
      base: url,
      authHeader: `Basic ${Buffer.from(`${settings.odataUser}:${settings.odataPassword}`).toString("base64")}`,
      host: new URL(url).host,
    };
  }
  const fromEnv = odataConfig("trade");
  return { base: fromEnv.base, authHeader: fromEnv.authHeader, host: fromEnv.host };
}

export function tvSectionsFromQuestions(questions) {
  const seen = new Set();
  const keys = [];
  for (const q of questions || []) {
    if (q?.tv !== true) continue;
    const section = String(q.section || "customAnswers").trim() || "customAnswers";
    if (seen.has(section)) continue;
    seen.add(section);
    keys.push(section);
  }
  return keys;
}

export { DATA_DIR, dashboardDir, agentDir };
