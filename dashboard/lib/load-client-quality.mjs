/**
 * Доска «Качество работы с клиентами».
 * События приходят через POST /api/clientquality/events (сессия или CLIENT_QUALITY_INGEST_TOKEN),
 * хранятся в data/client-quality.json, отдаются GET /api/clientquality и GET /api/clientqualitytv.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(root, "data");
const STORE_PATH = join(DATA_DIR, "client-quality.json");
const STORE_TMP = join(DATA_DIR, "client-quality.json.tmp");

const SECTION_KEYS = [
  "managers",
  "openPromises",
  "negativity",
  "dueThisWeek",
  "ping",
  "faqCandidates",
  "customAnswers",
];

function emptyBoard() {
  return {
    generatedAt: null,
    source: "empty",
    period: null,
    week: null,
    stats: {},
    managers: [],
    openPromises: [],
    negativity: [],
    dueThisWeek: [],
    ping: [],
    faqCandidates: [],
    customAnswers: [],
    tvSections: [],
    events: [],
  };
}

function normalizeTvSections(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    let key = String(raw || "").trim();
    if (!key) key = "customAnswers";
    if (!SECTION_KEYS.includes(key)) key = "customAnswers";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeBoard(raw) {
  const base = emptyBoard();
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    managers: Array.isArray(raw.managers) ? raw.managers : [],
    openPromises: Array.isArray(raw.openPromises) ? raw.openPromises : [],
    negativity: Array.isArray(raw.negativity) ? raw.negativity : [],
    dueThisWeek: Array.isArray(raw.dueThisWeek) ? raw.dueThisWeek : [],
    ping: Array.isArray(raw.ping) ? raw.ping : [],
    faqCandidates: Array.isArray(raw.faqCandidates) ? raw.faqCandidates : [],
    customAnswers: Array.isArray(raw.customAnswers) ? raw.customAnswers : [],
    tvSections: normalizeTvSections(raw.tvSections),
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

export function readClientQualityStore() {
  if (!existsSync(STORE_PATH)) return emptyBoard();
  try {
    return normalizeBoard(JSON.parse(readFileSync(STORE_PATH, "utf8")));
  } catch (err) {
    console.warn("client-quality.json read failed:", err.message || err);
    return emptyBoard();
  }
}

function writeStore(board) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const body = JSON.stringify(board, null, 2);
  writeFileSync(STORE_TMP, body, "utf8");
  try {
    unlinkSync(STORE_PATH);
  } catch {
    /* ok */
  }
  renameSync(STORE_TMP, STORE_PATH);
}

/** Публичный снимок для UI (без сырого лога events). */
export function loadClientQuality() {
  const store = readClientQualityStore();
  const { events, ...rest } = store;
  return {
    ...rest,
    tvSections: normalizeTvSections(store.tvSections),
    eventsCount: Array.isArray(events) ? events.length : 0,
  };
}

/** Тот же снимок, но только секции из tvSections (доска для ТВ). */
export function loadClientQualityTv() {
  const full = loadClientQuality();
  const allow = new Set(full.tvSections || []);
  const next = { ...full, tv: true };
  for (const key of SECTION_KEYS) {
    next[key] = allow.has(key) ? full[key] : [];
  }
  return next;
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function upsertById(list, item) {
  const id = String(item.id || "");
  if (!id) {
    list.push(item);
    return;
  }
  const idx = list.findIndex((x) => String(x.id) === id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.push(item);
}

/**
 * Принять события от Cursor / внешнего обработчика.
 * @param {object} body
 * @param {{ replace?: boolean, source?: string }} [opts]
 */
export function ingestClientQualityEvents(body, opts = {}) {
  const events = Array.isArray(body?.events) ? body.events : Array.isArray(body) ? body : null;
  if (!events) throw new Error("Ожидается { events: [...] } или массив событий");

  const replace = opts.replace === true || body?.replace === true;
  const store = replace ? emptyBoard() : readClientQualityStore();
  if (replace) store.events = [];

  if (body?.period) store.period = body.period;
  if (body?.week) store.week = body.week;
  if (body?.stats && typeof body.stats === "object") store.stats = { ...store.stats, ...body.stats };
  for (const key of SECTION_KEYS) {
    if (Array.isArray(body?.[key])) store[key] = body[key];
  }
  if (Array.isArray(body?.tvSections)) store.tvSections = normalizeTvSections(body.tvSections);

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const type = String(raw.type || raw.section || "").trim();
    const payload = raw.payload && typeof raw.payload === "object" ? raw.payload : raw;
    const item = {
      ...payload,
      id: payload.id || raw.id || newId(type || "evt"),
      status: payload.status || raw.status || "open",
    };
    delete item.type;
    delete item.section;
    delete item.payload;

    if (type === "managers" || type === "manager_stats") {
      // full replace of managers table if array in payload.managers
      if (Array.isArray(payload.managers)) store.managers = payload.managers;
      else if (payload.manager || payload.managerKey) upsertById(store.managers, item);
    } else if (type === "openPromise" || type === "openPromises" || type === "promise") {
      upsertById(store.openPromises, item);
    } else if (type === "negativity" || type === "negative") {
      upsertById(store.negativity, item);
    } else if (type === "dueThisWeek" || type === "due") {
      upsertById(store.dueThisWeek, item);
    } else if (type === "ping") {
      upsertById(store.ping, item);
    } else if (type === "faq" || type === "faqCandidate" || type === "faqCandidates") {
      upsertById(store.faqCandidates, item);
    } else if (type === "custom" || type === "customAnswer" || type === "customAnswers") {
      if (Array.isArray(payload.customAnswers)) store.customAnswers = payload.customAnswers;
      else upsertById(store.customAnswers, item);
    } else if (type === "board" && payload && typeof payload === "object") {
      for (const key of SECTION_KEYS) {
        if (Array.isArray(payload[key])) store[key] = payload[key];
      }
    }

    store.events.push({
      id: raw.id || item.id,
      type: type || "unknown",
      at: raw.at || new Date().toISOString(),
      source: opts.source || body?.source || "api",
    });
  }

  // keep last 500 event log entries
  if (store.events.length > 500) store.events = store.events.slice(-500);

  store.generatedAt = new Date().toISOString();
  store.source = opts.source || body?.source || store.source || "api";
  writeStore(store);
  return loadClientQuality();
}

/** Полная замена снимка доски (seed / ручная публикация). */
export function replaceClientQualityBoard(board, source = "replace") {
  const next = normalizeBoard(board);
  next.generatedAt = new Date().toISOString();
  next.source = source;
  if (!Array.isArray(next.events)) next.events = [];
  writeStore(next);
  return loadClientQuality();
}

export function clientQualityStorePath() {
  return STORE_PATH;
}
