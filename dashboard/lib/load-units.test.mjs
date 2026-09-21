import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyUnit,
  addUnits,
  mapNamedExpenses,
  expenseLinesFromSections,
  applyUkTransfers,
} from "./load-units.mjs";

const ROWS = [
  "Аренда офиса",
  "Налоги",
  "Выплата заработной платы (Коммер)",
  "Комиссия",
  "Прочие",
];

test("перенос в УК не меняет сумму юнитов", () => {
  const allsan = emptyUnit(ROWS);
  allsan.revenue = 1000000;
  allsan.cogs = 400000;
  allsan.expenseLines["Аренда офиса"] = 50000;
  allsan.expenseLines["Налоги"] = 100000;
  allsan.expenseLines["Выплата заработной платы (Коммер)"] = 400000;
  allsan.expenses = 550000;
  allsan.net = 50000;

  const ecotidy = emptyUnit(ROWS);
  ecotidy.revenue = 800000;
  ecotidy.cogs = 200000;
  ecotidy.expenseLines["Выплата заработной платы (Коммер)"] = 80000;
  ecotidy.expenseLines["Комиссия"] = 10000;
  ecotidy.expenses = 90000;
  ecotidy.net = 510000;

  const before = addUnits(allsan, ecotidy, ROWS);
  const pack = { allsan, ecotidy, uk: emptyUnit(ROWS) };
  applyUkTransfers(
    pack,
    [
      { name: "Юля ЗП", amount: 55000, fromUnit: "ecotidy", fromRow: "Выплата заработной платы (Коммер)", toRow: "Выплата заработной платы (Коммер)" },
      { name: "ЛСА ЗП", amount: 100000, fromUnit: "allsan", fromRow: "Выплата заработной платы (Коммер)", toRow: "Выплата заработной платы (Коммер)" },
      { name: "Аренда офиса УК", amount: 20000, fromUnit: "allsan", fromRow: "Аренда офиса", toRow: "Аренда офиса" },
      { name: "Налоги УК", amount: 82000, fromUnit: "allsan", fromRow: "Налоги", toRow: "Налоги" },
    ],
    ROWS
  );
  const after = addUnits(addUnits(pack.allsan, pack.ecotidy, ROWS), pack.uk, ROWS);
  assert.equal(after.revenue, before.revenue);
  assert.equal(after.cogs, before.cogs);
  assert.equal(after.expenses, before.expenses);
  assert.equal(after.net, before.net);
  assert.equal(pack.uk.expenseLines["Аренда офиса"], 20000);
  assert.equal(pack.uk.expenseLines["Налоги"], 82000);
  assert.equal(pack.uk.expenseLines["Выплата заработной платы (Коммер)"], 155000);
  assert.equal(pack.allsan.expenseLines["Выплата заработной платы (Коммер)"], 300000);
  assert.equal(pack.ecotidy.expenseLines["Выплата заработной платы (Коммер)"], 25000);
});

test("неперенесённый остаток статьи остаётся в юните", () => {
  const pack = {
    allsan: emptyUnit(ROWS),
    ecotidy: emptyUnit(ROWS),
    uk: emptyUnit(ROWS),
  };
  pack.allsan.expenseLines["Выплата заработной платы (Коммер)"] = 365000;
  applyUkTransfers(
    pack,
    [
      { name: "ЛСА ЗП", amount: 100000, fromUnit: "allsan", fromRow: "Выплата заработной платы (Коммер)", toRow: "Выплата заработной платы (Коммер)" },
      { name: "ПД", amount: 110000, fromUnit: "allsan", fromRow: "Выплата заработной платы (Коммер)", toRow: "Выплата заработной платы (Коммер)" },
      { name: "Виктория", amount: 45000, fromUnit: "allsan", fromRow: "Выплата заработной платы (Коммер)", toRow: "Выплата заработной платы (Коммер)" },
      { name: "Полина ЗП", amount: 110000, fromUnit: "allsan", fromRow: "Выплата заработной платы (Коммер)", toRow: "Выплата заработной платы (Коммер)" },
    ],
    ROWS
  );
  assert.equal(pack.allsan.expenseLines["Выплата заработной платы (Коммер)"], 0);
  assert.equal(pack.uk.expenseLines["Выплата заработной платы (Коммер)"], 365000);
});

test("статьи из «Себестоимость прочая» не попадают в расходы", () => {
  const lines = expenseLinesFromSections(
    [
      { title: "Себестоимость прочая", rows: [{ name: "Бонус отдела продаж", kind: "line", values: [100] }] },
      { title: "Коммерческие", rows: [{ name: "Аренда офиса", kind: "line", values: [20] }] },
    ],
    0
  );
  assert.equal(lines.get("Бонус отдела продаж"), undefined);
  assert.equal(lines.get("Аренда офиса"), 20);
});

test("несопоставленные статьи уходят в «Прочие»", () => {
  const source = new Map([
    ["Аренда офиса", 20],
    ["Ремонт склада", 7],
  ]);
  const { lines } = mapNamedExpenses(source, { "Аренда офиса": ["Аренда офиса"] }, ROWS);
  assert.equal(lines["Аренда офиса"], 20);
  assert.equal(lines["Прочие"], 7);
});
