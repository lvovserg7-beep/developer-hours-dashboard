import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPnl, defaultPnlRange, normalizePnlGroup, periodColumns } from "./load-pnl.mjs";
import { loadPnlEcotidy } from "./load-pnl-ecotidy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = join(root, "units", "units-config.json");
const SKIP_TITLES = new Set([
  "Продажи",
  "Себестоимость",
  "Себестоимость прочая",
  "Прочие доходы",
  "Справочно",
  "Итого",
  "Результат",
]);
const SKIP_NAME_RE = /^(итого|рентабельность|количество закрытых|из них маркетинга|средняя |доходность часа)/i;
const OTHER_ROW = "Прочие";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function roundMoney(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(`Нет файла настроек сводки: ${CONFIG_FILE}`);
  }
  return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
}

export function emptyUnit(expenseRows = []) {
  return {
    revenue: 0,
    cogs: 0,
    expenses: 0,
    net: 0,
    expenseLines: Object.fromEntries(expenseRows.map((name) => [name, 0])),
  };
}

export function addUnits(a, b, expenseRows) {
  const out = emptyUnit(expenseRows);
  out.revenue = roundMoney(num(a.revenue) + num(b.revenue));
  out.cogs = roundMoney(num(a.cogs) + num(b.cogs));
  out.expenses = roundMoney(num(a.expenses) + num(b.expenses));
  out.net = roundMoney(num(a.net) + num(b.net));
  for (const name of expenseRows) {
    out.expenseLines[name] = roundMoney(num(a.expenseLines?.[name]) + num(b.expenseLines?.[name]));
  }
  return out;
}

function cloneUnit(unit, expenseRows) {
  const out = emptyUnit(expenseRows);
  out.revenue = roundMoney(unit.revenue);
  out.cogs = roundMoney(unit.cogs);
  out.expenses = roundMoney(unit.expenses);
  out.net = roundMoney(unit.net);
  for (const name of expenseRows) {
    out.expenseLines[name] = roundMoney(unit.expenseLines?.[name]);
  }
  return out;
}

function finishUnit(unit, expenseRows) {
  unit.expenses = roundMoney(expenseRows.reduce((s, name) => s + num(unit.expenseLines[name]), 0));
  unit.net = roundMoney(unit.revenue - unit.cogs - unit.expenses);
  return unit;
}

function isSkipRow(row) {
  const name = String(row?.name || "").trim();
  if (!name) return true;
  if (row.kind === "total" || row.kind === "pct" || row.kind === "hours") return true;
  return SKIP_NAME_RE.test(name);
}

/** Суммы статей расхода из секций исходного ДИР за колонку месяца. */
export function expenseLinesFromSections(sections, index) {
  const map = new Map();
  for (const section of sections || []) {
    if (SKIP_TITLES.has(String(section.title || "").trim())) continue;
    for (const row of section.rows || []) {
      if (isSkipRow(row)) continue;
      const name = String(row.name || "").trim();
      const value = Math.abs(num(row.values?.[index] ?? row.total));
      if (!value) continue;
      map.set(name, roundMoney(num(map.get(name)) + value));
    }
  }
  return map;
}

export function mapNamedExpenses(sourceLines, mapping, expenseRows) {
  const used = new Set();
  const lines = Object.fromEntries(expenseRows.map((name) => [name, 0]));
  for (const rowName of expenseRows) {
    if (rowName === OTHER_ROW) continue;
    const aliases = mapping?.[rowName] || [];
    let sum = 0;
    for (const alias of aliases) {
      const want = String(alias).toLowerCase();
      for (const [key, value] of sourceLines.entries()) {
        if (key === alias || key.toLowerCase() === want) {
          sum += value;
          used.add(key);
        }
      }
    }
    lines[rowName] = roundMoney(sum);
  }
  let leftover = 0;
  for (const [key, value] of sourceLines.entries()) {
    if (!used.has(key)) leftover += value;
  }
  if (expenseRows.includes(OTHER_ROW)) lines[OTHER_ROW] = roundMoney(leftover);
  return { lines, leftover: roundMoney(leftover) };
}

function fitLinesToTotal(lines, expenseRows, total) {
  const mapped = expenseRows.filter((n) => n !== OTHER_ROW).reduce((s, n) => s + num(lines[n]), 0);
  if (expenseRows.includes(OTHER_ROW)) {
    lines[OTHER_ROW] = roundMoney(num(total) - mapped);
  }
  return lines;
}

