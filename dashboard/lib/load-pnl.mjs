import { odataAllPages } from "./odata.mjs";
import { EMPTY_GUID } from "../load-employees.mjs";

const ORG_NAME = "Аллсан Интеграция";
const MONTHS_RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const ALLOWED_EXPENSE_VARIANTS = ["НаНаправленияДеятельности", "НеРаспределять"];

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

function roundPct(value) {
  return Math.round(num(value));
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
  const from = new Date(now.getFullYear(), now.getMonth() - 3, 1);
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

function zeros(n) {
  return Array.from({ length: n }, () => 0);
}

function addInto(map, name, index, amount, len) {
  if (!amount) return;
  if (!map.has(name)) map.set(name, zeros(len));
  map.get(name)[index] += amount;
}

function roundCell(kind, value) {
  if (kind === "pct") return roundPct(value);
  if (kind === "hours") return round1(value);
  return roundMoney(value);
}

function rowFromValues(name, values, kind = "line") {
  const total = values.reduce((s, v) => s + v, 0);
  return { name, kind, values: values.map((v) => roundCell(kind, v)), total: roundCell(kind, total) };
}

function sumVec(list, len) {
  const out = zeros(len);
  for (const vals of list) {
    for (let i = 0; i < len; i++) out[i] += vals[i] || 0;
  }
  return out;
}

function subVec(a, b) {
  return a.map((v, i) => v - (b[i] || 0));
}

function addVec(a, b) {
  return a.map((v, i) => v + (b[i] || 0));
}

function pctVec(profit, revenue) {
  return profit.map((p, i) => {
    const r = revenue[i] || 0;
    return r ? (p / r) * 100 : 0;
  });
}

function safeDiv(a, b) {
  return b ? a / b : 0;
}

function firstNumber(row, names) {
  for (const name of names) {
    if (row[name] != null && row[name] !== "") return num(row[name]);
  }
  return 0;
}

function extractKey(value) {
  if (!value) return "";
  if (typeof value === "object") {
    return String(value.Ref_Key || value.Key || "").trim();
  }
  const text = String(value);
  const guid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return guid ? guid[0] : text.trim();
}

function refKey(row, name) {
  return extractKey(row[`${name}_Key`]) || extractKey(row[name]);
}

function isEmptyGuid(id) {
  return !id || id === EMPTY_GUID;
}

function isReceipt(row) {
  const rt = String(row.RecordType || row.ВидДвижения || "");
  if (!rt) return true;
  if (/Expense|Расход/i.test(rt)) return false;
  return true;
}

function variantAllowed(value) {
  const text = String(value || "");
  return ALLOWED_EXPENSE_VARIANTS.some((name) => text.includes(name));
}

export function classifyOpKo(bonusEnd, periodIso) {
  const end = Date.parse(bonusEnd);
  const period = Date.parse(periodIso);
  if (!Number.isFinite(end) || !Number.isFinite(period) || end < Date.parse("2000-01-01T00:00:00")) return "КО";
  return end > period ? "ОП" : "КО";
}

async function tryPages(path) {
  try {
    return await odataAllPages(path, 80);
  } catch (err) {
    return { error: String(err.message || err), rows: [] };
  }
}

function rowsOf(data) {
  return Array.isArray(data) ? data : data.rows || [];
}

function errorOf(data) {
  return Array.isArray(data) ? "" : data.error || "";
}

async function tryEntity(paths) {
  const warnings = [];
  for (const path of paths) {
    const data = await tryPages(path);
    const err = errorOf(data);
    if (!err) return { rows: rowsOf(data), error: "", warnings };
    warnings.push(err);
  }
  return { rows: [], error: warnings[warnings.length - 1] || "нет в OData", warnings };
}

async function orgKey() {
  const data = await tryPages("Catalog_Организации?$format=json&$select=Ref_Key,Description&$top=50");
  const rows = rowsOf(data);
  const hit = rows.find((r) => String(r.Description || "").trim() === ORG_NAME);
  return hit?.Ref_Key || "";
}

async function resolveByKeys(entity, ids, select) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && !isEmptyGuid(id)))];
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const data = await tryPages(`${entity}?$format=json&$filter=${filter}&$select=${select}&$top=50`);
    if (errorOf(data)) {
      const fallback = await tryPages(`${entity}?$format=json&$filter=${filter}&$top=50`);
      for (const row of rowsOf(fallback)) map.set(row.Ref_Key, row);
      continue;
    }
    for (const row of rowsOf(data)) map.set(row.Ref_Key, row);
  }
  return map;
}

