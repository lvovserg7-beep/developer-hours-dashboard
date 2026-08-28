import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TABS, TAB_LABELS } from "./auth.mjs";
import {
  SEO_DAILY_CSV,
  SEO_QUERIES_CSV,
  SEO_QUERY_DAILY_CSV,
  SEO_WORDSTAT_CSV,
  purgeDailyRowsInRange,
  purgeQueryRowsInRange,
  purgeQueryDailyRowsInRange,
  purgeWordstatRowsInRange,
} from "./seo-csv.mjs";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const SNAPSHOT_PATH = join(DATA_DIR, "snapshot.json");

/**
 * @typedef {{
 *   id: string,
 *   kind: "hours" | "ozon" | "seo-daily" | "seo-queries" | "seo-wordstat" | "none",
 *   files?: string[],
 *   globPrefix?: string,
 *   note?: string,
 *   periodAware?: boolean
 * }} BoardCacheSpec
 */

/** Какие файлы кэша относятся к доске. Классификация SEO (seo-query-class.csv) не трогаем. */
const SPECS = {
  hours: {
    kind: "hours",
    files: [SNAPSHOT_PATH],
    periodAware: false,
    note: "Снимок часов в памяти и data/snapshot.json. Общий с «Активность». Период не применяется — чистится целиком.",
  },
  activity: {
    kind: "hours",
    files: [SNAPSHOT_PATH],
    periodAware: false,
    note: "Тот же снимок, что у «Часы». Период не применяется.",
  },
  ozon: {
    kind: "ozon",
    globPrefix: "ozon-cost-",
    periodAware: true,
    note: "Файлы data/ozon-cost-{с}_{по}_*.json. Удаляются файлы, чей период пересекается с выбранным.",
  },
  seo: {
    kind: "seo-daily",
    files: [SEO_DAILY_CSV],
    periodAware: true,
    note: "Строки data/seo-daily.csv с датой в выбранном периоде.",
  },
  seoqueries: {
    kind: "seo-queries",
    files: [SEO_QUERIES_CSV, SEO_QUERY_DAILY_CSV],
    periodAware: true,
    note: "seo-queries.csv (пересечение period_from…period_to) и seo-query-daily.csv (дата дня).",
  },
  seopositions: {
    kind: "seo-wordstat",
    files: [SEO_WORDSTAT_CSV],
    periodAware: true,
    note: "Wordstat: строки, у которых дата fetched_at попадает в период.",
  },
};

/** @type {{ inspect: () => { memory: boolean, stale?: boolean, updatedAt?: string | null }, clear: () => void } | null} */
let hoursHooks = null;

export function registerHoursCacheHooks(hooks) {
  hoursHooks = hooks;
}

function parseYmd(value) {
  const m = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * @param {string | undefined} fromRaw
 * @param {string | undefined} toRaw
 * @returns {{ from: string, to: string } | null}
 */
export function resolveCachePeriod(fromRaw, toRaw) {
  const from = parseYmd(fromRaw);
  const to = parseYmd(toRaw);
  if (!from && !to) return null;
  if (!from || !to) throw new Error("Укажите обе даты периода: «с» и «по»");
  if (from > to) throw new Error("Дата «с» не может быть позже «по»");
  return { from, to };
}

/** Период по умолчанию для UI: прошлый календарный месяц. */
export function defaultCacheClearPeriod() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), 0);
  const p = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { from: ymd(from), to: ymd(to) };
}

function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= bTo && aTo >= bFrom;
}

/** Имя ozon-cost-2026-08-01_2026-08-31_c1_r1.json → { from, to } */
function parseOzonCacheName(name) {
  const m = String(name || "").match(
    /^ozon-cost-(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})_c\d+_r\d+\.json$/i
  );
  if (!m) return null;
  return { from: m[1], to: m[2] };
}

function fileStat(path) {
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st.isFile()) return null;
    return {
      name: path.split(/[/\\]/).pop() || path,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function globOzonFiles(period) {
  if (!existsSync(DATA_DIR)) return [];
  return readdirSync(DATA_DIR)
    .filter((name) => name.startsWith("ozon-cost-") && name.endsWith(".json"))
    .map((name) => {
      const st = fileStat(join(DATA_DIR, name));
      if (!st) return null;
      const range = parseOzonCacheName(name);
      return { ...st, periodFrom: range?.from || null, periodTo: range?.to || null };
    })
    .filter(Boolean)
    .filter((f) => {
      if (!period) return true;
      if (!f.periodFrom || !f.periodTo) return false;
      return rangesOverlap(f.periodFrom, f.periodTo, period.from, period.to);
    });
}

function filesForSpec(spec, period) {
  if (spec.kind === "ozon") return globOzonFiles(period);
  return (spec.files || []).map((p) => fileStat(p)).filter(Boolean);
}

function describeBoard(id, period) {
  const spec = SPECS[id];
  const label = TAB_LABELS[id] || id;
  if (!spec || spec.kind === "none") {
    return {
      id,
      label,
      hasCache: false,
      canClear: false,
      periodAware: false,
      files: [],
      bytes: 0,
      memory: false,
      note: "Эта доска каждый раз запрашивает данные заново, отдельного кэша нет.",
    };
  }
  const files = filesForSpec(spec, period);
  const bytes = files.reduce((n, f) => n + (f.bytes || 0), 0);
  const hours = spec.kind === "hours" ? hoursHooks?.inspect?.() || { memory: false } : null;
  const memory = !!hours?.memory;
  const mtimes = files.map((f) => f.mtime).filter(Boolean);
  if (hours?.updatedAt) mtimes.push(hours.updatedAt);
  const updatedAt = mtimes.length ? mtimes.sort().at(-1) : null;
  const periodAware = !!spec.periodAware;
  // Для периодных досок без периода в запросе — canClear по наличию файлов;
  // при заданном периоде — если есть что удалить (для CSV всегда можно попробовать, если файл есть).
  let canClear = false;
  if (spec.kind === "hours") {
    canClear = files.length > 0 || memory;
  } else if (periodAware) {
    if (spec.kind === "ozon") canClear = files.length > 0;
    else canClear = files.length > 0;
  }
  return {
    id,
    label,
    hasCache: true,
    canClear,
    periodAware,
    files,
    bytes,
    memory,
    stale: hours?.stale || false,
    updatedAt,
    note: spec.note || "",
  };
}

export function listBoardCaches(period = null) {
  return TABS.map((id) => describeBoard(id, period));
}

function unlinkQuiet(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* файл мог исчезнуть */
  }
}

