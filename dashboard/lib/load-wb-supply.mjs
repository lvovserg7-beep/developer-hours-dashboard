/**
 * Доска «Расчёт поставки ВБ»: снимок данных WB на диске, фоновое обновление,
 * справочник номенклатуры 1С (ecotidy), настройки пользователя и расчёт.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { odataAllPages } from "./odata.mjs";
import { wbSellerConfigured } from "./wb-seller.mjs";
import {
  compactOrder,
  fetchWbActiveSupplies,
  fetchWbCardTitles,
  fetchWbOrders,
  fetchWbWarehouseRemains,
} from "./wb-supply-api.mjs";
import {
  DEFAULT_WB_SUPPLY_PARAMS,
  WB_SUPPLY_LIMITS,
  addDays,
  calcWbSupply,
  moscowToday,
  normalizeWbSupplyParams,
} from "./wb-supply-calc.mjs";
import { CLUSTERS } from "./wb-supply-config.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(root, "data", "wb-supply");
const USERS_DIR = join(DIR, "users");
const SNAPSHOT_FILE = join(DIR, "snapshot.json");

/** Храним заказы с запасом к максимальной глубине просмотра. */
const ORDERS_KEEP_DAYS = WB_SUPPLY_LIMITS.depthMax + 10;
/** Данные считаются свежими столько минут. */
const FRESH_MIN = 30;

function ensureDirs() {
  mkdirSync(USERS_DIR, { recursive: true });
}