function dirFromRow(row) {
  return {
    name: String(row.Description || row.Наименование || "").trim() || "Без имени",
    order: Number.isFinite(Number(row.Порядок)) ? Number(row.Порядок) : 999,
    isRevenue: row.Выручка !== false && row.Выручка !== "false" && row.Выручка !== 0,
  };
}

async function loadDirSettings() {
  const warnings = [];
  const headersData = await tryEntity([
    "Catalog_НастройкаДИР?$format=json&$filter=DeletionMark eq false&$expand=СтатьиРасходаВыручки&$top=200",
    "Catalog_НастройкаДИР?$format=json&$filter=DeletionMark eq false&$top=200",
  ]);
  if (headersData.error) {
    return { byItem: new Map(), headers: [], warnings: [`НастройкаДИР: ${headersData.error.slice(0, 180)}`] };
  }
  const headers = rowsOf(headersData).map((row) => {
    const raw = row.СтатьиРасходаВыручки;
    const lines = Array.isArray(raw) ? raw : raw?.results || [];
    return { key: row.Ref_Key, ...dirFromRow(row), lines };
  });
  let lines = headers.flatMap((h) => (h.lines || []).map((line) => ({ ...line, Ref_Key: line.Ref_Key || h.key })));
  if (!lines.length) {
    const linesData = await tryEntity([
      "Catalog_НастройкаДИР_СтатьиРасходаВыручки?$format=json&$top=500",
    ]);
    if (linesData.error) warnings.push(`НастройкаДИР.СтатьиРасходаВыручки: ${linesData.error.slice(0, 160)}`);
    lines = rowsOf(linesData);
  }
  const headerByKey = new Map(headers.map((h) => [h.key, h]));
  const byItem = new Map();
  for (const line of lines) {
    const parent = headerByKey.get(line.Ref_Key) || dirFromRow(line);
    const itemKey = refKey(line, "СтатьяРасходаНоменклатура") || extractKey(line.СтатьяРасходаНоменклатура);
    if (isEmptyGuid(itemKey)) continue;
    const prev = byItem.get(itemKey);
    const next = {
      name: parent.name || "Без имени",
      order: parent.order ?? 999,
      isRevenue: parent.isRevenue !== false,
    };
    if (!prev || next.order < prev.order) byItem.set(itemKey, next);
  }
  if (!byItem.size) warnings.push("НастройкаДИР: нет сопоставления номенклатуры и статей");
  return { byItem, headers, warnings };
}

function mapRevenueItem(byItem, nomenclatureKey) {
  const hit = byItem.get(nomenclatureKey);
  if (!hit) return { name: "Прочая выручка", order: 999, isRevenue: true };
  if (!hit.isRevenue) return null;
  return hit;
}

function mapExpenseItem(byItem, articleKey) {
  const hit = byItem.get(articleKey);
  if (!hit) return { name: "Прочий расход", order: 999, isRevenue: false };
  if (hit.isRevenue) return null;
  return hit;
}

function periodFilter(from, to) {
  return `Period ge datetime'${odataDate(from)}' and Period le datetime'${odataDate(to, true)}'`;
}

async function loadSalesRegister(from, to) {
  const select = "Period,Active,RecordType,АналитикаУчетаНоменклатуры_Key,АналитикаУчетаПоПартнерам_Key,Организация_Key,СуммаВыручки,СебестоимостьРегл,Количество";
  const filter = encodeURIComponent(`${periodFilter(from, to)} and Active eq true`);
  return tryEntity([
    `AccumulationRegister_ВыручкаИСебестоимостьПродаж?$format=json&$filter=${filter}&$select=${select}&$top=200`,
    `AccumulationRegister_ВыручкаИСебестоимостьПродаж?$format=json&$filter=${filter}&$top=200`,
  ]);
}

