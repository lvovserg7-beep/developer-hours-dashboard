import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SEO_DAILY_CSV = join(root, "data", "seo-daily.csv");
export const SEO_QUERIES_CSV = join(root, "data", "seo-queries.csv");
export const SEO_QUERY_CLASS_CSV = join(root, "data", "seo-query-class.csv");
export const SEO_QUERY_DAILY_CSV = join(root, "data", "seo-query-daily.csv");

const DAILY_HEADER = ["source", "site", "date", "clicks", "impressions", "ctr", "position"];
const QUERY_HEADER = [
  "source",
  "site",
  "period_from",
  "period_to",
  "query",
  "clicks",
  "impressions",
  "ctr",
  "position",
];
const CLASS_HEADER = ["query", "product"];
const QUERY_DAILY_HEADER = ["source", "site", "date", "query", "clicks", "impressions", "ctr", "position"];

function escapeCsv(value) {
  const s = String(value ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function readCsv(path, header) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const cols = parseCsvLine(lines[0]).map((c) => c.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = parseCsvLine(line);
    const obj = {};
    for (let i = 0; i < header.length; i += 1) {
      const key = header[i];
      const idx = cols.indexOf(key);
      obj[key] = idx >= 0 ? parts[idx] ?? "" : parts[i] ?? "";
    }
    rows.push(obj);
  }
  return rows;
}

function writeCsv(path, header, rows) {
  mkdirSync(dirname(path), { recursive: true });
  const body = rows.map((row) => header.map((h) => escapeCsv(row[h])).join(",")).join("\n");
  writeFileSync(path, `${header.join(",")}\n${body}${rows.length ? "\n" : ""}`, "utf8");
}

function num(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeDailyRow(row) {
  return {
    source: String(row.source || "").trim(),
    site: String(row.site || "").trim(),
    date: String(row.date || "").trim().slice(0, 10),
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    ctr: num(row.ctr),
    position: num(row.position),
  };
}

function normalizeQueryRow(row) {
  return {
    source: String(row.source || "").trim(),
    site: String(row.site || "").trim(),
    period_from: String(row.period_from || "").trim().slice(0, 10),
    period_to: String(row.period_to || "").trim().slice(0, 10),
    query: String(row.query || "").trim(),
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    ctr: num(row.ctr),
    position: num(row.position),
  };
}

function normalizeQueryDailyRow(row) {
  return {
    source: String(row.source || "").trim(),
    site: String(row.site || "").trim(),
    date: String(row.date || "").trim().slice(0, 10),
    query: String(row.query || "").trim(),
    clicks: num(row.clicks),
    impressions: num(row.impressions),
    ctr: num(row.ctr),
    position: num(row.position),
  };
}

export function readDailyRows() {
  return readCsv(SEO_DAILY_CSV, DAILY_HEADER).map(normalizeDailyRow).filter((r) => r.source && r.site && r.date);
}

export function readQueryRows() {
  return readCsv(SEO_QUERIES_CSV, QUERY_HEADER)
    .map(normalizeQueryRow)
    .filter((r) => r.source && r.site && r.query);
}

/** Максимальная дата в daily CSV для источника+сайта, или null. */
export function maxDailyDate(source, site) {
  let max = null;
  for (const row of readDailyRows()) {
    if (row.source !== source || row.site !== site) continue;
    if (!max || row.date > max) max = row.date;
  }
  return max;
}

export function hasDailyDate(source, site, date) {
  const d = String(date || "").slice(0, 10);
  return readDailyRows().some((r) => r.source === source && r.site === site && r.date === d);
}

/**
 * Дописать/заменить дневные строки (ключ source+site+date).
 * @param {Array<ReturnType<typeof normalizeDailyRow>>} incoming
 */
export function upsertDailyRows(incoming) {
  const map = new Map();
  for (const row of readDailyRows()) {
    map.set(`${row.source}\t${row.site}\t${row.date}`, row);
  }
  for (const raw of incoming || []) {
    const row = normalizeDailyRow(raw);
    if (!row.source || !row.site || !row.date) continue;
    map.set(`${row.source}\t${row.site}\t${row.date}`, row);
  }
  const rows = [...map.values()].sort((a, b) =>
    a.source !== b.source
      ? a.source.localeCompare(b.source)
      : a.site !== b.site
        ? a.site.localeCompare(b.site)
        : a.date.localeCompare(b.date)
  );
  writeCsv(SEO_DAILY_CSV, DAILY_HEADER, rows);
  return rows.length;
}

/**
 * Заменить топ-запросы для source+site (остальные источники не трогаем).
 * @param {string} source
 * @param {string} site
 * @param {Array<ReturnType<typeof normalizeQueryRow>>} incoming
 */
export function replaceQueryRows(source, site, incoming) {
  const keep = readQueryRows().filter((r) => !(r.source === source && r.site === site));
  const next = (incoming || []).map(normalizeQueryRow).filter((r) => r.source && r.site && r.query);
  const rows = [...keep, ...next].sort((a, b) =>
    a.source !== b.source
      ? a.source.localeCompare(b.source)
      : a.site !== b.site
        ? a.site.localeCompare(b.site)
        : b.clicks - a.clicks || a.query.localeCompare(b.query)
  );
  writeCsv(SEO_QUERIES_CSV, QUERY_HEADER, rows);
  return next.length;
}

export function readQueryClassRows() {
  return readCsv(SEO_QUERY_CLASS_CSV, CLASS_HEADER)
    .map((r) => ({
      query: String(r.query || "").trim(),
      product: String(r.product || "").trim(),
    }))
    .filter((r) => r.query && r.product);
}

/** Карта lowercase(query) → product id. */
export function readQueryClassMap() {
  const map = new Map();
  for (const row of readQueryClassRows()) {
    map.set(row.query.toLowerCase(), row.product);
  }
  return map;
}

/**
 * Дописать классификации для новых запросов (существующие не перезаписываем).
 * @param {Array<{ query: string, product: string }>} incoming
 */
export function upsertQueryClasses(incoming) {
  const map = new Map();
  for (const row of readQueryClassRows()) {
    map.set(row.query.toLowerCase(), { query: row.query, product: row.product });
  }
  let added = 0;
  for (const raw of incoming || []) {
    const query = String(raw.query || "").trim();
    const product = String(raw.product || "").trim();
    if (!query || !product) continue;
    const key = query.toLowerCase();
    if (map.has(key)) continue;
    map.set(key, { query, product });
    added += 1;
  }
  const rows = [...map.values()].sort((a, b) => a.query.localeCompare(b.query, "ru"));
  writeCsv(SEO_QUERY_CLASS_CSV, CLASS_HEADER, rows);
  return { total: rows.length, added };
}

/**
 * Перезаписать product у известных запросов (для разовой переклассификации).
 * @param {Array<{ query: string, product: string }>} incoming
 */
export function overwriteQueryClasses(incoming) {
  const map = new Map();
  for (const row of readQueryClassRows()) {
    map.set(row.query.toLowerCase(), { query: row.query, product: row.product });
  }
  let updated = 0;
  let added = 0;
  for (const raw of incoming || []) {
    const query = String(raw.query || "").trim();
    const product = String(raw.product || "").trim();
    if (!query || !product) continue;
    const key = query.toLowerCase();
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { query, product });
      added += 1;
      continue;
    }
    if (prev.product !== product) {
      map.set(key, { query: prev.query || query, product });
      updated += 1;
    }
  }
  const rows = [...map.values()].sort((a, b) => a.query.localeCompare(b.query, "ru"));
  writeCsv(SEO_QUERY_CLASS_CSV, CLASS_HEADER, rows);
  return { total: rows.length, updated, added };
}

