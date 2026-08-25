import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPnl, defaultPnlRange, normalizePnlGroup } from "./load-pnl.mjs";
import { loadPnlEcotidy } from "./load-pnl-ecotidy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(root, "units", "units-config.json");

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`Нет файла настроек сводки: ${CONFIG_FILE}`);
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

function flatRows(sections) {
  const map = new Map();
  for (const section of sections || []) {
    for (const row of section.rows || []) {
      map.set(String(row.name || "").trim(), num(row.total));
    }
  }
  return map;
}

function sumNames(flat, names) {
  let s = 0;
  for (const name of names || []) {
    if (flat.has(name)) s += flat.get(name);
  }
  return s;
}

function findAmount(flat, aliases) {
  let s = 0;
  for (const name of aliases || []) {
    const want = String(name).toLowerCase();
    for (const [key, value] of flat.entries()) {
      if (key === name || key.toLowerCase() === want) s += value;
    }
  }
  return s;
}

/** Берём модуль суммы (в ДИР расходы часто отрицательные). */
function absFind(flat, aliases) {
  return Math.abs(findAmount(flat, aliases));
}

function monthKey(fromText) {
  const m = String(fromText || "").match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : "";
}

function emptyUnit() {
  return { revenue: 0, cogs: 0, expenses: 0, net: 0, expenseLines: {} };
}

function applyManualExpenses(unit, manual) {
  if (!manual || typeof manual !== "object") return;
  for (const [row, amount] of Object.entries(manual)) {
    unit.expenseLines[row] = roundMoney(num(unit.expenseLines[row]) + num(amount));
  }
}

function diffBlock(actual, expected) {
  if (!expected) return null;
  const keys = ["revenue", "cogs", "expenses", "net"];
  const out = {};
  for (const key of keys) {
    const a = roundMoney(actual?.[key]);
    const e = roundMoney(expected?.[key]);
    out[key] = { actual: a, expected: e, delta: roundMoney(a - e) };
  }
  return out;
}

/**
 * Сводка юнитов: Аллсан + Экотайди + УК.
 * УК — доли расходов, вынесенные из юнитов по units-config.json.
 */