export function applyUkTransfers(units, transfers, expenseRows) {
  const warnings = [];
  const applied = [];
  const uk = units.uk;
  for (const move of transfers || []) {
    const fromKey = move.fromUnit === "ecotidy" ? "ecotidy" : "allsan";
    const unit = units[fromKey];
    const fromRow = move.fromRow;
    const toRow = move.toRow || fromRow;
    if (!expenseRows.includes(fromRow) || !expenseRows.includes(toRow)) {
      warnings.push(`Перенос «${move.name}»: нет статьи «${fromRow}» / «${toRow}» в сводке.`);
      continue;
    }
    const want = roundMoney(num(move.amount));
    const available = roundMoney(num(unit.expenseLines[fromRow]));
    const take = roundMoney(Math.max(0, Math.min(available, want)));
    if (take + 0.005 < want) {
      warnings.push(
        `Перенос «${move.name}»: в «${fromRow}» ${fromKey} ${available} ₽, нужно ${want} ₽ — перенесено ${take} ₽.`
      );
    }
    unit.expenseLines[fromRow] = roundMoney(available - take);
    uk.expenseLines[toRow] = roundMoney(num(uk.expenseLines[toRow]) + take);
    applied.push({
      name: move.name,
      fromUnit: fromKey,
      fromRow,
      toRow,
      requested: want,
      taken: take,
    });
  }
  finishUnit(units.allsan, expenseRows);
  finishUnit(units.ecotidy, expenseRows);
  finishUnit(units.uk, expenseRows);
  units.uk.revenue = 0;
  units.uk.cogs = 0;
  units.uk.net = roundMoney(-units.uk.expenses);
  return { warnings, applied };
}

function monthSlice(totals, key) {
  return (totals?.byMonth || []).find((m) => m.key === key) || null;
}

export function buildAllsanMonth(alsn, monthKey, expenseRows, mapping) {
  const src = monthSlice(alsn.totals, monthKey);
  const index = (alsn.months || []).findIndex((m) => m.key === monthKey);
  const unit = emptyUnit(expenseRows);
  if (!src || index < 0) return { unit, source: emptyUnit(expenseRows) };
  unit.revenue = roundMoney(num(src.revenue) + num(src.otherIncome));
  unit.cogs = roundMoney(num(src.cogs) + num(src.otherCogs));
  const raw = expenseLinesFromSections(alsn.sections, index);
  const mapped = mapNamedExpenses(raw, mapping, expenseRows);
  unit.expenseLines = fitLinesToTotal(mapped.lines, expenseRows, num(src.expenses));
  finishUnit(unit, expenseRows);
  const source = cloneUnit(unit, expenseRows);
  return { unit, source };
}

export function buildEcotidyMonth(eco, monthKey, expenseRows, mapping) {
  const src = monthSlice(eco.totals, monthKey);
  const index = (eco.months || []).findIndex((m) => m.key === monthKey);
  const unit = emptyUnit(expenseRows);
  if (!src || index < 0) return { unit, source: emptyUnit(expenseRows) };
  unit.revenue = roundMoney(num(src.revenue) + num(src.otherIncome));
  unit.cogs = roundMoney(num(src.cogs));
  const raw = expenseLinesFromSections(eco.sections, index);
  const mapped = mapNamedExpenses(raw, mapping, expenseRows);
  mapped.lines["Комиссия"] = roundMoney(num(mapped.lines["Комиссия"]) + num(src.commission));
  const expenseTotal = roundMoney(num(src.otherExpenses) + num(src.commission));
  unit.expenseLines = fitLinesToTotal(mapped.lines, expenseRows, expenseTotal);
  finishUnit(unit, expenseRows);
  const source = cloneUnit(unit, expenseRows);
  return { unit, source };
}

function metricBlock(actual, expected) {
  const keys = ["revenue", "cogs", "expenses", "net"];
  const out = {};
  for (const key of keys) {
    const a = roundMoney(actual?.[key]);
    const e = roundMoney(expected?.[key]);
    out[key] = { actual: a, expected: e, delta: roundMoney(a - e) };
  }
  return out;
}

function emptyEcoReport(fromText, toText, months) {
  return {
    from: fromText,
    to: toText,
    organization: "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    months: months.map((m) => ({ key: m.key, label: m.label })),
    sections: [],
    totals: {
      revenue: 0,
      cogs: 0,
      commission: 0,
      otherIncome: 0,
      otherExpenses: 0,
      net: 0,
      byMonth: months.map((m) => ({
        key: m.key,
        label: m.label,
        revenue: 0,
        cogs: 0,
        commission: 0,
        otherIncome: 0,
        otherExpenses: 0,
        net: 0,
      })),
    },
    warnings: [],
  };
}

export function defaultUnitsRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const p = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { from: ymd(from), to: ymd(to) };
}

/**
 * Сводка юнитов = ДИР Аллсан + ДИР Первый интегратор, затем перенос долей в УК.
 * Итог сводки обязан совпасть с суммой исходных отчётов.
 */
