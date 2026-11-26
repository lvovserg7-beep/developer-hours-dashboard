/**
 * Расчёт поставки на склады Wildberries (ТЗ «Расчёт поставки ВБ»).
 * Чистая функция: на вход снимок данных WB и параметры, на выход отчёт. Без сети и диска.
 *
 * Формулы (по товару × кластер):
 *   спрос I      = заказы за глубину / глубина (шт./день), если I < minDemand → 0
 *   потребность K = I × горизонт × (1 + запас%)   (срок доставки в кластер не учитывается)
 *   остаток O    = остаток на складах кластера + (в пути, если включено) + (доля возвратов, если включено)
 *   дефицит      = max(0, K − O)
 *   к поставке   = дефицит, округлённый вверх до кратности; если 0 < результат < минимальной партии → минимальная партия
 */

import {
  CLUSTERS,
  CLUSTER_CENTER,
  clusterByOkrug,
  clusterByWarehouse,
  isRemainsServiceRow,
} from "./wb-supply-config.mjs";

export const WB_SUPPLY_LIMITS = {
  depthMax: 90,
  horizonMax: 365,
  reserveMax: 300,
};

export const DEFAULT_WB_SUPPLY_PARAMS = {
  depth: 30,
  horizon: 30,
  reservePct: 20,
  query: "",
  categories: [],
  articles: [],
  minDemand: 0.1,
  useInTransit: true,
  useReturns: false,
  fullStockThreshold: 3,
  skuRules: {},
};

function num(value, fallback, min, max) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeWbSupplyParams(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const d = DEFAULT_WB_SUPPLY_PARAMS;
  const skuRules = {};
  if (src.skuRules && typeof src.skuRules === "object") {
    for (const [article, rule] of Object.entries(src.skuRules)) {
      const key = String(article || "").trim();
      if (!key || !rule || typeof rule !== "object") continue;
      skuRules[key] = {
        include: rule.include === false ? false : true,
        multiple: Math.max(1, Math.round(num(rule.multiple, 1, 1, 100000))),
        minBatch: Math.max(0, Math.round(num(rule.minBatch, 0, 0, 1000000))),
      };
    }
  }
  const list = (v) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x || "").trim()).filter(Boolean))];
  return {
    depth: Math.round(num(src.depth, d.depth, 1, WB_SUPPLY_LIMITS.depthMax)),
    horizon: Math.round(num(src.horizon, d.horizon, 0, WB_SUPPLY_LIMITS.horizonMax)),
    reservePct: num(src.reservePct, d.reservePct, 0, WB_SUPPLY_LIMITS.reserveMax),
    query: String(src.query || "").trim().slice(0, 200),
    categories: list(src.categories),
    articles: list(src.articles),
    minDemand: num(src.minDemand, d.minDemand, 0, 1000),
    useInTransit: src.useInTransit === false ? false : true,
    useReturns: src.useReturns === true,
    fullStockThreshold: num(src.fullStockThreshold, d.fullStockThreshold, 0, 1000),
    skuRules,
  };
}

export function moscowToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(now);
}

export function addDays(iso, n) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function ceilTo(value, multiple) {
  const m = Math.max(1, multiple || 1);
  return Math.ceil(value / m - 1e-9) * m;
}

/** Потомки выбранных категорий (папки раскрываются вниз). */
function expandCategories(selected, categories) {
  const out = new Set(selected);
  if (!out.size) return out;
  const children = new Map();
  for (const c of categories || []) {
    if (!c.parentKey) continue;
    if (!children.has(c.parentKey)) children.set(c.parentKey, []);
    children.get(c.parentKey).push(c.key);
  }
  const stack = [...out];
  while (stack.length) {
    const key = stack.pop();
    for (const child of children.get(key) || []) {
      if (!out.has(child)) {
        out.add(child);
        stack.push(child);
      }
    }
  }
  return out;
}

/**
 * @param {object} data   снимок: { orders, remains, supplies, titles, catalog }
 * @param {object} rawParams
 * @param {{ today?: string }} [opts]
 */
