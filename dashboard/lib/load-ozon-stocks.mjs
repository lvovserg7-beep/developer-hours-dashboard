import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ozonSellerConfigured, ozonSellerPost } from "./ozon-seller.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(root, "data", "ozon-stocks");
const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;
const CLUSTER_TTL_MS = 12 * 60 * 60 * 1000;
const NO_CLUSTER = "Без кластера";

let clusterCache = { at: 0, byWarehouse: new Map() };

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

/** Склад → название кластера Ozon. Справочник общий, кэшируется на 12 часов. */
export async function ozonWarehouseClusters() {
  if (clusterCache.byWarehouse.size && Date.now() - clusterCache.at < CLUSTER_TTL_MS) {
    return clusterCache.byWarehouse;
  }
  if (!ozonSellerConfigured()) return clusterCache.byWarehouse;
  const data = await ozonSellerPost("/v1/cluster/list", { cluster_type: "CLUSTER_TYPE_OZON" });
  const map = new Map();
  for (const cluster of data.clusters || []) {
    const name = String(cluster.name || "").trim();
    if (!name) continue;
    for (const logistic of cluster.logistic_clusters || []) {
      for (const warehouse of logistic.warehouses || []) {
        const warehouseName = String(warehouse.name || "").trim();
        if (warehouseName && !map.has(warehouseName)) map.set(warehouseName, name);
      }
    }
  }
  clusterCache = { at: Date.now(), byWarehouse: map };
  return map;
}

function clusterOf(clusterMap, warehouse) {
  return clusterMap.get(String(warehouse || "").trim()) || NO_CLUSTER;
}

function sumQty(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.free += num(row.free);
      acc.reserved += num(row.reserved);
      acc.promised += num(row.promised);
      acc.total += num(row.total);
      return acc;
    },
    { free: 0, reserved: 0, promised: 0, total: 0, rows: rows.length }
  );
}

function filterSnapshot(snap, warehouse, cluster, clusterMap) {
  const wh = String(warehouse || "").trim();
  const clusterName = String(cluster || "").trim();
  const sourceRows = Array.isArray(snap.rows) ? snap.rows : [];
  const tagged = sourceRows.map((row) => ({
    ...row,
    cluster: clusterOf(clusterMap, row.warehouse),
  }));
  const warehouseMeta = [...new Set(tagged.map((r) => r.warehouse).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ru"))
    .map((name) => ({ name, cluster: clusterOf(clusterMap, name) }));
  const clusters = [...new Set(warehouseMeta.map((w) => w.cluster))].sort((a, b) => a.localeCompare(b, "ru"));
  let rows = tagged;
  if (clusterName) rows = rows.filter((r) => r.cluster === clusterName);
  if (wh) rows = rows.filter((r) => r.warehouse === wh);
  rows = [...rows].sort((a, b) => {
    const byWh = String(a.warehouse || "").localeCompare(String(b.warehouse || ""), "ru");
    if (byWh) return byWh;
    const byOffer = String(a.offerId || "").localeCompare(String(b.offerId || ""), "ru");
    if (byOffer) return byOffer;
    return String(a.name || "").localeCompare(String(b.name || ""), "ru");
  });
  const totals = sumQty(rows);
  const byWarehouseMap = new Map();
  const byClusterMap = new Map();
  for (const row of rows) {
    const warehouseKey = row.warehouse || "Без склада";
    if (!byWarehouseMap.has(warehouseKey)) {
      byWarehouseMap.set(warehouseKey, {
        warehouse: warehouseKey,
        cluster: row.cluster,
        free: 0,
        reserved: 0,
        promised: 0,
        total: 0,
        rows: 0,
      });
    }
    const warehouseAgg = byWarehouseMap.get(warehouseKey);
    warehouseAgg.free += num(row.free);
    warehouseAgg.reserved += num(row.reserved);
    warehouseAgg.promised += num(row.promised);
    warehouseAgg.total += num(row.total);
    warehouseAgg.rows += 1;

    const clusterKey = row.cluster || NO_CLUSTER;
    if (!byClusterMap.has(clusterKey)) {
      byClusterMap.set(clusterKey, { cluster: clusterKey, free: 0, reserved: 0, promised: 0, total: 0, rows: 0, warehouses: 0 });
    }
    const clusterAgg = byClusterMap.get(clusterKey);
    clusterAgg.free += num(row.free);
    clusterAgg.reserved += num(row.reserved);
    clusterAgg.promised += num(row.promised);
    clusterAgg.total += num(row.total);
    clusterAgg.rows += 1;
  }
  for (const agg of byClusterMap.values()) {
    agg.warehouses = [...byWarehouseMap.values()].filter((w) => w.cluster === agg.cluster).length;
  }
  const byWarehouse = [...byWarehouseMap.values()].sort((a, b) => a.warehouse.localeCompare(b.warehouse, "ru"));
  const byCluster = [...byClusterMap.values()].sort((a, b) => a.cluster.localeCompare(b.cluster, "ru"));
  return {
    date: snap.date,
    capturedAt: snap.capturedAt,
    source: snap.source,
    warehouse: wh || null,
    cluster: clusterName || null,
    warehouses: warehouseMeta,
    clusters,
    availableDates: listOzonStockSnapshotDates(),
    missing: false,
    totals,
    byCluster,
    byWarehouse,
    rows,
    note:
      snap.source === "live"
        ? "Оперативный остаток: данные напрямую из Ozon Seller API на момент запроса."
        : "Снимок остатков FBO по складам Ozon (сохраняется раз в сутки в 22:00 МСК, не удаляется).",
  };
}

/** Отчёт по сохранённому снимку на дату. */
export async function loadOzonStocksReport(dateText, warehouse = "", cluster = "") {
  const date = String(dateText || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Укажите день в формате YYYY-MM-DD");
  }
  const snap = readSnapshotFile(date);
  if (!snap) {
    return {
      date,
      warehouse: String(warehouse || "").trim() || null,
      cluster: String(cluster || "").trim() || null,
      warehouses: [],
      clusters: [],
      availableDates: listOzonStockSnapshotDates(),
      missing: true,
      message: "Нет данных за день",
      totals: { free: 0, reserved: 0, promised: 0, total: 0, rows: 0 },
      byCluster: [],
      byWarehouse: [],
      rows: [],
      note: "Снимки остатков пишутся ежедневно в 22:00 МСК. За выбранный день файла ещё нет.",
    };
  }
  let clusterMap = new Map();
  try {
    clusterMap = await ozonWarehouseClusters();
  } catch (err) {
    console.warn("Ozon clusters:", err.message || err);
  }
  return filterSnapshot(snap, warehouse, cluster, clusterMap);
}

/** Оперативный остаток без записи на диск. */
export async function loadOzonStocksLive(warehouse = "", cluster = "") {
  const live = await fetchOzonWarehouseStocks();
  let clusterMap = new Map();
  try {
    clusterMap = await ozonWarehouseClusters();
  } catch (err) {
    console.warn("Ozon clusters:", err.message || err);
  }
  return filterSnapshot(live, warehouse, cluster, clusterMap);
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