async function loadOtherExpenses(from, to) {
  const filterReceipt = encodeURIComponent(`${periodFilter(from, to)} and Active eq true and RecordType eq 'Receipt'`);
  const filterPlain = encodeURIComponent(`${periodFilter(from, to)} and Active eq true`);
  const select = "Period,Active,RecordType,СтатьяРасходов_Key,Организация_Key,Сумма,СуммаУпр,СуммаРегл";
  return tryEntity([
    `AccumulationRegister_ПрочиеРасходы?$format=json&$filter=${filterReceipt}&$select=${select}&$top=200`,
    `AccumulationRegister_ПрочиеРасходы?$format=json&$filter=${filterPlain}&$select=${select}&$top=200`,
    `AccumulationRegister_ПрочиеРасходы?$format=json&$filter=${filterPlain}&$top=200`,
  ]);
}

async function loadOtherIncomeReg(from, to) {
  const filterReceipt = encodeURIComponent(`${periodFilter(from, to)} and Active eq true and RecordType eq 'Receipt'`);
  const filterPlain = encodeURIComponent(`${periodFilter(from, to)} and Active eq true`);
  const select = "Period,Active,RecordType,СтатьяДоходов_Key,Организация_Key,Сумма,СуммаУпр,СуммаРегл";
  return tryEntity([
    `AccumulationRegister_ПрочиеДоходы?$format=json&$filter=${filterReceipt}&$select=${select}&$top=200`,
    `AccumulationRegister_ПрочиеДоходы?$format=json&$filter=${filterPlain}&$select=${select}&$top=200`,
    `AccumulationRegister_ПрочиеДоходы?$format=json&$filter=${filterPlain}&$top=200`,
  ]);
}

async function findMarketingKey() {
  const data = await tryEntity([
    "Catalog_Номенклатура?$format=json&$filter=PredefinedDataName eq 'Маркетинг'&$select=Ref_Key,Description,PredefinedDataName&$top=5",
    "Catalog_Номенклатура?$format=json&$filter=Description eq 'Маркетинг' and DeletionMark eq false&$select=Ref_Key,Description&$top=5",
  ]);
  return rowsOf(data)[0]?.Ref_Key || "";
}

function monthIndex(months, iso) {
  const key = monthKeyOf(iso);
  return months.findIndex((m) => m.key === key);
}

function rowMoney(name, values) {
  return rowFromValues(name, values, "line");
}

function totalsAndRent(title, costVec, prevProfit, revenue) {
  const profit = subVec(prevProfit, costVec);
  const rent = pctVec(profit, revenue);
  const revSum = revenue.reduce((s, v) => s + v, 0);
  const profitSum = profit.reduce((s, v) => s + v, 0);
  return {
    rows: [
      rowFromValues(title, costVec, "total"),
      rowFromValues("Итого прибыль:", profit, "total"),
      { name: "Рентабельность:", kind: "pct", values: rent.map(roundPct), total: revSum ? roundPct((profitSum / revSum) * 100) : 0 },
    ],
    profit,
  };
}

export function avgHourMetrics({
  revenueSales,
  hours,
  marketing,
  support,
  cogs,
  cogsSales,
  otherCogs,
}) {
  const hoursNet = hours.map((h, i) => h - (marketing[i] || 0));
  const avgPrice = revenueSales.map((v, i) => safeDiv(v, hoursNet[i]));
  const cleanup = support.map((v, i) => v / 2 + ((cogs[i] || 0) - (cogsSales[i] || 0)));
  const avgCost = otherCogs.map((v, i) => safeDiv((v || 0) + (cogs[i] || 0) - (cleanup[i] || 0), hoursNet[i]));
  const hourRent = avgPrice.map((v, i) => v - (avgCost[i] || 0));
  const hourYield = avgPrice.map((v, i) => (v ? ((v - (avgCost[i] || 0)) / v) * 100 : 0));
  const hoursNetSum = hoursNet.reduce((s, v) => s + v, 0);
  const priceTotal = safeDiv(revenueSales.reduce((s, v) => s + v, 0), hoursNetSum);
  const costTotal = safeDiv(
    otherCogs.reduce((s, v) => s + v, 0) + cogs.reduce((s, v) => s + v, 0) - cleanup.reduce((s, v) => s + v, 0),
    hoursNetSum
  );
  return { hoursNet, avgPrice, avgCost, hourRent, hourYield, priceTotal, costTotal, hoursNetSum };
}