export function calcWbSupply(data, rawParams, opts = {}) {
  const params = normalizeWbSupplyParams(rawParams);
  const today = opts.today || moscowToday();
  const last = addDays(today, -1);
  const from = addDays(last, -(params.depth - 1));
  const candidateFrom = addDays(last, -(Math.max(30, params.depth) - 1));
  const warnings = [];

  const titles = data?.titles || {};
  const catByArticle = data?.catalog?.byArticle || {};
  const categories = data?.catalog?.categories || [];
  const catName = new Map(categories.map((c) => [c.key, c.name]));

  // --- заказы ---
  const unknownOkrug = new Map();
  const stats = new Map(); // article -> { nmId, clusters: {name:{fbw,fbs}}, days: Map, total, recent }
  for (const o of Object.values(data?.orders || {})) {
    if (!o || o.x) continue;
    if (o.d < candidateFrom || o.d > last) continue;
    const article = String(o.a || "").trim();
    if (!article) continue;
    let st = stats.get(article);
    if (!st) {
      st = { nmId: o.n || null, clusters: {}, days: new Map(), total: 0 };
      stats.set(article, st);
    }
    if (o.d < from) continue;
    const { cluster, known } = clusterByOkrug(o.o);
    if (!known) unknownOkrug.set(o.o, (unknownOkrug.get(o.o) || 0) + 1);
    const cell = (st.clusters[cluster] ||= { fbw: 0, fbs: 0 });
    if (o.w === "S") cell.fbs += 1;
    else cell.fbw += 1;
    st.total += 1;
    st.days.set(o.d, (st.days.get(o.d) || 0) + 1);
  }
  for (const [okrug, n] of unknownOkrug) {
    warnings.push(`Неизвестный округ «${okrug}» (${n} зак.) отнесён к кластеру «${CLUSTER_CENTER}».`);
  }

  // --- остатки по кластерам ---
  const unmappedWh = new Map();
  const remainsByArticle = new Map();
  for (const [article, r] of Object.entries(data?.remains || {})) {
    const byCluster = {};
    let totalMapped = 0;
    for (const [wh, qty] of Object.entries(r.wh || {})) {
      if (isRemainsServiceRow(wh)) continue;
      const q = Number(qty) || 0;
      if (!q) continue;
      const { cluster, kind } = clusterByWarehouse(wh);
      if (cluster) {
        byCluster[cluster] = (byCluster[cluster] || 0) + q;
        totalMapped += q;
      } else if (kind === "unknown") {
        unmappedWh.set(wh, (unmappedWh.get(wh) || 0) + q);
      }
    }
    remainsByArticle.set(article, {
      byCluster,
      totalMapped,
      returns: Number(r.returns) || 0,
      toCustomers: Number(r.toCustomers) || 0,
    });
  }
  for (const [wh, q] of unmappedWh) {
    warnings.push(`Склад WB «${wh}» не привязан к кластеру (остаток ${q} шт. не учтён).`);
  }

  // --- поставки в пути ---
  const supplyByArticle = new Map(); // article -> cluster -> qty
  const unmappedSupplyWh = new Set();
  for (const s of data?.supplies || []) {
    const { cluster, kind } = clusterByWarehouse(s.warehouse);
    if (!cluster) {
      if (kind === "unknown" && s.warehouse) unmappedSupplyWh.add(s.warehouse);
      continue;
    }
    for (const it of s.items || []) {
      const article = String(it.a || "").trim();
      if (!article) continue;
      const q = Math.max(0, Number(s.status === 4 ? (it.q || 0) - (it.acc || 0) : it.q) || 0);
      if (!q) continue;
      const row = supplyByArticle.get(article) || {};
      row[cluster] = (row[cluster] || 0) + q;
      supplyByArticle.set(article, row);
    }
  }
  for (const wh of unmappedSupplyWh) {
    warnings.push(`Склад поставки «${wh}» не привязан к кластеру — товар в пути по нему не учтён.`);
  }

  // --- отбор номенклатуры ---
  const catSet = expandCategories(params.categories, categories);
  const artSet = new Set(params.articles);
  const queryWords = params.query.toLowerCase().split(/\s+/).filter(Boolean);
  const restrict = catSet.size > 0 || artSet.size > 0;

  const allArticles = new Set([...stats.keys(), ...artSet]);
  const skuList = [];
  for (const article of allArticles) {
    const cat = catByArticle[article];
    const name = titles[article] || cat?.name || article;
    const categoryKey = cat?.categoryKey || "";
    if (restrict && !(artSet.has(article) || (categoryKey && catSet.has(categoryKey)))) continue;
    if (queryWords.length) {
      const hay = `${article} ${name}`.toLowerCase();
      if (!queryWords.every((w) => hay.includes(w))) continue;
    }
    skuList.push({ article, name, categoryKey });
  }

  const reserveK = 1 + params.reservePct / 100;
  const skus = [];
  const clusterSummary = new Map(
    CLUSTERS.map((c) => [
      c.name,
      { name: c.name, demand: 0, stock: 0, inTransit: 0, toSupply: 0, skuToSupply: 0 },
    ]),
  );

  for (const sku of skuList) {
    const st = stats.get(sku.article) || { nmId: null, clusters: {}, days: new Map(), total: 0 };
    const rem = remainsByArticle.get(sku.article) || { byCluster: {}, totalMapped: 0, returns: 0, toCustomers: 0 };
    const supply = supplyByArticle.get(sku.article) || {};
    const rule = params.skuRules[sku.article] || { include: true, multiple: 1, minBatch: 0 };

    const avgDemand = st.total / params.depth;
    const dayDivisor =
      avgDemand >= params.fullStockThreshold ? Math.max(1, st.days.size) : params.depth;
    const rows = [];
    let sumToSupply = 0;
    let sumDemand = 0;
    let sumStock = 0;
    let sumInTransit = 0;

    for (const c of CLUSTERS) {
      const cell = st.clusters[c.name] || { fbw: 0, fbs: 0 };
      const orders = cell.fbw + cell.fbs;
      let demand = orders / dayDivisor;
      if (demand < params.minDemand) demand = 0;
      const need = demand * params.horizon * reserveK;
      const stock = rem.byCluster[c.name] || 0;
      const inTransit = params.useInTransit ? supply[c.name] || 0 : 0;
      const returnsShare =
        params.useReturns && st.total > 0 ? (rem.returns * orders) / st.total : 0;
      const available = stock + inTransit + returnsShare;
      const deficit = Math.max(0, need - available);
      let toSupply = 0;
      if (rule.include && deficit > 0) {
        toSupply = ceilTo(deficit, rule.multiple);
        if (rule.minBatch > 0 && toSupply < rule.minBatch) toSupply = ceilTo(rule.minBatch, rule.multiple);
      }
      const coverage = demand > 0 ? available / demand : null;
      const zeroDate =
        demand > 0 ? addDays(today, Math.floor(Math.min(coverage, 3650))) : null;
      rows.push({
        cluster: c.name,
        fbw: cell.fbw,
        fbs: cell.fbs,
        orders,
        demand,
        need,
        stock,
        inTransit,
        returnsShare,
        coverage,
        zeroDate,
        deficit,
        toSupply,
      });
      sumToSupply += toSupply;
      sumDemand += demand;
      sumStock += stock;
      sumInTransit += inTransit;

      const cs = clusterSummary.get(c.name);
      cs.demand += demand;
      cs.stock += stock;
      cs.inTransit += inTransit;
      cs.toSupply += toSupply;
      if (toSupply > 0) cs.skuToSupply += 1;
    }

    skus.push({
      article: sku.article,
      name: sku.name,
      nmId: st.nmId || data?.remains?.[sku.article]?.nm || null,
      categoryKey: sku.categoryKey,
      category: catName.get(sku.categoryKey) || "",
      include: rule.include,
      multiple: rule.multiple,
      minBatch: rule.minBatch,
      orders: st.total,
      daysWithOrders: st.days.size,
      demand: sumDemand,
      stock: sumStock,
      stockTotal: rem.totalMapped,
      inTransit: sumInTransit,
      returns: rem.returns,
      toCustomers: rem.toCustomers,
      toSupply: sumToSupply,
      rows,
    });
  }

  skus.sort(
    (a, b) =>
      b.toSupply - a.toSupply || b.demand - a.demand || a.article.localeCompare(b.article, "ru"),
  );

  const clusters = [...clusterSummary.values()];
  const totals = {
    skuCount: skus.length,
    skuToSupply: skus.filter((s) => s.toSupply > 0).length,
    toSupply: skus.reduce((s, x) => s + x.toSupply, 0),
    demand: skus.reduce((s, x) => s + x.demand, 0),
    stock: skus.reduce((s, x) => s + x.stock, 0),
    inTransit: skus.reduce((s, x) => s + x.inTransit, 0),
  };

  return {
    today,
    period: { from, to: last, depth: params.depth },
    horizon: params.horizon,
    reservePct: params.reservePct,
    params,
    clusters,
    skus,
    totals,
    warnings,
  };
}
