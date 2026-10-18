import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ozonSellerConfigured, ozonSellerPost } from "./ozon-seller.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(root, "data", "ozon-stocks");
const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ensureDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function snapshotPath(dateText) {
  return join(DATA_DIR, `${dateText}.json`);
}

/** Календарная дата в Europe/Moscow (YYYY-MM-DD). */
export function moscowDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** Часы и минуты в Europe/Moscow. */
export function moscowClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value || 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value || 0);
  return { hour, minute };
}

function normalizeRow(raw) {
  const warehouse = String(raw.warehouse_name || raw.warehouse || "").trim();
  const offerId = String(raw.item_code || raw.offer_id || "").trim();
  const name = String(raw.item_name || raw.name || "").trim();
  const sku = raw.sku == null || raw.sku === "" ? "" : String(raw.sku);
  const free = num(raw.free_to_sell_amount ?? raw.free);
  const reserved = num(raw.reserved_amount ?? raw.reserved);
  const promised = num(raw.promised_amount ?? raw.promised);
  return {
    sku,
    offerId,
    name,
    warehouse,
    free,
    reserved,
    promised,
    total: free + reserved + promised,
  };
}

/**
 * Полная выгрузка остатков FBO по складам Ozon.
 * Метод: POST /v2/analytics/stock_on_warehouses
 */
export async function fetchOzonWarehouseStocks() {
  if (!ozonSellerConfigured()) {
    throw new Error(
      "Ozon Seller API не настроен. Укажите OZON_SELLER_CLIENT_ID и OZON_SELLER_API_KEY в dashboard/.env"
    );
  }
  const rows = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await ozonSellerPost("/v2/analytics/stock_on_warehouses", {
      limit: PAGE_LIMIT,
      offset,
      warehouse_type: "ALL",
    });
    const chunk = Array.isArray(data?.result?.rows) ? data.result.rows : Array.isArray(data?.rows) ? data.rows : [];
    if (!chunk.length) break;
    for (const raw of chunk) rows.push(normalizeRow(raw));
    offset += chunk.length;
    if (chunk.length < PAGE_LIMIT) break;
  }
  return buildSnapshotPayload({
    date: moscowDateKey(),
    capturedAt: new Date().toISOString(),
    source: "live",
    rows,
  });
}