function clearHours() {
  hoursHooks?.clear?.();
  let removed = 0;
  if (existsSync(SNAPSHOT_PATH)) {
    unlinkQuiet(SNAPSHOT_PATH);
    removed += 1;
  }
  return { removed: Math.max(removed, 1), rows: 0 };
}

function clearOzon(period) {
  const files = globOzonFiles(period);
  for (const f of files) unlinkQuiet(join(DATA_DIR, f.name));
  return { removed: files.length, rows: 0 };
}

function clearSeoDaily(period) {
  if (!period) {
    if (existsSync(SEO_DAILY_CSV)) {
      unlinkQuiet(SEO_DAILY_CSV);
      return { removed: 1, rows: 0 };
    }
    return { removed: 0, rows: 0 };
  }
  const rows = purgeDailyRowsInRange(period.from, period.to);
  return { removed: rows > 0 ? 1 : 0, rows };
}

function clearSeoQueries(period) {
  if (!period) {
    let removed = 0;
    for (const p of [SEO_QUERIES_CSV, SEO_QUERY_DAILY_CSV]) {
      if (existsSync(p)) {
        unlinkQuiet(p);
        removed += 1;
      }
    }
    return { removed, rows: 0 };
  }
  const q = purgeQueryRowsInRange(period.from, period.to);
  const d = purgeQueryDailyRowsInRange(period.from, period.to);
  return { removed: q + d > 0 ? 1 : 0, rows: q + d };
}

function clearWordstat(period) {
  if (!period) {
    if (existsSync(SEO_WORDSTAT_CSV)) {
      unlinkQuiet(SEO_WORDSTAT_CSV);
      return { removed: 1, rows: 0 };
    }
    return { removed: 0, rows: 0 };
  }
  const rows = purgeWordstatRowsInRange(period.from, period.to);
  return { removed: rows > 0 ? 1 : 0, rows };
}

function clearSpec(id, period) {
  const spec = SPECS[id];
  if (!spec) return { removed: 0, rows: 0 };
  if (spec.kind === "hours") return clearHours();
  if (spec.kind === "ozon") return clearOzon(period);
  if (spec.kind === "seo-daily") return clearSeoDaily(period);
  if (spec.kind === "seo-queries") return clearSeoQueries(period);
  if (spec.kind === "seo-wordstat") return clearWordstat(period);
  return { removed: 0, rows: 0 };
}

/**
 * @param {string} id — id доски или «all»
 * @param {{ from?: string, to?: string } | null} [periodOpts]
 */
export function clearBoardCache(id, periodOpts = null) {
  const key = String(id || "").trim();
  const period = resolveCachePeriod(periodOpts?.from, periodOpts?.to);
  if (key === "all") {
    if (!period) throw new Error("Укажите период очистки (с и по)");
    const seen = new Set();
    let removed = 0;
    let rows = 0;
    const skipped = [];
    for (const tab of TABS) {
      if (!SPECS[tab]) continue;
      // Часы/активность без привязки к датам — при очистке «за период» не трогаем.
      if (SPECS[tab].kind === "hours") {
        if (!seen.has("hours")) {
          seen.add("hours");
          skipped.push(TAB_LABELS[tab] || tab);
        }
        continue;
      }
      if (seen.has(tab)) continue;
      seen.add(tab);
      const result = clearSpec(tab, period);
      removed += result.removed || 0;
      rows += result.rows || 0;
    }
    return { board: "all", removed, rows, period, skipped };
  }
  if (!TABS.includes(key)) throw new Error("Нет такой доски");
  if (!SPECS[key]) throw new Error("У этой доски нет кэша");
  const spec = SPECS[key];
  if (spec.periodAware && !period) throw new Error("Укажите период очистки (с и по)");
  // Часы: снимок без разреза по датам — всегда целиком (период в UI игнорируется).
  if (spec.kind === "hours") {
    const result = clearHours();
    return { board: key, removed: result.removed, rows: 0, period: null, full: true };
  }
  const result = clearSpec(key, period);
  return { board: key, removed: result.removed, rows: result.rows || 0, period };
}

export { SNAPSHOT_PATH };
