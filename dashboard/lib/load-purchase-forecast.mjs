import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { odataAllPages } from "./odata.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(root, "data");
const SETTINGS_FILE = join(DATA_DIR, "purchase-forecast.json");
const DATABASE = "ecotidy";
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

/** Стартовый список как на скрине обработки в 1С (ecotidy). */
const DEFAULT_ITEMS = [
  { article: "salf_monik_golub_20sht", dailyRate: 3 },
  { article: "naborgips", dailyRate: 2 },
  { article: "aromo_mist_LifeEmirates", dailyRate: 5 },
  { article: "aromo_mist_Chance", dailyRate: 4 },
  { article: "avtoparf_afgano8", dailyRate: 1 },
  { article: "him_barabanstiral_180", dailyRate: 7 },
  { article: "mentol_banya_50", dailyRate: 6 },
];

function num(v) {
  const n = Number(String(v ?? "").replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

function round4(v) {
  return Math.round((num(v) + Number.EPSILON) * 10000) / 10000;
}

function normalizeArticle(value) {
  return String(value || "").trim();
}

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function defaultPurchaseForecastSettings() {
  return {
    horizon: 10,
    items: DEFAULT_ITEMS.map((row) => ({ ...row })),
    orders: {},
  };
}

export function loadPurchaseForecastSettings() {
  const fallback = defaultPurchaseForecastSettings();
  if (!existsSync(SETTINGS_FILE)) return fallback;
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    const horizon = Math.max(0, num(raw.horizon ?? fallback.horizon));
    const items = Array.isArray(raw.items)
      ? raw.items
          .map((row) => ({
            article: normalizeArticle(row.article || row.Артикул),
            dailyRate: num(row.dailyRate ?? row.СуточныйРасход),
            name: String(row.name || row.Номенклатура || "").trim() || undefined,
          }))
          .filter((row) => row.article)
      : fallback.items;
    const orders = raw.orders && typeof raw.orders === "object" ? raw.orders : {};
    return { horizon, items, orders };
  } catch {
    return fallback;
  }
}

export function savePurchaseForecastSettings(next) {
  ensureDataDir();
  const horizon = Math.max(0, num(next?.horizon ?? 10));
  const items = Array.isArray(next?.items)
    ? next.items
        .map((row) => ({
          article: normalizeArticle(row.article || row.Артикул),
          dailyRate: num(row.dailyRate ?? row.СуточныйРасход),
          name: String(row.name || row.Номенклатура || "").trim() || undefined,
        }))
        .filter((row) => row.article)
    : [];
  const orders = {};
  if (next?.orders && typeof next.orders === "object") {
    for (const [key, value] of Object.entries(next.orders)) {
      const article = normalizeArticle(key);
      if (!article) continue;
      orders[article] = num(value);
    }
  }
  const payload = { horizon, items, orders, updatedAt: new Date().toISOString() };
  writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

async function resolveByArticles(articles) {
  const map = new Map();
  const missing = [];
  const unique = [...new Set(articles.map(normalizeArticle).filter(Boolean))];
  for (const article of unique) {
    const filter = `Артикул eq '${article.replace(/'/g, "''")}' and DeletionMark eq false and IsFolder eq false`;
    const rows = await odataAllPages(
      `Catalog_Номенклатура?$format=json&$filter=${filter}&$select=Ref_Key,Description,Артикул,Code&$top=5`,
      { database: DATABASE, maxPages: 1 }
    );
    if (!rows.length) {
      missing.push(article);
      continue;
    }
    map.set(article, rows[0]);
  }
  return { map, missing };
}

async function resolveByKeys(ids) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && id !== EMPTY_GUID))];
  for (let i = 0; i < list.length; i += 10) {
    const part = list.slice(i, i + 10);
    const filter = part.map((id) => `Ref_Key eq guid'${id}'`).join(" or ");
    const rows = await odataAllPages(
      `Catalog_Номенклатура?$format=json&$filter=${filter}&$select=Ref_Key,Description,Артикул,Code&$top=50`,
      { database: DATABASE, maxPages: 2 }
    );
    for (const row of rows) map.set(row.Ref_Key, row);
  }
  return map;
}

async function loadBalanceMap(register, field) {
  const rows = await odataAllPages(`${register}/Balance()?$format=json&$top=1000`, {
    database: DATABASE,
    maxPages: 100,
  });
  const map = new Map();
  for (const row of rows) {
    const key = row.Номенклатура_Key;
    if (!key || key === EMPTY_GUID) continue;
    map.set(key, (map.get(key) || 0) + num(row[field]));
  }
  return map;
}

async function loadMainKitLines(ownerKeys) {
  /** @type {Map<string, { variantRef: string, variantName: string, lines: Array<{ ref: string, qty: number }> }>} */
  const byOwner = new Map();
  for (const owner of [...new Set(ownerKeys.filter(Boolean))]) {
    const variants = await odataAllPages(
      `Catalog_ВариантыКомплектацииНоменклатуры?$format=json&$filter=Owner_Key eq guid'${owner}' and Основной eq true and DeletionMark eq false&$select=Ref_Key,Description,Owner_Key&$top=5`,
      { database: DATABASE, maxPages: 1 }
    );
    if (!variants.length) continue;
    const variant = variants[0];
    const goods = await odataAllPages(
      `Catalog_ВариантыКомплектацииНоменклатуры_Товары?$format=json&$filter=Ref_Key eq guid'${variant.Ref_Key}'&$select=Номенклатура_Key,Количество&$top=200`,
      { database: DATABASE, maxPages: 2 }
    );
    byOwner.set(owner, {
      variantRef: variant.Ref_Key,
      variantName: variant.Description,
      lines: goods
        .filter((g) => g.Номенклатура_Key && g.Номенклатура_Key !== EMPTY_GUID)
        .map((g) => ({ ref: g.Номенклатура_Key, qty: num(g.Количество) })),
    });
  }
  return byOwner;
}