function buildSnapshotPayload({ date, capturedAt, source, rows }) {
  const warehouses = [...new Set(rows.map((r) => r.warehouse).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ru")
  );
  const totals = rows.reduce(
    (acc, row) => {
      acc.free += row.free;
      acc.reserved += row.reserved;
      acc.promised += row.promised;
      acc.total += row.total;
      return acc;
    },
    { free: 0, reserved: 0, promised: 0, total: 0, rows: rows.length }
  );
  return {
    date,
    capturedAt,
    source,
    warehouses,
    totals,
    rows,
  };
}

/** Сохранить снимок за календарный день (МСК). Уже существующий файл не перезаписываем, если overwrite=false. */
export async function saveOzonStocksSnapshot({ source = "schedule", overwrite = false, dateText } = {}) {
  const date = dateText || moscowDateKey();
  ensureDir();
  const path = snapshotPath(date);
  if (!overwrite && existsSync(path)) {
    return { skipped: true, path, date, reason: "already_exists" };
  }
  const live = await fetchOzonWarehouseStocks();
  const payload = {
    ...live,
    date,
    source,
    capturedAt: new Date().toISOString(),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, path);
  return { skipped: false, path, date, totals: payload.totals, warehouses: payload.warehouses.length };
}

export function listOzonStockSnapshotDates() {
  ensureDir();
  return readdirSync(DATA_DIR)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function readSnapshotFile(dateText) {
  const path = snapshotPath(dateText);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Снимок остатков Озон за ${dateText} повреждён: ${String(err.message || err).slice(0, 160)}`);
  }
}

function filterSnapshot(snap, warehouse) {
  const wh = String(warehouse || "").trim();
  let rows = Array.isArray(snap.rows) ? snap.rows : [];
  if (wh) rows = rows.filter((r) => r.warehouse === wh);
  rows = [...rows].sort((a, b) => {
    const byWh = String(a.warehouse || "").localeCompare(String(b.warehouse || ""), "ru");
    if (byWh) return byWh;
    const byOffer = String(a.offerId || "").localeCompare(String(b.offerId || ""), "ru");
    if (byOffer) return byOffer;
    return String(a.name || "").localeCompare(String(b.name || ""), "ru");
  });
  const totals = rows.reduce(
    (acc, row) => {
      acc.free += num(row.free);
      acc.reserved += num(row.reserved);
      acc.promised += num(row.promised);
      acc.total += num(row.total);
      return acc;
    },
    { free: 0, reserved: 0, promised: 0, total: 0, rows: rows.length }
  );
  const byWarehouseMap = new Map();
  for (const row of rows) {
    const key = row.warehouse || "Без склада";
    if (!byWarehouseMap.has(key)) {
      byWarehouseMap.set(key, { warehouse: key, free: 0, reserved: 0, promised: 0, total: 0, rows: 0 });
    }
    const agg = byWarehouseMap.get(key);
    agg.free += num(row.free);
    agg.reserved += num(row.reserved);
    agg.promised += num(row.promised);
    agg.total += num(row.total);
    agg.rows += 1;
  }
  const byWarehouse = [...byWarehouseMap.values()].sort((a, b) => a.warehouse.localeCompare(b.warehouse, "ru"));
  return {
    date: snap.date,
    capturedAt: snap.capturedAt,
    source: snap.source,
    warehouse: wh || null,
    warehouses: snap.warehouses || [],
    availableDates: listOzonStockSnapshotDates(),
    missing: false,
    totals,
    byWarehouse,
    rows,
    note:
      snap.source === "live"
        ? "Оперативный остаток: данные напрямую из Ozon Seller API на момент запроса."
        : "Снимок остатков FBO по складам Ozon (сохраняется раз в сутки в 22:00 МСК, не удаляется).",
  };
}

/** Отчёт по сохранённому снимку на дату. */
export function loadOzonStocksReport(dateText, warehouse = "") {
  const date = String(dateText || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Укажите день в формате YYYY-MM-DD");
  }
  const snap = readSnapshotFile(date);
  if (!snap) {
    return {
      date,
      warehouse: String(warehouse || "").trim() || null,
      warehouses: [],
      availableDates: listOzonStockSnapshotDates(),
      missing: true,
      message: "Нет данных за день",
      totals: { free: 0, reserved: 0, promised: 0, total: 0, rows: 0 },
      byWarehouse: [],
      rows: [],
      note: "Снимки остатков пишутся ежедневно в 22:00 МСК. За выбранный день файла ещё нет.",
    };
  }
  return filterSnapshot(snap, warehouse);
}

/** Оперативный остаток без записи на диск. */
export async function loadOzonStocksLive(warehouse = "") {
  const live = await fetchOzonWarehouseStocks();
  return filterSnapshot(live, warehouse);
}

/**
 * Нужен ли плановый снимок сейчас (22:00–22:04 МСК, файла за сегодня ещё нет)
 * или догон после простоя (после 22:00, файла нет).
 */
export function shouldTakeScheduledSnapshot(now = new Date()) {
  const date = moscowDateKey(now);
  if (existsSync(snapshotPath(date))) return { needed: false, date, reason: "exists" };
  const { hour, minute } = moscowClock(now);
  if (hour > 22 || (hour === 22 && minute >= 0)) {
    return { needed: true, date, reason: hour === 22 && minute <= 4 ? "schedule" : "catchup" };
  }
  return { needed: false, date, reason: "before_22" };
}

export function ozonStocksDataDir() {
  return DATA_DIR;
}
