import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPnl, defaultPnlRange, normalizePnlGroup, periodColumns } from "./load-pnl.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN_FILE = join(root, "budget", "budget-plan.json");

const SECTION_ORDER = [
  {
    title: "Продажи",
    kind: "revenue",
    names: [
      "Выручка от продаж разработки",
      "Выручка сервера",
      "Выручка коробки",
      "Выручка поддержка",
      "Выручка продукты",
    ],
  },
  {
    title: "Себестоимость",
    kind: "cogs",
    names: [
      "Себестоимость от продаж",
      "Себестоимость от продаж разработки",
      "Себестоимость коробки",
      "Себестоимость от продаж ОП",
    ],
  },
  {
    title: "Себестоимость прочая",
    kind: "expense",
    names: [
      "Простой",
      "Оплата попадосов",
      "Выплата заработной платы разработка",
      "Оплата аналитики",
      "Откат ментам",
      "Бонус отдела продаж",
    ],
  },
  {
    title: "Операционные расходы",
    kind: "expense",
    names: ["Выплата заработной платы(Операционные)"],
  },
  {
    title: "Коммерческие расходы",
    kind: "expense",
    names: ["Выплата заработной платы(Развитие)", "Маркетинг", "RND"],
  },
  {
    title: "Постоянные расходы",
    kind: "expense",
    names: [
      "Налоги",
      "Аренда серверов",
      "Транспорт",
      "Аренда офиса",
      "Связь",
      "Офис",
      "Выплата заработной платы(Коммерческие)",
      "Комисии",
      "Обучение",
      "Налоги ЗП",
    ],
  },
];

const FACT_ALIASES = {
  "выручка от продаж разработки": ["выручка от продаж"],
  "выручка продукты": ["выручка прочая выручка", "выручка продукты"],
  rnd: ["rnd", "r&d", "r and d"],
  "налоги зп": ["налоги зп", "налоги зп(стар)"],
  "себестоимость от продаж разработки": ["себестоимость от продаж разработки"],
  "себестоимость от продаж оп": ["себестоимость от продаж оп"],
};

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  return Math.round(num(value) * 100) / 100;
}

function roundPct(value) {
  return Math.round(num(value));
}

