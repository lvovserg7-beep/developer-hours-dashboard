import { odataGet } from "./odata.mjs";

const DB = "ecotidy";
const PAGE = 400;
const EMPTY = "00000000-0000-0000-0000-000000000000";

const AD_SEARCH = "ПродвижениеВПоиске";
const AD_STENCIL = "Трафареты";
const AD_ORDER = "НачисленияПоЗаказуВсеТовары";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function defaultOzonDrrRange() {
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = ymd(yesterday);
  return { from: day, to: day };
}

function resolveRange(fromRaw, toRaw) {
  const from = parseYmd(fromRaw) || parseYmd(defaultOzonDrrRange().from);
  const to = parseYmd(toRaw) || parseYmd(defaultOzonDrrRange().to);
  if (from > to) throw new Error("Дата «с» не может быть позже «по»");
  return {
    from: ymd(from),
    to: ymd(to),
    fromIso: `${ymd(from)}T00:00:00`,
    toIso: `${ymd(to)}T23:59:59`,
  };
}

async function fetchAll(path) {
  const rows = [];
  for (let page = 0; page < 600; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await odataGet(`${path}${sep}$top=${PAGE}&$skip=${page * PAGE}`, DB);
    const chunk = data.value || [];
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return rows;
}

async function mapPool(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current], current);
    }
  });
  await Promise.all(runners);
}

async function fetchByKeys(entity, keys, select) {
  const map = new Map();
  const list = [...new Set(keys.filter((k) => k && k !== EMPTY))];
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await fetchAll(`${entity}?$format=json&$filter=${filter}&$select=${select}`);
    for (const row of rows) map.set(row.Ref_Key, row);
  }
  return map;
}

function enumTail(value) {
  const text = String(value || "");
  if (!text) return "";
  const parts = text.split(".");
  return parts[parts.length - 1] || text;
}

function emptyMetrics() {
  return { sum: 0, qty: 0, search: 0, stencil: 0, order: 0 };
}

function addMetrics(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    target[k] = (target[k] || 0) + num(v);
  }
}

function finishMetrics(m) {
  const sum = round2(m.sum);
  const search = round2(m.search);
  const stencil = round2(m.stencil);
  const order = round2(m.order);
  const ads = search + stencil + order;
  const drr = sum ? round2((ads / sum) * 100) : 0;
  return {
    sum,
    qty: round2(m.qty),
    search,
    stencil,
    order,
    drr,
  };
}

/**
 * Расчёт доли рекламных расходов (ДРР) по Озону — база ecotidy.
 * Источник: отчёт «ДИР озон» / Расчет доли рекламных расходов.
 */
export async function loadOzonDrr(fromRaw, toRaw) {
  const range = resolveRange(fromRaw, toRaw);
  const warnings = [];

  const [docs, ads] = await Promise.all([
    fetchAll(
      `Document_Alsn_Продажи?$format=json&$filter=Date ge datetime'${range.fromIso}' and Date le datetime'${range.toIso}' and Posted eq true&$select=Ref_Key,Date&$orderby=Date`
    ),
    fetchAll(
      `AccumulationRegister_Alsn_РасходыНаРекламу_RecordType?$format=json&$filter=Period ge datetime'${range.fromIso}' and Period le datetime'${range.toIso}' and Active eq true&$select=Номенклатура,ВидРекламнойКомпании,Сумма`
    ),
  ]);

  const byNom = new Map();
  const ensureNom = (id) => {
    const key = id || EMPTY;
    if (!byNom.has(key)) byNom.set(key, emptyMetrics());
    return byNom.get(key);
  };

  const saleKeys = docs.map((d) => d.Ref_Key);
  const keyBatches = [];
  for (let i = 0; i < saleKeys.length; i += 8) keyBatches.push(saleKeys.slice(i, i + 8));
  await mapPool(keyBatches, 8, async (part) => {
    try {
      const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
      const rows = await fetchAll(
        `Document_Alsn_Продажи_Товары?$format=json&$filter=${filter}&$select=Ref_Key,Номенклатура,Количество,Сумма`
      );
      for (const row of rows) {
        const m = ensureNom(String(row.Номенклатура || ""));
        const qty = num(row.Количество);
        m.qty += qty;
        m.sum += num(row.Сумма) * qty;
      }
    } catch (err) {
      warnings.push(`Товары продаж: ${String(err.message || err).slice(0, 120)}`);
    }
  });

  for (const row of ads) {
    const m = ensureNom(String(row.Номенклатура || ""));
    const amount = num(row.Сумма);
    const kind = enumTail(row.ВидРекламнойКомпании);
    if (kind === AD_SEARCH || /поиск/i.test(kind)) m.search += amount;
    else if (kind === AD_STENCIL || /трафарет/i.test(kind)) m.stencil += amount;
    else if (kind === AD_ORDER || /заказ/i.test(kind)) m.order += amount;
  }

  const nomIds = [...byNom.keys()].filter((k) => k && k !== EMPTY);
  const nomMap = await fetchByKeys(
    "Catalog_Номенклатура",
    nomIds,
    "Ref_Key,Description,ТоварнаяКатегория_Key"
  );
  const catIds = [...nomMap.values()].map((r) => r.ТоварнаяКатегория_Key).filter(Boolean);
  const catMap = await fetchByKeys("Catalog_ТоварныеКатегории", catIds, "Ref_Key,Description");

  const groups = new Map();
  for (const [nom, metrics] of byNom.entries()) {
    if (nom === EMPTY) {
      const name = "Без номенклатуры";
      if (!groups.has(name)) groups.set(name, { name, metrics: emptyMetrics(), children: [] });
      addMetrics(groups.get(name).metrics, metrics);
      groups.get(name).children.push({ name: "Без номенклатуры", metrics });
      continue;
    }
    const card = nomMap.get(nom);
    const catKey = card?.ТоварнаяКатегория_Key || EMPTY;
    const catName = catMap.get(catKey)?.Description || "Без категории";
    if (!groups.has(catName)) groups.set(catName, { name: catName, metrics: emptyMetrics(), children: [] });
    const group = groups.get(catName);
    addMetrics(group.metrics, metrics);
    group.children.push({
      name: card?.Description || `Номенклатура ${String(nom).slice(0, 8)}`,
      metrics,
    });
  }

  const groupRows = [...groups.values()]
    .map((g) => ({
      name: g.name,
      metrics: finishMetrics(g.metrics),
      children: g.children
        .map((c) => ({ name: c.name, metrics: finishMetrics(c.metrics) }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const totalRaw = emptyMetrics();
  for (const g of groups.values()) addMetrics(totalRaw, g.metrics);

  return {
    generatedAt: new Date().toISOString(),
    source: "1С ecotidy",
    organization: "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    title: "Расчет доли рекламных расходов",
    period: { from: range.from, to: range.to },
    groups: groupRows,
    total: finishMetrics(totalRaw),
    counts: { saleDocs: docs.length, adRows: ads.length, nomenclature: nomIds.length },
    warnings,
  };
}
