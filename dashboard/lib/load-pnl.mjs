import { odataAllPages } from "./odata.mjs";
import { EMPTY_GUID, isCompletedOrder } from "../load-employees.mjs";

const ORG_NAME = "Аллсан Интеграция";
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  return Math.round(num(value) * 100) / 100;
}

function round1(value) {
  return Math.round(num(value) * 10) / 10;
}

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDay(text) {
  const m = String(text || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function odataDate(d, endOfDay = false) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return endOfDay ? `${y}-${m}-${day}T23:59:59` : `${y}-${m}-${day}T00:00:00`;
}

export function defaultPnlRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 4, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: isoDay(from), to: isoDay(to) };
}

export function monthColumns(fromText, toText) {
  const from = parseDay(fromText);
  const to = parseDay(toText);
  if (!from || !to || from > to) throw new Error("Некорректный период");
  const months = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), 1);
  const last = new Date(to.getFullYear(), to.getMonth(), 1);
  while (cur <= last) {
    months.push({
      key: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`,
      label: `${MONTHS_RU[cur.getMonth()]} ${cur.getFullYear()}`,
      year: cur.getFullYear(),
      month: cur.getMonth(),
    });
    cur.setMonth(cur.getMonth() + 1);
  }
  if (months.length > 24) throw new Error("Период слишком длинный (больше 24 месяцев)");
  return months;
}

function monthKeyOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function moneyOf(doc) {
  return roundMoney(doc.СуммаДокумента ?? doc.Sum ?? doc.Сумма ?? doc.Amount ?? 0);
}

function zeros(n) {
  return Array.from({ length: n }, () => 0);
}

function addInto(map, name, index, amount, len) {
  if (!amount) return;
  if (!map.has(name)) map.set(name, zeros(len));
  map.get(name)[index] += amount;
}

function roundCell(kind, value) {
  if (kind === "pct" || kind === "hours") return round1(value);
  return roundMoney(value);
}

function rowFromValues(name, values, kind = "line") {
  const total = values.reduce((s, v) => s + v, 0);
  return { name, kind, values: values.map((v) => roundCell(kind, v)), total: roundCell(kind, total) };
}

function sumMaps(maps, len) {
  const out = zeros(len);
  for (const m of maps) {
    for (const vals of m.values()) {
      for (let i = 0; i < len; i++) out[i] += vals[i] || 0;
    }
  }
  return out;
}

function subVec(a, b) {
  return a.map((v, i) => v - (b[i] || 0));
}

function pctVec(profit, revenue) {
  return profit.map((p, i) => {
    const r = revenue[i] || 0;
    return r ? (p / r) * 100 : 0;
  });
}

function linesOf(map) {
  return [...map.entries()]
    .map(([name, values]) => rowFromValues(name, values))
    .filter((r) => r.total !== 0 || r.values.some((v) => v !== 0))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total) || a.name.localeCompare(b.name, "ru"));
}

async function tryPages(path) {
  try {
    return await odataAllPages(path, 80);
  } catch (err) {
    return { error: String(err.message || err), rows: [] };
  }
}

async function orgKey() {
  const data = await tryPages("Catalog_Организации?$format=json&$select=Ref_Key,Description&$top=50");
  const rows = Array.isArray(data) ? data : data.rows;
  const hit = (rows || []).find((r) => String(r.Description || "").trim() === ORG_NAME);
  return hit?.Ref_Key || "";
}

function dateFilter(from, to, org, dateField = "Date") {
  const parts = [
    "DeletionMark eq false",
    `${dateField} ge datetime'${odataDate(from)}'`,
    `${dateField} le datetime'${odataDate(to, true)}'`,
  ];
  if (org) parts.push(`Организация_Key eq guid'${org}'`);
  return parts.join(" and ");
}

async function loadPosted(entity, from, to, org, extra = "Posted eq true") {
  if (!org) return { entity, rows: [], error: "" };
  const filter = encodeURIComponent(`${dateFilter(from, to, org)} and ${extra}`);
  const path = `${entity}?$format=json&$filter=${filter}&$select=Date,СуммаДокумента,Posted,DeletionMark&$top=200`;
  const data = await tryPages(path);
  if (Array.isArray(data)) return { entity, rows: data, error: "" };
  return { entity, rows: data.rows || [], error: data.error || "" };
}

async function resolveNames(ids, entity) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && id !== EMPTY_GUID))];
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await odataAllPages(`${entity}?$format=json&$filter=${filter}&$select=Ref_Key,Description&$top=50`);
    for (const row of rows) map.set(row.Ref_Key, String(row.Description || "").trim() || "Без имени");
  }
  return map;
}

function classifyExpense(name) {
  const n = String(name || "").toLowerCase();
  if (/проч.*доход|внереализац|проценты получен/.test(n)) return "otherIncome";
  if (/простой/.test(n)) return "otherCogs";
  if (/оплат.*аналитик|аналитик/.test(n)) return "otherCogs";
  if (/бонус/.test(n) && /продаж/.test(n)) return "otherCogs";
  if (/r\s*&\s*d|рнп|research/.test(n)) return "commercial";
  if (/маркетинг/.test(n)) return "commercial";
  if (/зарплат|фоте|оплата труда|вознагражден/.test(n)) {
    if (/продаж|коммерч/.test(n)) return "commercial";
    return "operating";
  }
  if (/обучен|семинар/.test(n)) return "fixed";
  if (/офис/.test(n)) return "fixed";
  if (/связ|телефон|интернет/.test(n)) return "fixed";
  if (/аренд/.test(n)) return "fixed";
  if (/транспорт|такси|бензин/.test(n)) return "fixed";
  if (/налог|взнос|ндс|усн/.test(n)) return "fixed";
  if (/сервер|хостинг|vps|облак/.test(n)) return "fixed";
  return "fixed";
}

function bucketDocs(rows, months, from, to) {
  const index = new Map(months.map((m, i) => [m.key, i]));
  const map = new Map();
  const fromT = from.getTime();
  const toT = to.getTime() + 24 * 60 * 60 * 1000 - 1;
  for (const doc of rows) {
    if (doc.Posted === false) continue;
    const t = Date.parse(doc.Date);
    if (!Number.isFinite(t) || t < fromT || t > toT) continue;
    const i = index.get(monthKeyOf(doc.Date));
    if (i == null) continue;
    addInto(map, "row", i, moneyOf(doc), months.length);
  }
  return map.get("row") || zeros(months.length);
}

function putNamed(rows, name, months, from, to) {
  const map = new Map();
  const vec = bucketDocs(rows, months, from, to);
  if (vec.some((v) => v)) map.set(name, vec);
  return map;
}

async function loadCashOut(from, to, org, months) {
  if (!org) return { buckets: { otherCogs: new Map(), operating: new Map(), commercial: new Map(), fixed: new Map(), otherIncome: new Map() }, warnings: [] };
  const filter = encodeURIComponent(`${dateFilter(from, to, org)} and Posted eq true`);
  const entities = [
    "Document_СписаниеБезналичныхДенежныхСредств",
    "Document_РасходныйКассовыйОрдер",
  ];
  const warnings = [];
  const raw = [];
  for (const entity of entities) {
    const path = `${entity}?$format=json&$filter=${filter}&$select=Date,СуммаДокумента,СтатьяДвиженияДенежныхСредств_Key,Posted,DeletionMark&$top=200`;
    const data = await tryPages(path);
    const rows = Array.isArray(data) ? data : data.rows;
    const err = Array.isArray(data) ? "" : data.error;
    if (err) warnings.push(`${entity}: нет в OData`);
    else raw.push(...(rows || []));
  }
  let names = new Map();
  try {
    names = await resolveNames(raw.map((r) => r.СтатьяДвиженияДенежныхСредств_Key), "Catalog_СтатьиДвиженияДенежныхСредств");
  } catch (err) {
    warnings.push(`Статьи ДДС: ${String(err.message || err).slice(0, 160)}`);
  }
  const index = new Map(months.map((m, i) => [m.key, i]));
  const fromT = from.getTime();
  const toT = to.getTime() + 24 * 60 * 60 * 1000 - 1;
  const buckets = {
    otherCogs: new Map(),
    operating: new Map(),
    commercial: new Map(),
    fixed: new Map(),
    otherIncome: new Map(),
  };
  for (const doc of raw) {
    if (doc.Posted === false) continue;
    const t = Date.parse(doc.Date);
    if (!Number.isFinite(t) || t < fromT || t > toT) continue;
    const i = index.get(monthKeyOf(doc.Date));
    if (i == null) continue;
    const article = names.get(doc.СтатьяДвиженияДенежныхСредств_Key) || "Без статьи";
    const section = classifyExpense(article);
    addInto(buckets[section], article, i, moneyOf(doc), months.length);
  }
  return { buckets, warnings };
}

async function loadClosedHours(from, to, months) {
  const statusRows = await odataAllPages("Catalog_СтатусыЗадач?$format=json&$top=200");
  const completed = [];
  for (const row of statusRows) {
    if (row.DeletionMark) continue;
    if (!isCompletedOrder(row.Порядок)) continue;
    completed.push(row.Ref_Key);
  }
  const index = new Map(months.map((m, i) => [m.key, i]));
  const fromT = from.getTime();
  const toT = to.getTime() + 24 * 60 * 60 * 1000 - 1;
  const hours = zeros(months.length);
  for (const statusId of completed) {
    const filter = encodeURIComponent(
      `Статус_Key eq guid'${statusId}' and DeletionMark eq false and ДатаИсполнения ge datetime'${odataDate(from)}' and ДатаИсполнения le datetime'${odataDate(to, true)}'`
    );
    let rows;
    try {
      rows = await odataAllPages(`Document_ЗадачаРазработчика?$format=json&$filter=${filter}&$select=ДатаИсполнения,Date,Часы,Архив&$top=200`, 80);
    } catch {
      const fallback = encodeURIComponent(
        `Статус_Key eq guid'${statusId}' and DeletionMark eq false and Date ge datetime'${odataDate(from)}' and Date le datetime'${odataDate(to, true)}'`
      );
      rows = await odataAllPages(`Document_ЗадачаРазработчика?$format=json&$filter=${fallback}&$select=ДатаИсполнения,Date,Часы,Архив&$top=200`, 80);
    }
    for (const task of rows) {
      if (task.Архив) continue;
      const when = task.ДатаИсполнения && !String(task.ДатаИсполнения).startsWith("0001") ? task.ДатаИсполнения : task.Date;
      const t = Date.parse(when);
      if (!Number.isFinite(t) || t < fromT || t > toT) continue;
      const i = index.get(monthKeyOf(when));
      if (i == null) continue;
      hours[i] += num(task.Часы);
    }
  }
  return hours.map(round1);
}

function afterCost(title, extraLines, revenue, prevProfit, costVec) {
  const profit = subVec(prevProfit, costVec);
  const rent = pctVec(profit, revenue);
  const revSum = revenue.reduce((s, v) => s + v, 0);
  const profitSum = profit.reduce((s, v) => s + v, 0);
  return {
    title,
    rows: [
      ...extraLines,
      rowFromValues("Итого " + title.toLowerCase(), costVec, "total"),
      rowFromValues("Итого прибыль", profit, "total"),
      { name: "Рентабельность", kind: "pct", values: rent.map(round1), total: revSum ? round1((profitSum / revSum) * 100) : 0 },
    ],
    profit,
  };
}

export async function loadPnl(fromText, toText) {
  const from = parseDay(fromText);
  const to = parseDay(toText);
  if (!from || !to) throw new Error("Укажите период с и по");
  const months = monthColumns(fromText, toText);
  const warnings = [];
  let org = "";
  try {
    org = await orgKey();
  } catch (err) {
    warnings.push(String(err.message || err));
  }
  if (!org) warnings.push("Организация «Аллсан Интеграция» не найдена — суммы по документам не собраны.");

  const salesEntities = [
    ["Document_РеализацияТоваровУслуг", "Реализация товаров и услуг"],
    ["Document_АктВыполненныхРабот", "Акт выполненных работ"],
    ["Document_РеализацияУслугПрочихАктивов", "Реализация услуг и прочих активов"],
  ];
  const salesMap = new Map();
  for (const [entity, label] of salesEntities) {
    const { rows, error } = await loadPosted(entity, from, to, org);
    if (error) warnings.push(error.includes("404") || /не найден|Not Found/i.test(error) ? `${label}: нет в OData` : `${label}: ${error.slice(0, 160)}`);
    for (const [k, v] of putNamed(rows, label, months, from, to)) salesMap.set(k, v);
  }

  const cogsEntities = [
    ["Document_ПриобретениеТоваровУслуг", "Приобретение товаров и услуг"],
    ["Document_ПоступлениеТоваровУслуг", "Поступление товаров и услуг"],
  ];
  const cogsMap = new Map();
  for (const [entity, label] of cogsEntities) {
    const { rows, error } = await loadPosted(entity, from, to, org);
    if (error) warnings.push(`${label}: нет в OData или нет доступа`);
    for (const [k, v] of putNamed(rows, label, months, from, to)) cogsMap.set(k, v);
  }

  const cash = await loadCashOut(from, to, org, months);
  warnings.push(...cash.warnings);

  let hours = zeros(months.length);
  try {
    hours = await loadClosedHours(from, to, months);
  } catch (err) {
    warnings.push(`Закрытые часы: ${String(err.message || err).slice(0, 180)}`);
  }

  const n = months.length;
  const revenue = sumMaps([salesMap], n);
  const cogs = sumMaps([cogsMap], n);
  const otherCogs = sumMaps([cash.buckets.otherCogs], n);
  const operating = sumMaps([cash.buckets.operating], n);
  const commercial = sumMaps([cash.buckets.commercial], n);
  const fixed = sumMaps([cash.buckets.fixed], n);

  const salesRows = [
    ...linesOf(salesMap),
    rowFromValues("Итого выручка", revenue, "total"),
  ];

  const cogsBlock = afterCost("Себестоимость", linesOf(cogsMap), revenue, revenue, cogs);
  const otherBlock = afterCost("Себестоимость прочая", linesOf(cash.buckets.otherCogs), revenue, cogsBlock.profit, otherCogs);
  const operBlock = afterCost("Операционные расходы", linesOf(cash.buckets.operating), revenue, otherBlock.profit, operating);
  const commBlock = afterCost("Коммерческие расходы", linesOf(cash.buckets.commercial), revenue, operBlock.profit, commercial);
  const fixedBlock = afterCost("Постоянные расходы", linesOf(cash.buckets.fixed), revenue, commBlock.profit, fixed);

  const otherIn = sumMaps([cash.buckets.otherIncome], n);
  const profitFinal = subVec(fixedBlock.profit, otherIn.map((v) => -v));
  const otherIncomeRows = [
    ...linesOf(cash.buckets.otherIncome),
    rowFromValues("Итого прибыль", profitFinal, "total"),
    (() => {
      const rent = pctVec(profitFinal, revenue);
      const revSum = revenue.reduce((s, v) => s + v, 0);
      const pSum = profitFinal.reduce((s, v) => s + v, 0);
      return { name: "Рентабельность", kind: "pct", values: rent.map(round1), total: revSum ? round1((pSum / revSum) * 100) : 0 };
    })(),
  ];

  const avgPrice = hours.map((h, i) => (h ? roundMoney(revenue[i] / h) : 0));
  const costTotal = cogs.map((v, i) => v + otherCogs[i] + operating[i] + commercial[i] + fixed[i]);
  const avgCost = hours.map((h, i) => (h ? roundMoney(costTotal[i] / h) : 0));
  const hourYield = hours.map((h, i) => (h ? roundMoney(profitFinal[i] / h) : 0));

  const hoursSum = hours.reduce((s, v) => s + v, 0);
  const revSum = revenue.reduce((s, v) => s + v, 0);
  const costSum = costTotal.reduce((s, v) => s + v, 0);
  const profitSum = profitFinal.reduce((s, v) => s + v, 0);
  const avgRow = (name, monthVals, total) => ({
    name,
    kind: "line",
    values: monthVals.map(roundMoney),
    total: roundMoney(total),
  });

  const sections = [
    { title: "Продажи", rows: salesRows },
    { title: cogsBlock.title, rows: cogsBlock.rows },
    { title: otherBlock.title, rows: otherBlock.rows },
    { title: operBlock.title, rows: operBlock.rows },
    { title: commBlock.title, rows: commBlock.rows },
    { title: fixedBlock.title, rows: fixedBlock.rows },
    { title: "Прочие доходы", rows: otherIncomeRows },
    {
      title: "Справочно",
      rows: [
        rowFromValues("Количество закрытых часов", hours, "hours"),
        avgRow("Средняя цена часа", avgPrice, hoursSum ? revSum / hoursSum : 0),
        avgRow("Средняя себестоимость часа", avgCost, hoursSum ? costSum / hoursSum : 0),
        avgRow("Доходность часа", hourYield, hoursSum ? profitSum / hoursSum : 0),
      ],
    },
  ];

  return {
    from: fromText,
    to: toText,
    organization: ORG_NAME,
    months: months.map((m) => ({ key: m.key, label: m.label })),
    sections,
    warnings: [...new Set(warnings.filter(Boolean))],
    generatedAt: new Date().toISOString(),
    note: "Код исходного отчёта 1С не прислан: выручка и закупки — по проведённым документам, расходы — по статьям ДДС, закрытые часы — задачи со статусом Порядок ≥ 7 и датой исполнения в периоде.",
  };
}