function writeJsonAtomic(file, value) {
  ensureDirs();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- снимок

let snapshotCache = null;

function emptySnapshot() {
  return {
    version: 1,
    orders: {},
    ordersSyncAt: null,
    ordersFrom: null,
    remains: {},
    remainsAt: null,
    supplies: [],
    suppliesAt: null,
    titles: {},
    titlesAt: null,
    catalog: { byArticle: {}, categories: [], at: null },
  };
}

export function loadWbSupplySnapshot() {
  if (snapshotCache) return snapshotCache;
  try {
    if (existsSync(SNAPSHOT_FILE)) {
      const raw = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf8"));
      snapshotCache = { ...emptySnapshot(), ...raw };
      return snapshotCache;
    }
  } catch (e) {
    console.warn("wb-supply snapshot read:", e.message || e);
  }
  snapshotCache = emptySnapshot();
  return snapshotCache;
}

function saveSnapshot(snap) {
  snapshotCache = snap;
  writeJsonAtomic(SNAPSHOT_FILE, snap);
}

// ---------------------------------------------------------------- настройки пользователя

function userFile(userId) {
  const safe = String(userId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(USERS_DIR, `${safe}.json`);
}

export function loadWbSupplySettings(userId) {
  try {
    const file = userFile(userId);
    if (existsSync(file)) return normalizeWbSupplyParams(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    console.warn("wb-supply settings read:", e.message || e);
  }
  return normalizeWbSupplyParams(DEFAULT_WB_SUPPLY_PARAMS);
}

export function saveWbSupplySettings(userId, params) {
  ensureDirs();
  const clean = normalizeWbSupplyParams(params);
  writeFileSync(userFile(userId), JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

// ---------------------------------------------------------------- справочник 1С

function odataStr(value) {
  return String(value).replace(/'/g, "''");
}

async function loadCatalog1c(articles, onStep) {
  const byArticle = {};
  const list = [...new Set(articles)].filter(Boolean);
  const batch = 12;
  for (let i = 0; i < list.length; i += batch) {
    const part = list.slice(i, i + batch);
    const cond = part.map((a) => `Артикул eq '${odataStr(a)}'`).join(" or ");
    onStep?.(`справочник 1С: ${Math.min(i + batch, list.length)} из ${list.length}`);
    const rows = await odataAllPages(
      `Catalog_Номенклатура?$format=json&$filter=(${cond}) and DeletionMark eq false and IsFolder eq false&$select=Ref_Key,Description,Артикул,ТоварнаяКатегория_Key`,
      { database: "ecotidy", maxPages: 3 },
    );
    for (const r of rows) {
      const a = String(r["Артикул"] || "").trim();
      if (!a || byArticle[a]) continue;
      const cat = String(r["ТоварнаяКатегория_Key"] || "");
      byArticle[a] = {
        name: String(r.Description || "").trim(),
        categoryKey: cat && !/^0{8}-/.test(cat) ? cat : "",
      };
    }
  }

  const catRows = await odataAllPages(
    `Catalog_ТоварныеКатегории?$format=json&$filter=DeletionMark eq false&$select=Ref_Key,Description,Parent_Key,IsFolder`,
    { database: "ecotidy", maxPages: 20 },
  );
  const all = new Map(
    catRows.map((c) => [
      c.Ref_Key,
      {
        key: c.Ref_Key,
        name: String(c.Description || "").trim(),
        parentKey: c.Parent_Key && !/^0{8}-/.test(c.Parent_Key) ? c.Parent_Key : "",
        isFolder: !!c.IsFolder,
      },
    ]),
  );
  // Все товарные категории 1С (дерево), а не только занятые артикулами WB.
  const categories = [...all.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return { byArticle, categories, full: true, at: new Date().toISOString() };
}

let catalogOnlyRunning = false;

/** Обновить только справочник 1С (категории и артикулы), без запросов к WB. */
export async function refreshWbSupplyCatalogOnly() {
  if (catalogOnlyRunning || refreshState.running) return false;
  catalogOnlyRunning = true;
  try {
    const snap = loadWbSupplySnapshot();
    const articles = new Set();
    for (const o of Object.values(snap.orders || {})) if (o.a) articles.add(o.a);
    for (const a of Object.keys(snap.remains || {})) articles.add(a);
    const catalog = await loadCatalog1c([...articles]);
    saveSnapshot({ ...loadWbSupplySnapshot(), catalog });
    return true;
  } finally {
    catalogOnlyRunning = false;
  }
}

// ---------------------------------------------------------------- обновление данных

const refreshState = {
  running: false,
  step: "",
  startedAt: null,
  finishedAt: null,
  error: "",
  warnings: [],
};

export function getWbSupplyRefreshState() {
  return { ...refreshState, warnings: [...refreshState.warnings] };
}

export function wbSupplyDataAge(snap = loadWbSupplySnapshot()) {
  const ts = snap.ordersSyncAt ? Date.parse(snap.ordersSyncAt) : 0;
  return ts ? (Date.now() - ts) / 60000 : Infinity;
}

export function wbSupplyIsStale(snap = loadWbSupplySnapshot()) {
  if (snap.ordersBlockedUntil && snap.ordersBlockedUntil > Date.now() && snap.ordersSyncAt) {
    // Заказы до конца лимита всё равно не получить; остальное обновляем раз в FRESH_MIN.
    const rest = [snap.remainsAt, snap.suppliesAt].filter(Boolean).map((x) => Date.parse(x));
    const last = rest.length ? Math.min(...rest) : 0;
    return !last || (Date.now() - last) / 60000 > FRESH_MIN;
  }
  return wbSupplyDataAge(snap) > FRESH_MIN;
}

/**
 * Фоновое обновление. Возвращает сразу; ход — через getWbSupplyRefreshState().
 * @param {{ full?: boolean }} [opts]  full — пересобрать заказы за всю глубину
 */
export function startWbSupplyRefresh(opts = {}) {
  if (refreshState.running) return false;
  if (!wbSellerConfigured()) {
    refreshState.error = "Wildberries API не настроен. Укажите WB_API_TOKEN в dashboard/.env";
    return false;
  }
  refreshState.running = true;
  refreshState.step = "старт";
  refreshState.startedAt = new Date().toISOString();
  refreshState.finishedAt = null;
  refreshState.error = "";
  refreshState.warnings = [];
  runRefresh(opts)
    .catch((e) => {
      refreshState.error = String(e?.message || e);
    })
    .finally(() => {
      refreshState.running = false;
      refreshState.step = "";
      refreshState.finishedAt = new Date().toISOString();
    });
  return true;
}

async function runRefresh(opts) {
  const snap = JSON.parse(JSON.stringify(loadWbSupplySnapshot()));
  const today = moscowToday();
  const keepFrom = addDays(today, -ORDERS_KEEP_DAYS);
  const step = (text) => {
    refreshState.step = text;
  };
  const warn = (text) => {
    refreshState.warnings.push(text);
    console.warn("wb-supply:", text);
  };

  // 1. Заказы (критично). Инкремент по lastChangeDate с запасом 3 дня.
  const hadOrders = Boolean(snap.ordersSyncAt);
  if (snap.ordersBlockedUntil && snap.ordersBlockedUntil > Date.now()) {
    const until = new Date(snap.ordersBlockedUntil).toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" });
    if (!hadOrders) throw new Error(`WB ограничил запросы заказов до ${until} МСК.`);
    warn(`Заказы WB не обновлены: лимит API до ${until} МСК, расчёт идёт по данным от ${snap.ordersSyncAt.slice(0, 16).replace("T", " ")}.`);
  } else {
    try {
      step("заказы WB");
      const first = opts.full || !hadOrders;
      const dateFrom = first ? keepFrom : addDays(String(snap.ordersSyncAt).slice(0, 10), -3);
      const fetchedAt = new Date().toISOString();
      const rows = await fetchWbOrders(dateFrom, { onWait: (s) => step(`заказы WB: лимит, ждём ${s} с`) });
      if (first) snap.orders = {};
      for (const row of rows) {
        const srid = String(row.srid || "").trim();
        if (!srid) continue;
        snap.orders[srid] = compactOrder(row);
      }
      for (const [srid, o] of Object.entries(snap.orders)) {
        if (!o.d || o.d < keepFrom) delete snap.orders[srid];
      }
      snap.ordersSyncAt = fetchedAt;
      snap.ordersFrom = dateFrom;
      snap.ordersBlockedUntil = 0;
      saveSnapshot(snap);
    } catch (e) {
      if (e.rateLimitedUntil) snap.ordersBlockedUntil = e.rateLimitedUntil;
      saveSnapshot(snap);
      if (!hadOrders) throw e;
      warn(`Заказы WB не обновлены: ${e.message || e}`);
    }
  }

  // 2. Остатки по складам.
  try {
    step("остатки WB");
    snap.remains = await fetchWbWarehouseRemains({ onStep: (t) => step(t) });
    snap.remainsAt = new Date().toISOString();
    saveSnapshot(snap);
  } catch (e) {
    warn(`Остатки WB не обновлены: ${e.message || e}`);
  }

  // 3. Поставки в пути.
  try {
    step("поставки WB");
    snap.supplies = await fetchWbActiveSupplies({ today, onStep: (t) => step(t) });
    snap.suppliesAt = new Date().toISOString();
    saveSnapshot(snap);
  } catch (e) {
    warn(`Поставки WB не обновлены: ${e.message || e}`);
  }

  // 4. Названия карточек.
  try {
    step("карточки WB");
    snap.titles = await fetchWbCardTitles({ onStep: (t) => step(t) });
    snap.titlesAt = new Date().toISOString();
    saveSnapshot(snap);
  } catch (e) {
    warn(`Названия карточек не обновлены: ${e.message || e}`);
  }

  // 5. Справочник 1С: категории по артикулу.
  try {
    step("справочник 1С");
    const articles = new Set();
    for (const o of Object.values(snap.orders)) if (o.a) articles.add(o.a);
    for (const a of Object.keys(snap.remains || {})) articles.add(a);
    snap.catalog = await loadCatalog1c([...articles], (t) => step(t));
    saveSnapshot(snap);
  } catch (e) {
    warn(`Справочник 1С не обновлён: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------- отчёт

export function getWbSupplyMeta() {
  const snap = loadWbSupplySnapshot();
  return {
    configured: wbSellerConfigured(),
    hasData: Boolean(snap.ordersSyncAt),
    ordersAt: snap.ordersSyncAt,
    ordersBlockedUntil: snap.ordersBlockedUntil && snap.ordersBlockedUntil > Date.now() ? snap.ordersBlockedUntil : 0,
    remainsAt: snap.remainsAt,
    suppliesAt: snap.suppliesAt,
    titlesAt: snap.titlesAt,
    catalogAt: snap.catalog?.at || null,
    catalogFull: Boolean(snap.catalog?.full),
    ordersCount: Object.keys(snap.orders || {}).length,
    stale: wbSupplyIsStale(snap),
    state: getWbSupplyRefreshState(),
  };
}

/** Артикулы, по которым в снимке есть заказы или остатки WB. */
export function getWbSupplyKnownArticles() {
  const snap = loadWbSupplySnapshot();
  const set = new Set(Object.keys(snap.remains || {}));
  for (const o of Object.values(snap.orders || {})) if (o.a) set.add(o.a);
  return set;
}

/** Категории и номенклатура для выбора в фильтрах (весь список из данных WB/1С). */
export function getWbSupplyOptions() {
  const snap = loadWbSupplySnapshot();
  const titles = snap.titles || {};
  const by = snap.catalog?.byArticle || {};
  const articles = new Set();
  const since = addDays(moscowToday(), -(WB_SUPPLY_LIMITS.depthMax + 1));
  for (const o of Object.values(snap.orders || {})) {
    if (o.a && !o.x && o.d >= since) articles.add(o.a);
  }
  const skus = [...articles]
    .map((a) => ({
      article: a,
      name: titles[a] || by[a]?.name || a,
      categoryKey: by[a]?.categoryKey || "",
    }))
    .sort((x, y) => x.article.localeCompare(y.article, "ru"));
  const count = new Map();
  const parent = new Map((snap.catalog?.categories || []).map((c) => [c.key, c.parentKey]));
  for (const s of skus) {
    let key = s.categoryKey;
    const seen = new Set();
    while (key && !seen.has(key)) {
      seen.add(key);
      count.set(key, (count.get(key) || 0) + 1);
      key = parent.get(key) || "";
    }
  }
  const categories = (snap.catalog?.categories || []).map((c) => ({ ...c, count: count.get(c.key) || 0 }));
  return { categories, skus, clusters: CLUSTERS };
}

/**
 * @param {object} params   настройки (будут нормализованы)
 * @param {{ today?: string }} [opts]
 */
export function buildWbSupplyReport(params, opts = {}) {
  const snap = loadWbSupplySnapshot();
  const report = calcWbSupply(snap, params, opts);
  const meta = getWbSupplyMeta();
  if (meta.hasData) {
    if (!snap.remainsAt) report.warnings.unshift("Остатки WB ещё не загружены — остаток принят нулевым.");
    if (!snap.titlesAt) report.warnings.push("Названия карточек не загружены — показан артикул.");
    if (!snap.catalog?.at) report.warnings.push("Справочник 1С не загружен — категории недоступны.");
  }
  return { ...report, meta };
}
