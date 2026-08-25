import { odataGet } from "./odata.mjs";
import {
  defaultPnlRange,
  normalizePnlGroup,
  periodColumns,
} from "./load-pnl.mjs";

const DB = "ecotidy";
const ORG_NAME = "ПЕРВЫЙ ИНТЕГРАТОР ООО";
const EMPTY = "00000000-0000-0000-0000-000000000000";
const PAGE = 200;

/** Варианты распределения, которые попадают в типовой отчёт ДИР. */
const ALLOWED_EXPENSE_VARIANTS = ["НаНаправленияДеятельности", "НеРаспределять"];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
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

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function eachDay(from, to) {
  const out = [];
  const cur = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (cur <= end) {
    out.push(ymd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function periodKeyOf(iso, group) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (group === "year") return String(d.getFullYear());
  if (group === "quarter") return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function periodIndex(columns, iso, group) {
  const key = periodKeyOf(iso, group);
  return columns.findIndex((col) => col.key === key);
}

function zeros(n) {
  return Array.from({ length: n }, () => 0);
}

function addInto(map, name, index, amount, len) {
  if (!amount) return;
  if (!map.has(name)) map.set(name, zeros(len));
  map.get(name)[index] += amount;
}

function sumVec(list, len) {
  const out = zeros(len);
  for (const vals of list) {
    for (let i = 0; i < len; i++) out[i] += vals[i] || 0;
  }
  return out;
}

function addVec(a, b) {
  return a.map((v, i) => v + (b[i] || 0));
}

function subVec(a, b) {
  return a.map((v, i) => v - (b[i] || 0));
}

function negVec(a) {
  return a.map((v) => -v);
}

function rowMoney(name, values, kind = "line") {
  const total = values.reduce((s, v) => s + v, 0);
  return { name, kind, values: values.map(roundMoney), total: roundMoney(total) };
}

function extractKey(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value.Ref_Key || value.Key || "").trim();
  const text = String(value);
  const guid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return guid ? guid[0] : text.trim();
}

function refKey(row, name) {
  return extractKey(row[`${name}_Key`]) || extractKey(row[name]);
}

function isEmptyGuid(id) {
  return !id || id === EMPTY;
}

function variantAllowed(value) {
  const text = String(value || "");
  if (!text) return true;
  return ALLOWED_EXPENSE_VARIANTS.some((name) => text.includes(name));
}

async function fetchAll(path) {
  const rows = [];
  for (let page = 0; page < 400; page++) {
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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
      while (index < items.length) {
        const i = index;
        index += 1;
        await worker(items[i], i);
      }
    })
  );
}

async function fetchByKeys(entity, keys, select) {
  const map = new Map();
  const list = [...new Set(keys.filter((k) => k && !isEmptyGuid(k)))];
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await fetchAll(`${entity}?$format=json&$filter=${filter}&$select=${select}`);
    for (const row of rows) map.set(row.Ref_Key, row);
  }
  return map;
}

async function resolveOrgKey() {
  const rows = await fetchAll("Catalog_Организации?$format=json&$select=Ref_Key,Description");
  const exact = rows.find((r) => String(r.Description || "").trim() === ORG_NAME);
  const fuzzy = rows.find((r) => /первый\s*интегратор/i.test(String(r.Description || "")));
  return (exact || fuzzy)?.Ref_Key || "";
}

function isCommissionOp(op) {
  const text = String(op || "");
  // Только явное комиссионное вознаграждение; «через комиссионера» и т.п. — в выручку.
  return /комиссионн(ое|ый).*вознагражд/i.test(text) || /^комиссионноевознаграждение$/i.test(text.replace(/\s+/g, ""));
}

/**
 * Типовой отчёт «Доходы и расходы предприятия» для базы ecotidy / ПЕРВЫЙ ИНТЕГРАТОР ООО.
 * Источники: ВыручкаИСебестоимостьПродаж, ПрочиеДоходы, ПрочиеРасходы.
 */