function zeros(n) {
  return Array.from({ length: n }, () => 0);
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

function normKey(name) {
  return String(name || "")
    .replace(/\(стар\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/ё/g, "е");
}

function stripOpKo(name) {
  return String(name || "")
    .replace(/\s+(ОП|КО)\s*$/i, "")
    .trim();
}

function loadPlanFile() {
  if (!existsSync(PLAN_FILE)) {
    throw new Error(`Нет файла плана ${PLAN_FILE}. Положите budget-plan.json в dashboard/budget.`);
  }
  return JSON.parse(readFileSync(PLAN_FILE, "utf8"));
}

function planVectors(plan, columns) {
  const map = new Map();
  for (const article of plan.articles || []) {
    const values = zeros(columns.length);
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      let sum = 0;
      for (const [monthKey, amount] of Object.entries(article.months || {})) {
        const [y, m] = monthKey.split("-").map(Number);
        if (!y || !m) continue;
        const month0 = m - 1;
        let key;
        if (col.key.includes("-Q")) key = `${y}-Q${Math.floor(month0 / 3) + 1}`;
        else if (/^\d{4}$/.test(col.key)) key = String(y);
        else key = monthKey;
        if (key === col.key) sum += num(amount);
      }
      values[i] = sum;
    }
    map.set(normKey(article.name), {
      name: article.name,
      codes: article.codes || [],
      values: values.map(roundMoney),
      total: roundMoney(values.reduce((s, v) => s + v, 0)),
    });
  }
  return map;
}

function collectFactMap(pnl) {
  const map = new Map();
  const add = (baseName, values) => {
    const key = normKey(baseName);
    if (!map.has(key)) map.set(key, zeros(values.length));
    const dest = map.get(key);
    for (let i = 0; i < values.length; i++) dest[i] += num(values[i]);
  };

  for (const section of pnl.sections || []) {
    if (section.title === "Справочно") continue;
    for (const row of section.rows || []) {
      if (row.kind && row.kind !== "line") continue;
      let name = String(row.name || "");
      if (/^выручка\s+/i.test(name) || /^себестоимость\s+/i.test(name)) {
        name = stripOpKo(name);
      }
      // PnL stores expenses as positive amounts; budget plan uses negative for costs.
      // Detect expense-like sections and flip sign to match plan convention.
      let values = row.values || [];
      const isExpenseSection = /расход|себестоимость прочая|прочий расход/i.test(section.title || "");
      const isCogsSection = /^себестоимость$/i.test(section.title || "");
      if (isExpenseSection || isCogsSection) {
        values = values.map((v) => -Math.abs(num(v)));
      }
      add(name, values);
    }
  }
  return map;
}

function factForPlanName(factMap, planName, len) {
  const key = normKey(planName);
  const aliases = FACT_ALIASES[key] || [key];
  const out = zeros(len);
  let found = false;
  for (const alias of aliases) {
    const hit = factMap.get(normKey(alias));
    if (!hit) continue;
    found = true;
    for (let i = 0; i < len; i++) out[i] += hit[i] || 0;
  }
  // also try exact key if aliases didn't include it
  if (!found && factMap.has(key)) {
    const hit = factMap.get(key);
    for (let i = 0; i < len; i++) out[i] += hit[i] || 0;
    found = true;
  }
  return { values: out.map(roundMoney), found };
}

function statusOf(plan, fact) {
  // Signed convention: revenue +, expenses -. Plan is met when fact >= plan.
  if (!plan && !fact) return "ok";
  return fact + 1e-6 >= plan ? "ok" : "bad";
}

function rowTriple(name, planValues, factValues, kind = "line") {
  const planTotal = roundMoney(planValues.reduce((s, v) => s + v, 0));
  const factTotal = roundMoney(factValues.reduce((s, v) => s + v, 0));
  const diffValues = subVec(factValues, planValues).map(roundMoney);
  const diffTotal = roundMoney(factTotal - planTotal);
  return {
    name,
    kind,
    plan: planValues.map(roundMoney),
    fact: factValues.map(roundMoney),
    diff: diffValues,
    planTotal,
    factTotal,
    diffTotal,
    status: statusOf(planTotal, factTotal),
    statuses: planValues.map((p, i) => statusOf(p, factValues[i] || 0)),
  };
}

function pctRow(name, profit, revenue) {
  const valuesPlan = profit.plan.map((p, i) => {
    const r = revenue.plan[i] || 0;
    return r ? roundPct((p / r) * 100) : 0;
  });
  const valuesFact = profit.fact.map((p, i) => {
    const r = revenue.fact[i] || 0;
    return r ? roundPct((p / r) * 100) : 0;
  });
  const planTotal = revenue.planTotal ? roundPct((profit.planTotal / revenue.planTotal) * 100) : 0;
  const factTotal = revenue.factTotal ? roundPct((profit.factTotal / revenue.factTotal) * 100) : 0;
  return {
    name,
    kind: "pct",
    plan: valuesPlan,
    fact: valuesFact,
    diff: valuesFact.map((v, i) => roundPct(v - valuesPlan[i])),
    planTotal,
    factTotal,
    diffTotal: roundPct(factTotal - planTotal),
    status: statusOf(planTotal, factTotal),
    statuses: valuesPlan.map((p, i) => statusOf(p, valuesFact[i] || 0)),
  };
}

export function defaultBudgetRange() {
  const plan = loadPlanFile();
  const year = Number(plan.year) || new Date().getFullYear();
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

export async function loadBudget(fromText, toText, groupBy = "month") {
  const group = normalizePnlGroup(groupBy);
  const planFile = loadPlanFile();
  const columns = periodColumns(fromText, toText, group);
  const n = columns.length;
  const planMap = planVectors(planFile, columns);

  const warnings = [];
  let pnl;
  try {
    // Fact always loaded by months then rolled into selected grouping via PnL itself.
    pnl = await loadPnl(fromText, toText, group);
  } catch (err) {
    warnings.push(`Факт из 1С: ${String(err.message || err).slice(0, 200)}`);
    pnl = { sections: [], months: columns, warnings: [] };
  }
  if (pnl.warnings?.length) warnings.push(...pnl.warnings);

  const factMap = collectFactMap(pnl);
  const unmatchedPlan = [];
  const sections = [];
  let profitPlan = zeros(n);
  let profitFact = zeros(n);
  let revenueRow = null;

  for (const section of SECTION_ORDER) {
    const rows = [];
    const planParts = [];
    const factParts = [];
    for (const name of section.names) {
      const plan = planMap.get(normKey(name)) || { name, values: zeros(n), total: 0 };
      const fact = factForPlanName(factMap, name, n);
      if (!fact.found && plan.total) unmatchedPlan.push(name);
      // For COGS/expenses in PnL we already flipped to negative. Revenue stays positive.
      // But wait - for cogs section, PnL cogs lines were flipped to negative. Good.
      // Revenue section: fact values are positive from PnL. Good.
      const row = rowTriple(name, plan.values, fact.values);
      rows.push(row);
      planParts.push(plan.values);
      factParts.push(fact.values);
    }
    if (!rows.some((r) => r.planTotal || r.factTotal)) continue;

    const planSum = sumVec(planParts, n);
    const factSum = sumVec(factParts, n);
    const totalRow = rowTriple(
      section.kind === "revenue" ? "Итого выручка:" : `Итого ${section.title}:`,
      planSum,
      factSum,
      "total"
    );
    rows.push(totalRow);

    if (section.kind === "revenue") {
      revenueRow = totalRow;
      profitPlan = planSum.slice();
      profitFact = factSum.slice();
    } else {
      // costs are negative in plan; subtracting negative increases profit. Use add of cost vectors.
      profitPlan = addVec(profitPlan, planSum);
      profitFact = addVec(profitFact, factSum);
      const profit = rowTriple("Итого прибыль:", profitPlan, profitFact, "total");
      rows.push(profit);
      if (revenueRow) rows.push(pctRow("Рентабельность:", profit, revenueRow));
    }

    sections.push({ title: section.title, kind: section.kind, rows });
  }

  if (unmatchedPlan.length) {
    warnings.push(`Нет факта в 1С для статей плана: ${unmatchedPlan.slice(0, 8).join(", ")}${unmatchedPlan.length > 8 ? "…" : ""}`);
  }

  return {
    from: fromText,
    to: toText,
    group,
    year: planFile.year,
    months: columns.map((c) => ({ key: c.key, label: c.label })),
    sections,
    warnings: [...new Set(warnings.filter(Boolean))],
    generatedAt: new Date().toISOString(),
    planSource: {
      file: "dashboard/budget/budget-plan.json",
      sheet: planFile.sheet,
      extractedAt: planFile.extractedAt,
    },
    note: "План — из Google Sheet (помесячный файл в проекте). Факт — из отчёта «Доходы и расходы» 1С. Отклонение = факт − план; зелёный если факт не хуже плана (с учётом знака: расходы отрицательные).",
  };
}

export { defaultPnlRange };