export function readQueryDailyRows() {
  return readCsv(SEO_QUERY_DAILY_CSV, QUERY_DAILY_HEADER)
    .map(normalizeQueryDailyRow)
    .filter((r) => r.source && r.site && r.date && r.query);
}

/**
 * Дописать/заменить дневные позиции запросов (ключ source+site+date+query).
 * @param {Array<ReturnType<typeof normalizeQueryDailyRow>>} incoming
 */
export function upsertQueryDailyRows(incoming) {
  const map = new Map();
  for (const row of readQueryDailyRows()) {
    map.set(`${row.source}\t${row.site}\t${row.date}\t${row.query.toLowerCase()}`, row);
  }
  let added = 0;
  for (const raw of incoming || []) {
    const row = normalizeQueryDailyRow(raw);
    if (!row.source || !row.site || !row.date || !row.query) continue;
    const key = `${row.source}\t${row.site}\t${row.date}\t${row.query.toLowerCase()}`;
    if (!map.has(key)) added += 1;
    map.set(key, row);
  }
  const rows = [...map.values()].sort((a, b) =>
    a.source !== b.source
      ? a.source.localeCompare(b.source)
      : a.site !== b.site
        ? a.site.localeCompare(b.site)
        : a.query !== b.query
          ? a.query.localeCompare(b.query, "ru")
          : a.date.localeCompare(b.date)
  );
  writeCsv(SEO_QUERY_DAILY_CSV, QUERY_DAILY_HEADER, rows);
  return { total: rows.length, upserted: (incoming || []).length, added };
}