export async function loadUnitsReport(fromText, toText) {
  const config = loadConfig();
  const warnings = [];
  const month = monthKey(fromText);
  if (monthKey(toText) !== month) {
    warnings.push("Сводка рассчитана по месяцу даты «с»; для нескольких месяцев выберите один месяц.");
  }

  const [alsn, eco] = await Promise.all([
    loadPnl(fromText, toText, "month"),
    loadPnlEcotidy(fromText, toText, "month"),
  ]);
  if (alsn.warnings?.length) warnings.push(...alsn.warnings.map((w) => `Аллсан: ${w}`));
  if (eco.warnings?.length) warnings.push(...eco.warnings.map((w) => `Экотайди: ${w}`));

  const alsnFlat = flatRows(alsn.sections);
  const ecoFlat = flatRows(eco.sections);
  const expenseRows = config.expenseRows || [];

  const allsan = emptyUnit();
  const ecotidy = emptyUnit();
  const uk = emptyUnit();

  // --- Аллсан ---
  allsan.revenue = roundMoney(sumNames(alsnFlat, config.allsan.revenue));
  let alsnCogs = sumNames(alsnFlat, config.allsan.cogs);
  for (const name of config.allsan.excludeFromCogs || []) {
    alsnCogs -= absFind(alsnFlat, [name]);
  }
  allsan.cogs = roundMoney(alsnCogs);

  for (const rowName of expenseRows) {
    const aliases = config.allsan.expenses?.[rowName];
    if (!aliases) {
      allsan.expenseLines[rowName] = 0;
      continue;
    }
    allsan.expenseLines[rowName] = roundMoney(absFind(alsnFlat, aliases));
  }

  // --- Экотайди ---
  const ecoRevenue = num(eco.totals?.revenue);
  let ecoOther = 0;
  for (const name of config.ecotidy.revenueOtherIncome || []) {
    ecoOther += absFind(ecoFlat, [name]);
  }
  ecotidy.revenue = roundMoney(ecoRevenue + ecoOther);
  ecotidy.cogs = roundMoney(Math.abs(num(eco.totals?.cogs)));

  for (const rowName of expenseRows) {
    const aliases = config.ecotidy.expenses?.[rowName];
    if (!aliases) {
      ecotidy.expenseLines[rowName] = 0;
      continue;
    }
    ecotidy.expenseLines[rowName] = roundMoney(absFind(ecoFlat, aliases));
  }

  // Ручные статьи (есть в sheet, нет в НастройкаДИР)
  const manuals = config.manualExpenseByMonth?.[month] || {};
  applyManualExpenses(allsan, manuals.allsan);
  applyManualExpenses(ecotidy, manuals.ecotidy);
  applyManualExpenses(uk, manuals.uk);

  // --- Вынос в УК ---
  const ukMoves = config.ukByMonth?.[month] || [];
  if (!ukMoves.length) {
    warnings.push(`Нет настроек УК для месяца ${month || "—"}. Заполните units/units-config.json → ukByMonth.`);
  }
  for (const move of ukMoves) {
    const unit = move.unit === "allsan" ? allsan : ecotidy;
    const row = move.row;
    const available = num(unit.expenseLines[row]);
    const take = move.amount === "all" ? available : Math.min(available, num(move.amount));
    unit.expenseLines[row] = roundMoney(available - take);
    uk.expenseLines[row] = roundMoney(num(uk.expenseLines[row]) + take);
  }

  const sumLines = (lines) => expenseRows.reduce((s, name) => s + num(lines[name]), 0);
  allsan.expenses = roundMoney(sumLines(allsan.expenseLines));
  ecotidy.expenses = roundMoney(sumLines(ecotidy.expenseLines));
  uk.expenses = roundMoney(sumLines(uk.expenseLines));

  allsan.net = roundMoney(allsan.revenue - allsan.cogs - allsan.expenses);
  ecotidy.net = roundMoney(ecotidy.revenue - ecotidy.cogs - ecotidy.expenses);
  uk.net = roundMoney(-uk.expenses);
  const total = {
    revenue: roundMoney(allsan.revenue + ecotidy.revenue + uk.revenue),
    cogs: roundMoney(allsan.cogs + ecotidy.cogs + uk.cogs),
    expenses: roundMoney(allsan.expenses + ecotidy.expenses + uk.expenses),
    net: roundMoney(allsan.net + ecotidy.net + uk.net),
    expenseLines: Object.fromEntries(
      expenseRows.map((name) => [
        name,
        roundMoney(
          num(allsan.expenseLines[name]) + num(ecotidy.expenseLines[name]) + num(uk.expenseLines[name])
        ),
      ])
    ),
  };

  const benchmark = config.benchmarkByMonth?.[month] || null;
  const compare = benchmark
    ? {
        source: benchmark.source || "",
        allsan: diffBlock(allsan, benchmark.allsan),
        ecotidy: diffBlock(ecotidy, benchmark.ecotidy),
        uk: diffBlock(uk, benchmark.uk),
        total: diffBlock(total, benchmark.total),
      }
    : null;

  if (compare) {
    const big = [];
    for (const [unit, block] of Object.entries(compare)) {
      if (unit === "source" || !block) continue;
      for (const [metric, cell] of Object.entries(block)) {
        if (Math.abs(num(cell.delta)) >= 1) {
          big.push(`${unit}.${metric}: Δ ${roundMoney(cell.delta)}`);
        }
      }
    }
    if (big.length) {
      warnings.push(`Сверка со sheet (${month}): есть расхождения — ${big.slice(0, 8).join("; ")}${big.length > 8 ? "…" : ""}`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    period: { from: fromText, to: toText, month },
    organizations: {
      allsan: alsn.organization || "Аллсан Интеграция",
      ecotidy: eco.organization || "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    },
    expenseRows,
    units: { allsan, ecotidy, uk, total },
    detail: config.ukDetailByMonth?.[month] || null,
    compare,
    warnings: [...new Set(warnings.filter(Boolean))],
    note:
      "Сводка юнитов: Аллсан (trade) + Экотайди/Первый интегратор (ecotidy). " +
      "УК — доли расходов, вынесенные из юнитов по units/units-config.json. " +
      "Итого юнита = выручка − себестоимость − расходы; УК в итоге отрицательная.",
    sources: {
      allsan: { from: alsn.from, to: alsn.to },
      ecotidy: { totals: eco.totals },
    },
  };
}

export function defaultUnitsRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const p = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { from: ymd(from), to: ymd(to) };
}

export { normalizePnlGroup, defaultPnlRange };