export async function loadPnl(fromText, toText) {
  const from = parseDay(fromText);
  const to = parseDay(toText);
  if (!from || !to) throw new Error("Укажите период с и по");
  const months = monthColumns(fromText, toText);
  const n = months.length;
  const warnings = [];
  let org = "";
  try {
    org = await orgKey();
  } catch (err) {
    warnings.push(String(err.message || err));
  }
  if (!org) warnings.push("Организация «Аллсан Интеграция» не найдена — отбор по организации не применён.");

  const dir = await loadDirSettings();
  warnings.push(...dir.warnings);

  const salesReg = await loadSalesRegister(from, to);
  if (salesReg.error) warnings.push(`Выручка и себестоимость продаж: ${salesReg.error.slice(0, 180)}`);
  const expensesReg = await loadOtherExpenses(from, to);
  if (expensesReg.error) warnings.push(`Прочие расходы: ${expensesReg.error.slice(0, 180)}`);
  const incomeReg = await loadOtherIncomeReg(from, to);
  if (incomeReg.error) warnings.push(`Прочие доходы: ${incomeReg.error.slice(0, 180)}`);

  const salesRowsRaw = rowsOf(salesReg).filter((row) => row.Active !== false && isReceipt(row));
  const nomenKeys = salesRowsRaw.map((r) => refKey(r, "АналитикаУчетаНоменклатуры"));
  const partnerKeys = salesRowsRaw.map((r) => refKey(r, "АналитикаУчетаПоПартнерам"));
  const [nomenKeysMap, partnerKeysMap] = await Promise.all([
    resolveByKeys("Catalog_КлючиАналитикиУчетаНоменклатуры", nomenKeys, "Ref_Key,Номенклатура_Key"),
    resolveByKeys("Catalog_КлючиАналитикиУчетаПоПартнерам", partnerKeys, "Ref_Key,Контрагент_Key,Организация_Key"),
  ]);

  const counterparties = await resolveByKeys(
    "Catalog_Контрагенты",
    [...partnerKeysMap.values()].map((r) => refKey(r, "Контрагент")),
    "Ref_Key,Description,ОкончанияБонусовОП"
  );
  const nomenclatures = await resolveByKeys(
    "Catalog_Номенклатура",
    [...nomenKeysMap.values()].map((r) => refKey(r, "Номенклатура")),
    "Ref_Key,Description,PredefinedDataName"
  );

  const orgFromPartner = (partnerKey) => refKey(partnerKeysMap.get(partnerKey) || {}, "Организация");
  const keepOrg = (row, partnerKey) => {
    if (!org) return true;
    const direct = refKey(row, "Организация");
    if (direct) return direct === org;
    const via = orgFromPartner(partnerKey);
    if (via) return via === org;
    return true;
  };

  const revenueMap = new Map();
  const cogsMap = new Map();
  const hours = zeros(n);
  const marketing = zeros(n);
  const rowMeta = new Map();
  let marketingKey = "";
  try {
    marketingKey = await findMarketingKey();
  } catch (err) {
    warnings.push(`Номенклатура «Маркетинг»: ${String(err.message || err).slice(0, 160)}`);
  }
  if (!marketingKey) {
    const byName = [...nomenclatures.entries()].find(([, row]) => String(row.Description || "").trim() === "Маркетинг");
    marketingKey = byName?.[0] || "";
  }

  for (const row of salesRowsRaw) {
    const partnerKey = refKey(row, "АналитикаУчетаПоПартнерам");
    if (!keepOrg(row, partnerKey)) continue;
    const i = monthIndex(months, row.Period);
    if (i < 0) continue;
    const analyticsNomen = nomenKeysMap.get(refKey(row, "АналитикаУчетаНоменклатуры"));
    const nomenKey = refKey(analyticsNomen || {}, "Номенклатура") || refKey(row, "Номенклатура");
    const mapped = mapRevenueItem(dir.byItem, nomenKey);
    if (!mapped) continue;
    const partner = partnerKeysMap.get(partnerKey);
    const contr = counterparties.get(refKey(partner || {}, "Контрагент"));
    const op = classifyOpKo(contr?.ОкончанияБонусовОП, row.Period);
    const key = `${mapped.order}\t${mapped.name}\t${op}`;
    rowMeta.set(key, mapped);
    addInto(revenueMap, key, i, firstNumber(row, ["СуммаВыручки", "СуммаВыручкиОборот"]), n);
    addInto(cogsMap, key, i, firstNumber(row, ["СебестоимостьРегл", "СебестоимостьРеглОборот"]), n);
    const qty = firstNumber(row, ["Количество", "КоличествоОборот"]);
    if (mapped.order === 1) hours[i] += qty;
    if (marketingKey && nomenKey === marketingKey && mapped.order === 1) marketing[i] += qty;
  }

  const salesKeys = [...revenueMap.keys()].sort((a, b) => {
    const ma = rowMeta.get(a) || { order: 999, name: a };
    const mb = rowMeta.get(b) || { order: 999, name: b };
    if (ma.order !== mb.order) return ma.order - mb.order;
    if (ma.name !== mb.name) return ma.name.localeCompare(mb.name, "ru");
    const opA = a.split("\t")[2] || "";
    const opB = b.split("\t")[2] || "";
    return opA.localeCompare(opB, "ru");
  });

  const labelOf = (prefix, key) => {
    const parts = key.split("\t");
    return `${prefix} ${parts[1]} ${parts[2]}`;
  };
  const salesLines = salesKeys
    .map((key) => rowMoney(labelOf("Выручка", key), revenueMap.get(key) || zeros(n)))
    .filter((r) => r.total !== 0 || r.values.some((v) => v));
  const cogsLines = salesKeys
    .map((key) => rowMoney(labelOf("Себестоимость", key), cogsMap.get(key) || zeros(n)))
    .filter((r) => r.total !== 0 || r.values.some((v) => v));

  const revenue = sumVec(salesKeys.map((k) => revenueMap.get(k) || zeros(n)), n);
  const cogs = sumVec(salesKeys.map((k) => cogsMap.get(k) || zeros(n)), n);
  const salesBlock = {
    title: "Продажи",
    rows: [...salesLines, rowFromValues("Итого выручка:", revenue, "total")],
  };
  const cogsTotals = totalsAndRent("Итого себестоимость:", cogs, revenue, revenue);
  const cogsBlock = { title: "Себестоимость", rows: [...cogsLines, ...cogsTotals.rows] };

  const expenseRowsRaw = rowsOf(expensesReg).filter((row) => row.Active !== false && isReceipt(row));
  const articleKeys = expenseRowsRaw.map((r) => refKey(r, "СтатьяРасходов"));
  const articles = await resolveByKeys(
    "Catalog_СтатьиРасходов",
    articleKeys,
    "Ref_Key,Description,ВариантРаспределенияРасходов"
  );
  const expenseSections = new Map();
  for (const row of expenseRowsRaw) {
    if (org && refKey(row, "Организация") && refKey(row, "Организация") !== org) continue;
    const i = monthIndex(months, row.Period);
    if (i < 0) continue;
    const articleKey = refKey(row, "СтатьяРасходов");
    const article = articles.get(articleKey);
    const variant = article?.ВариантРаспределенияРасходов;
    if (variant != null && variant !== "" && !variantAllowed(variant)) continue;
    const mapped = mapExpenseItem(dir.byItem, articleKey);
    if (!mapped) continue;
    const articleName = String(article?.Description || "Без статьи").trim() || "Без статьи";
    if (!expenseSections.has(mapped.name)) {
      expenseSections.set(mapped.name, { order: mapped.order, articles: new Map() });
    }
    const section = expenseSections.get(mapped.name);
    section.order = Math.min(section.order, mapped.order);
    addInto(section.articles, articleName, i, firstNumber(row, ["СуммаПриход", "Сумма", "СуммаУпр", "СуммаРегл"]), n);
  }

  const expenseBlocks = [];
  let profit = cogsTotals.profit;
  const orderedExpenseNames = [...expenseSections.entries()].sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0], "ru"));
  let otherCogs = zeros(n);
  for (const [title, section] of orderedExpenseNames) {
    const articleRows = [...section.articles.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "ru"))
      .map(([name, values]) => rowMoney(name, values))
      .filter((r) => r.total !== 0 || r.values.some((v) => v));
    const costVec = sumVec([...section.articles.values()], n);
    if (title === "Себестоимость прочая") otherCogs = costVec;
    const totals = totalsAndRent(`Итого ${title}:`, costVec, profit, revenue);
    profit = totals.profit;
    expenseBlocks.push({ title, rows: [...articleRows, ...totals.rows] });
  }

  const incomeRowsRaw = rowsOf(incomeReg).filter((row) => row.Active !== false && isReceipt(row));
  const incomeArticleKeys = incomeRowsRaw.map((r) => refKey(r, "СтатьяДоходов"));
  const incomeArticles = await resolveByKeys("Catalog_СтатьиДоходов", incomeArticleKeys, "Ref_Key,Description");
  const incomeMap = new Map();
  for (const row of incomeRowsRaw) {
    if (org && refKey(row, "Организация") && refKey(row, "Организация") !== org) continue;
    const i = monthIndex(months, row.Period);
    if (i < 0) continue;
    const name = String(incomeArticles.get(refKey(row, "СтатьяДоходов"))?.Description || "Без статьи").trim() || "Без статьи";
    addInto(incomeMap, name, i, firstNumber(row, ["СуммаПриход", "Сумма", "СуммаУпр", "СуммаРегл"]), n);
  }
  const incomeLines = [...incomeMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ru"))
    .map(([name, values]) => rowMoney(name, values));
  const incomeVec = sumVec([...incomeMap.values()], n);
  const profitAfterIncome = addVec(profit, incomeVec);
  const rentFinal = pctVec(profitAfterIncome, revenue);
  const revSum = revenue.reduce((s, v) => s + v, 0);
  const profitSum = profitAfterIncome.reduce((s, v) => s + v, 0);
  const incomeBlock = {
    title: "Прочие доходы",
    rows: [
      ...incomeLines,
      rowFromValues("Итого:", incomeVec, "total"),
      rowFromValues("Итого прибыль:", profitAfterIncome, "total"),
      { name: "Рентабельность:", kind: "pct", values: rentFinal.map(roundPct), total: revSum ? roundPct((profitSum / revSum) * 100) : 0 },
    ],
  };

  const firstTwo = salesKeys.slice(0, 2);
  const revenueSales = sumVec(firstTwo.map((k) => revenueMap.get(k) || zeros(n)), n);
  const cogsSales = sumVec(firstTwo.map((k) => cogsMap.get(k) || zeros(n)), n);
  const supportKeys = salesKeys.filter((k) => (rowMeta.get(k) || {}).order === 4);
  const support = supportKeys.length
    ? revenueMap.get(supportKeys[supportKeys.length - 1]) || zeros(n)
    : zeros(n);

  const metrics = avgHourMetrics({
    revenueSales,
    hours,
    marketing,
    support,
    cogs,
    cogsSales,
    otherCogs,
  });
  const hoursTotal = hours.reduce((s, v) => s + v, 0);
  const marketingTotal = marketing.reduce((s, v) => s + v, 0);
  const refBlock = {
    title: "Справочно",
    rows: [
      { name: "Количество закрытых часов", kind: "hours", values: hours.map(round1), total: round1(hoursTotal) },
      { name: "Из них маркетинга", kind: "hours", values: marketing.map(round1), total: round1(marketingTotal) },
      {
        name: "Средняя цена часа:",
        kind: "line",
        values: metrics.avgPrice.map(roundMoney),
        total: roundMoney(metrics.priceTotal),
      },
      {
        name: "Средняя себестоимость часа:",
        kind: "line",
        values: metrics.avgCost.map(roundMoney),
        total: roundMoney(metrics.costTotal),
      },
      {
        name: "Рентабельность часа:",
        kind: "line",
        values: metrics.hourRent.map(roundMoney),
        total: roundMoney(metrics.priceTotal - metrics.costTotal),
      },
      {
        name: "Доходность часа:",
        kind: "pct",
        values: metrics.hourYield.map(roundPct),
        total: metrics.priceTotal ? roundPct(((metrics.priceTotal - metrics.costTotal) / metrics.priceTotal) * 100) : 0,
      },
    ],
  };

  return {
    from: fromText,
    to: toText,
    organization: ORG_NAME,
    months: months.map((m) => ({ key: m.key, label: m.label })),
    sections: [salesBlock, cogsBlock, ...expenseBlocks, incomeBlock, refBlock],
    warnings: [...new Set(warnings.filter(Boolean))],
    generatedAt: new Date().toISOString(),
    note: "Считается как отчёт 1С «Доходы и расходы»: выручка и себестоимость — обороты регистра «Выручка и себестоимость продаж» (ОП/КО по «ОкончанияБонусовОП»), статьи — справочник «НастройкаДИР», расходы — «Прочие расходы» (на направления деятельности / не распределять), прочие доходы — регистр «Прочие доходы». Закрытые часы — количество с номенклатуры настройки порядка 1, не задачи разработчика.",
  };
}