export async function loadPnlEcotidy(fromText, toText, groupBy = "month") {
  const from = parseDay(fromText);
  const to = parseDay(toText);
  if (!from || !to) throw new Error("Укажите период с и по");
  if (from > to) throw new Error("Дата «с» не может быть позже «по»");

  const group = normalizePnlGroup(groupBy);
  const months = periodColumns(fromText, toText, group);
  const n = months.length;
  const warnings = [];
  const days = eachDay(from, to);

  const orgKey = await resolveOrgKey();
  if (!orgKey) warnings.push("Не найдена организация «ПЕРВЫЙ ИНТЕГРАТОР ООО»");

  const salesSelect = [
    "Period",
    "Active",
    "АналитикаУчетаПоПартнерам_Key",
    "ХозяйственнаяОперация",
    "СуммаВыручки",
    "Стоимость",
    "ДопРасходы",
  ].join(",");

  const salesByDay = new Array(days.length);
  await mapPool(days, 4, async (day, idx) => {
    try {
      const filter = encodeURIComponent(
        `Period ge datetime'${day}T00:00:00' and Period le datetime'${day}T23:59:59' and Active eq true`
      );
      salesByDay[idx] = await fetchAll(
        `AccumulationRegister_ВыручкаИСебестоимостьПродаж_RecordType?$format=json&$filter=${filter}&$select=${salesSelect}`
      );
    } catch (err) {
      warnings.push(`Продажи ${day}: ${String(err.message || err).slice(0, 100)}`);
      salesByDay[idx] = [];
    }
  });

  const salesRows = salesByDay.flat().filter(Boolean);
  const partnerIds = salesRows.map((r) => r.АналитикаУчетаПоПартнерам_Key);
  const partnerMap = await fetchByKeys(
    "Catalog_КлючиАналитикиУчетаПоПартнерам",
    partnerIds,
    "Ref_Key,Организация_Key"
  );

  const revenue = zeros(n);
  const commission = zeros(n);
  const cogs = zeros(n);

  for (const row of salesRows) {
    if (orgKey) {
      const org = partnerMap.get(row.АналитикаУчетаПоПартнерам_Key)?.Организация_Key;
      if (org && org !== orgKey) continue;
    }
    const i = periodIndex(months, row.Period, group);
    if (i < 0) continue;
    const amount = num(row.СуммаВыручки);
    const cost = num(row.Стоимость) + num(row.ДопРасходы);
    if (isCommissionOp(row.ХозяйственнаяОперация)) commission[i] += amount;
    else revenue[i] += amount;
    cogs[i] += cost;
  }

  // Прочие расходы — по дням (месячный фильтр иногда тяжёлый)
  const expByDay = new Array(days.length);
  await mapPool(days, 4, async (day, idx) => {
    try {
      const filter = encodeURIComponent(
        `Period ge datetime'${day}T00:00:00' and Period le datetime'${day}T23:59:59' and Active eq true and RecordType eq 'Receipt'`
      );
      expByDay[idx] = await fetchAll(
        `AccumulationRegister_ПрочиеРасходы_RecordType?$format=json&$filter=${filter}&$select=Period,СтатьяРасходов_Key,Организация_Key,Сумма,СуммаУпр,СуммаРегл`
      );
    } catch (err) {
      warnings.push(`Расходы ${day}: ${String(err.message || err).slice(0, 100)}`);
      expByDay[idx] = [];
    }
  });
  const expenseRows = expByDay.flat().filter(Boolean);

  // Прочие доходы — без RecordType (оборотный регистр)
  const periodFilter = encodeURIComponent(
    `Period ge datetime'${odataDate(from)}' and Period le datetime'${odataDate(to, true)}' and Active eq true`
  );
  let incomeRows = [];
  try {
    incomeRows = await fetchAll(
      `AccumulationRegister_ПрочиеДоходы_RecordType?$format=json&$filter=${periodFilter}&$select=Period,СтатьяДоходов_Key,Организация_Key,Сумма,СуммаУпр,СуммаРегл`
    );
  } catch (err) {
    warnings.push(`Прочие доходы: ${String(err.message || err).slice(0, 160)}`);
  }

  const expenseArticles = await fetchByKeys(
    "ChartOfCharacteristicTypes_СтатьиРасходов",
    expenseRows.map((r) => r.СтатьяРасходов_Key),
    "Ref_Key,Description"
  );
  const incomeArticles = await fetchByKeys(
    "ChartOfCharacteristicTypes_СтатьиДоходов",
    incomeRows.map((r) => r.СтатьяДоходов_Key),
    "Ref_Key,Description"
  );

  const expenseMap = new Map();
  for (const row of expenseRows) {
    if (orgKey && row.Организация_Key && row.Организация_Key !== orgKey) continue;
    const article = expenseArticles.get(row.СтатьяРасходов_Key);
    const i = periodIndex(months, row.Period, group);
    if (i < 0) continue;
    const amount = num(row.Сумма) || num(row.СуммаУпр) || num(row.СуммаРегл);
    const name = String(article?.Description || "Без статьи").trim() || "Без статьи";
    addInto(expenseMap, name, i, amount, n);
  }

  const incomeMap = new Map();
  for (const row of incomeRows) {
    if (orgKey && row.Организация_Key && row.Организация_Key !== orgKey) continue;
    const i = periodIndex(months, row.Period, group);
    if (i < 0) continue;
    const amount = num(row.Сумма) || num(row.СуммаУпр) || num(row.СуммаРегл);
    const name = String(incomeArticles.get(row.СтатьяДоходов_Key)?.Description || "Без статьи").trim() || "Без статьи";
    addInto(incomeMap, name, i, amount, n);
  }

  const salesProfit = subVec(addVec(revenue, commission), cogs);
  const expenseVec = sumVec([...expenseMap.values()], n);
  const incomeVec = sumVec([...incomeMap.values()], n);
  // В отчёте 1С расходы выводятся со знаком «−»
  const expenseSigned = negVec(expenseVec);
  const net = addVec(addVec(salesProfit, incomeVec), expenseSigned);

  const salesRowsOut = [
    rowMoney("Выручка от продаж", revenue),
    ...(commission.some((v) => v) ? [rowMoney("Комиссионное вознаграждение", commission)] : []),
    rowMoney("Себестоимость продаж", negVec(cogs)),
    rowMoney("Продажи", salesProfit, "total"),
  ];

  const incomeLines = [...incomeMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ru"))
    .map(([name, values]) => rowMoney(name, values))
    .filter((r) => r.total !== 0 || r.values.some(Boolean));

  const expenseLines = [...expenseMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "ru"))
    .map(([name, values]) => rowMoney(name, negVec(values)))
    .filter((r) => r.total !== 0 || r.values.some(Boolean));

  return {
    from: fromText,
    to: toText,
    group,
    organization: ORG_NAME,
    source: "1С ecotidy",
    months: months.map((m) => ({ key: m.key, label: m.label })),
    sections: [
      {
        title: "Итого",
        rows: [rowMoney("руб.", net, "total")],
      },
      {
        title: "Продажи",
        rows: salesRowsOut,
      },
      {
        title: "Прочие доходы",
        rows: [...incomeLines, rowMoney("Прочие доходы", incomeVec, "total")],
      },
      {
        title: "Прочие расходы",
        rows: [...expenseLines, rowMoney("Прочие расходы", expenseSigned, "total")],
      },
      {
        title: "Результат",
        rows: [rowMoney("Итого", net, "total")],
      },
    ],
    totals: {
      revenue: roundMoney(revenue.reduce((s, v) => s + v, 0)),
      cogs: roundMoney(cogs.reduce((s, v) => s + v, 0)),
      sales: roundMoney(salesProfit.reduce((s, v) => s + v, 0)),
      otherIncome: roundMoney(incomeVec.reduce((s, v) => s + v, 0)),
      otherExpenses: roundMoney(expenseVec.reduce((s, v) => s + v, 0)),
      net: roundMoney(net.reduce((s, v) => s + v, 0)),
    },
    warnings: [...new Set(warnings.filter(Boolean))],
    generatedAt: new Date().toISOString(),
    note:
      "Типовой отчёт 1С «Доходы и расходы»: выручка и себестоимость — регистр «Выручка и себестоимость продаж»; " +
      "прочие доходы/расходы — соответствующие регистры по статьям. Организация — ПЕРВЫЙ ИНТЕГРАТОР ООО (ecotidy).",
  };
}

export { defaultPnlRange, normalizePnlGroup };