/**
 * Повторяет логику Alsn_ТекстыЗапросовУТ: Макет + Макет2.
 * @param {{ horizon?: number, items?: Array<{article:string,dailyRate:number}>, orders?: Record<string, number>, persist?: boolean }} [opts]
 */
export async function loadPurchaseForecast(opts = {}) {
  const saved = loadPurchaseForecastSettings();
  const horizon = Math.max(0, num(opts.horizon ?? saved.horizon ?? 10));
  const itemsInput = Array.isArray(opts.items) ? opts.items : saved.items;
  const ordersInput = opts.orders && typeof opts.orders === "object" ? opts.orders : saved.orders || {};

  if (opts.persist) {
    savePurchaseForecastSettings({ horizon, items: itemsInput, orders: ordersInput });
  }

  const normalizedItems = itemsInput
    .map((row) => ({
      article: normalizeArticle(row.article || row.Артикул),
      dailyRate: num(row.dailyRate ?? row.СуточныйРасход),
      nameHint: String(row.name || row.Номенклатура || "").trim(),
    }))
    .filter((row) => row.article);

  const { map: byArticle, missing } = await resolveByArticles(normalizedItems.map((r) => r.article));
  const warnings = [];
  if (missing.length) {
    warnings.push(`Не найдены артикулы: ${missing.join(", ")}`);
  }

  const stockMap = await loadBalanceMap("AccumulationRegister_ТоварыНаСкладах", "ВНаличииBalance");
  const orderMap = await loadBalanceMap("AccumulationRegister_ЗаказыПоставщикам", "ЗаказаноBalance");

  const products = [];
  for (const row of normalizedItems) {
    const nom = byArticle.get(row.article);
    if (!nom) continue;
    const stock = num(stockMap.get(nom.Ref_Key));
    // В макете 1 ЗаказаноОстаток принудительно 0 (СУММА(0)).
    const orderedInMaket1 = 0;
    const required = round2(row.dailyRate * horizon);
    const qtyForCalc = round2(required - stock + orderedInMaket1);
    products.push({
      ref: nom.Ref_Key,
      article: nom.Артикул || row.article,
      name: nom.Description,
      dailyRate: round2(row.dailyRate),
      horizon,
      required,
      stock: round2(stock),
      ordered: orderedInMaket1,
      qtyForCalc,
    });
  }

  const kits = await loadMainKitLines(products.map((p) => p.ref));
  /** @type {Map<string, { need: number, daily: number }>} */
  const componentAgg = new Map();
  for (const product of products) {
    const kit = kits.get(product.ref);
    if (!kit) continue;
    for (const line of kit.lines) {
      const cur = componentAgg.get(line.ref) || { need: 0, daily: 0 };
      cur.need += product.qtyForCalc * line.qty;
      cur.daily = Math.max(cur.daily, product.dailyRate * line.qty);
      componentAgg.set(line.ref, cur);
    }
  }

  const componentRefs = [...componentAgg.keys()];
  const names = await resolveByKeys(componentRefs);
  const components = [];
  for (const ref of componentRefs) {
    const agg = componentAgg.get(ref);
    const nom = names.get(ref);
    const stock = num(stockMap.get(ref));
    const ordered = num(orderMap.get(ref));
    const article = normalizeArticle(nom?.Артикул) || "";
    const orderKey = article || ref;
    const inOrder = num(ordersInput[orderKey] ?? ordersInput[article] ?? ordersInput[ref] ?? 0);
    const need = round4(agg.need);
    const daily = round4(agg.daily);
    const days = daily === 0 ? 0 : Math.round(stock / daily);
    const toOrder = round4(need - ordered - stock - inOrder);
    components.push({
      ref,
      article,
      code: nom?.Code || "",
      name: nom?.Description || ref,
      need,
      stock: round4(stock),
      days,
      ordered: round4(ordered),
      inOrder: round4(inOrder),
      toOrder,
    });
  }

  components.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const withoutKit = products.filter((p) => !kits.has(p.ref)).map((p) => p.name);
  if (withoutKit.length) {
    warnings.push(`Без основного варианта комплектации (не попали во вторую таблицу): ${withoutKit.join(", ")}`);
  }

  return {
    database: DATABASE,
    organization: "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    horizon,
    items: normalizedItems.map((row) => ({
      article: row.article,
      dailyRate: round2(row.dailyRate),
      name: byArticle.get(row.article)?.Description || row.nameHint || "",
      found: byArticle.has(row.article),
    })),
    products,
    components,
    orders: ordersInput,
    warnings,
    meta: {
      productCount: products.length,
      componentCount: components.length,
      stockRows: stockMap.size,
      orderRows: orderMap.size,
      generatedAt: new Date().toISOString(),
    },
    note:
      "База ecotidy. Таблица 1: суточный расход × горизонт − остаток. Таблица 2: разузлование основного варианта комплектации, остатки и заказы поставщикам.",
  };
}

export async function lookupNomenclatureByArticle(article) {
  const key = normalizeArticle(article);
  if (!key) return null;
  const filter = `Артикул eq '${key.replace(/'/g, "''")}' and DeletionMark eq false and IsFolder eq false`;
  const rows = await odataAllPages(
    `Catalog_Номенклатура?$format=json&$filter=${filter}&$select=Ref_Key,Description,Артикул,Code&$top=3`,
    { database: DATABASE, maxPages: 1 }
  );
  return rows[0] || null;
}