export async function loadUnitsReport(fromText, toText) {
  const config = loadConfig();
  const warnings = [];
  const expenseRows = config.expenseRows || [];
  if (!expenseRows.includes(OTHER_ROW)) expenseRows.push(OTHER_ROW);

  const months = periodColumns(fromText, toText, "month");
  const alsn = await loadPnl(fromText, toText, "month");
  let eco;
  try {
    eco = await loadPnlEcotidy(fromText, toText, "month");
  } catch (err) {
    warnings.push("Экотайди: нет доступа к 1С. Проверьте ODATA_DB_ECOTIDY_USERNAME и ODATA_DB_ECOTIDY_PASSWORD в dashboard/.env");
    eco = emptyEcoReport(fromText, toText, months);
  }
  if (alsn.warnings?.length) warnings.push(...alsn.warnings.map((w) => `Аллсан: ${w}`));
  if (eco.warnings?.length) warnings.push(...eco.warnings.map((w) => `Экотайди: ${w}`));

  let allsan = emptyUnit(expenseRows);
  let ecotidy = emptyUnit(expenseRows);
  let uk = emptyUnit(expenseRows);
  let sourceAllsan = emptyUnit(expenseRows);
  let sourceEcotidy = emptyUnit(expenseRows);
  const appliedAll = [];
  const byMonth = [];

  for (const month of months) {
    const alsnBuilt = buildAllsanMonth(alsn, month.key, expenseRows, config.allsan?.expenses);
    const ecoBuilt = buildEcotidyMonth(eco, month.key, expenseRows, config.ecotidy?.expenses);
    const pack = {
      allsan: alsnBuilt.unit,
      ecotidy: ecoBuilt.unit,
      uk: emptyUnit(expenseRows),
    };
    const moved = applyUkTransfers(pack, config.ukTransfers, expenseRows);
    warnings.push(...moved.warnings.map((w) => `${month.label}: ${w}`));
    appliedAll.push(...moved.applied.map((row) => ({ ...row, month: month.key })));
    allsan = addUnits(allsan, pack.allsan, expenseRows);
    ecotidy = addUnits(ecotidy, pack.ecotidy, expenseRows);
    uk = addUnits(uk, pack.uk, expenseRows);
    sourceAllsan = addUnits(sourceAllsan, alsnBuilt.source, expenseRows);
    sourceEcotidy = addUnits(sourceEcotidy, ecoBuilt.source, expenseRows);
    byMonth.push({
      key: month.key,
      label: month.label,
      units: { allsan: pack.allsan, ecotidy: pack.ecotidy, uk: pack.uk },
      source: { allsan: alsnBuilt.source, ecotidy: ecoBuilt.source },
    });
  }

  const total = addUnits(addUnits(allsan, ecotidy, expenseRows), uk, expenseRows);
  const sourceCombined = addUnits(sourceAllsan, sourceEcotidy, expenseRows);
  const identity = metricBlock(total, sourceCombined);
  const gaps = Object.entries(identity)
    .filter(([, cell]) => Math.abs(num(cell.delta)) >= 0.05)
    .map(([key, cell]) => `${key}: Δ ${cell.delta}`);
  if (gaps.length) {
    warnings.push(`Итог сводки не бьётся с суммой исходных ДИР: ${gaps.join("; ")}`);
  }

  const monthCount = months.length || 1;
  const detail = {
    ук: (config.ukTransfers || []).map((move) => {
      const taken = appliedAll
        .filter((row) => row.name === move.name)
        .reduce((s, row) => s + num(row.taken), 0);
      return { name: move.name, amount: roundMoney(taken), monthly: num(move.amount), months: monthCount };
    }),
  };

  return {
    generatedAt: new Date().toISOString(),
    period: { from: fromText, to: toText, months: months.map((m) => m.key) },
    organizations: {
      allsan: alsn.organization || "Аллсан Интеграция",
      ecotidy: eco.organization || "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    },
    expenseRows,
    units: { allsan, ecotidy, uk, total },
    source: { allsan: sourceAllsan, ecotidy: sourceEcotidy, combined: sourceCombined },
    identity,
    byMonth,
    detail,
    transfers: appliedAll,
    compare: {
      source: "Сверка: итог сводки минус сумма ДИР Аллсан и ДИР Первый интегратор",
      total: identity,
    },
    warnings: [...new Set(warnings.filter(Boolean))],
    note:
      "Сводка юнитов берёт цифры из отчётов «Доходы и расходы» (Аллсан / trade) и «ДИР Первый интегратор» (ecotidy). " +
      "Выручка юнита = продажи + прочие доходы; себестоимость Аллсан включает «Себестоимость прочая»; " +
      "комиссия Первого интегратора из ресурса «Расходы на продажу» входит в расходы. " +
      "Затем из юнитов в УК переносятся фиксированные доли (зарплаты, аренда, налоги) — каждый месяц периода. " +
      "Итого сводки = сумма исходных отчётов.",
    sources: {
      allsan: { from: alsn.from, to: alsn.to, totals: alsn.totals },
      ecotidy: { from: eco.from, to: eco.to, totals: eco.totals },
    },
  };
}

export { normalizePnlGroup, defaultPnlRange, periodColumns };
