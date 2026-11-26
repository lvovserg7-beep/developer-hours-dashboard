/**
 * Проверка расчёта доски «Расчёт поставки ВБ» на синтетических данных (формулы ТЗ).
 * Запуск: node scripts/test-wb-supply-calc.mjs
 */
import assert from "node:assert/strict";
import { addDays, calcWbSupply } from "../lib/wb-supply-calc.mjs";
import { clusterByOkrug, clusterByWarehouse } from "../lib/wb-supply-config.mjs";

const TODAY = "2026-11-25";
const LAST = addDays(TODAY, -1);
let seq = 0;

/** Сгенерировать заказы: n штук за период в округе. */
function orders(article, okrug, n, { days = 14, wt = "W", cancel = 0, offset = 0 } = {}) {
  const out = {};
  for (let i = 0; i < n; i++) {
    seq += 1;
    out[`s${seq}`] = {
      d: addDays(LAST, -((i % days) + offset)),
      a: article,
      n: 1,
      o: okrug,
      w: wt,
      x: cancel,
      l: "",
    };
  }
  return out;
}
const merge = (...parts) => Object.assign({}, ...parts);

const base = { depth: 14, horizon: 14, reservePct: 20, minDemand: 0.1 };
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok  ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}
const sku = (rep, article) => rep.skus.find((s) => s.article === article);
const row = (s, cluster) => s.rows.find((r) => r.cluster === cluster);

test("потребность без срока доставки: 18 заказов Сибирь → 22 шт., 22 заказа Центр → 27 шт.", () => {
  const data = {
    orders: merge(
      orders("m1", "Сибирский федеральный округ", 18),
      orders("m1", "Центральный федеральный округ", 22),
    ),
  };
  const rep = calcWbSupply(data, base, { today: TODAY });
  const s = sku(rep, "m1");
  const sib = row(s, "Сибирь и Дальний Восток");
  // 18/14 × 14 × 1,2 = 21,6 → 22 (срок кластера не учитывается)
  assert.equal(Math.round(sib.need * 100) / 100, 21.6);
  assert.equal(sib.toSupply, 22);
  // 22/14 × 14 × 1,2 = 26,4 → 27
  assert.equal(row(s, "Центр").toSupply, 27);
  assert.equal(s.toSupply, 49);
  assert.equal(rep.totals.toSupply, 49);
});

test("остаток на складах кластера уменьшает поставку", () => {
  const data = {
    orders: orders("m1", "Центральный федеральный округ", 22),
    remains: { m1: { nm: 1, wh: { Коледино: 10, "Екатеринбург - Испытателей 14г": 99 }, returns: 0, toCustomers: 0 } },
  };
  const rep = calcWbSupply(data, base, { today: TODAY });
  // need 26,4 − 10 = 16,4 → 17 (Екатеринбург относится к Уралу и не влияет на Центр)
  assert.equal(row(sku(rep, "m1"), "Центр").toSupply, 17);
});

test("товар в пути учитывается и отключается флагом", () => {
  const data = {
    orders: orders("m1", "Центральный федеральный округ", 22),
    supplies: [{ id: "1", status: 3, warehouse: "Тула", items: [{ a: "m1", q: 20, acc: 0 }] }],
  };
  assert.equal(row(sku(calcWbSupply(data, base, { today: TODAY }), "m1"), "Центр").toSupply, 7);
  assert.equal(row(sku(calcWbSupply(data, { ...base, useInTransit: false }, { today: TODAY }), "m1"), "Центр").toSupply, 27);
});

test("поставка в приёмке: вычитается уже принятое", () => {
  const data = {
    orders: orders("m1", "Центральный федеральный округ", 22),
    supplies: [{ id: "1", status: 4, warehouse: "Тула", items: [{ a: "m1", q: 20, acc: 15 }] }],
  };
  // в пути 5 → 26,4 − 5 = 21,4 → 22
  assert.equal(row(sku(calcWbSupply(data, base, { today: TODAY }), "m1"), "Центр").toSupply, 22);
});

test("возвраты распределяются пропорционально заказам и включаются флагом", () => {
  const data = {
    orders: merge(orders("m1", "Центральный федеральный округ", 20), orders("m1", "Уральский федеральный округ", 20)),
    remains: { m1: { nm: 1, wh: {}, returns: 10, toCustomers: 0 } },
  };
  const off = sku(calcWbSupply(data, base, { today: TODAY }), "m1");
  const on = sku(calcWbSupply(data, { ...base, useReturns: true }, { today: TODAY }), "m1");
  assert.equal(row(off, "Центр").returnsShare, 0);
  assert.equal(row(on, "Центр").returnsShare, 5);
  assert.ok(row(on, "Центр").toSupply < row(off, "Центр").toSupply);
});

test("отменённые заказы не считаются", () => {
  const data = {
    orders: merge(orders("m1", "Центральный федеральный округ", 14), orders("m1", "Центральный федеральный округ", 50, { cancel: 1 })),
  };
  const rep = calcWbSupply(data, base, { today: TODAY });
  assert.equal(sku(rep, "m1").orders, 14);
});

test("пустой округ → Центр, неизвестный → Центр с предупреждением", () => {
  assert.equal(clusterByOkrug("").cluster, "Центр");
  assert.equal(clusterByOkrug("Крымский федеральный округ").known, false);
  const data = { orders: merge(orders("m1", "", 14), orders("m1", "Какой-то округ", 14)) };
  const rep = calcWbSupply(data, base, { today: TODAY });
  assert.equal(row(sku(rep, "m1"), "Центр").orders, 28);
  assert.ok(rep.warnings.some((w) => w.includes("Какой-то округ")));
});

test("кратность и минимальная партия", () => {
  const data = { orders: orders("m1", "Центральный федеральный округ", 22) };
  const rep = calcWbSupply(
    data,
    { ...base, skuRules: { m1: { include: true, multiple: 10, minBatch: 0 } } },
    { today: TODAY },
  );
  assert.equal(row(sku(rep, "m1"), "Центр").toSupply, 30);
  const rep2 = calcWbSupply(
    data,
    { ...base, skuRules: { m1: { include: true, multiple: 1, minBatch: 100 } } },
    { today: TODAY },
  );
  assert.equal(row(sku(rep2, "m1"), "Центр").toSupply, 100);
});

test("исключённая позиция остаётся в списке, но поставка нулевая", () => {
  const data = { orders: orders("m1", "Центральный федеральный округ", 22) };
  const rep = calcWbSupply(data, { ...base, skuRules: { m1: { include: false } } }, { today: TODAY });
  assert.equal(sku(rep, "m1").toSupply, 0);
  assert.equal(rep.totals.toSupply, 0);
});

test("малый спрос ниже порога обнуляется", () => {
  const data = { orders: orders("m1", "Центральный федеральный округ", 1) };
  // 1/14 = 0,071 < 0,1
  assert.equal(sku(calcWbSupply(data, base, { today: TODAY }), "m1").toSupply, 0);
  assert.ok(sku(calcWbSupply(data, { ...base, minDemand: 0 }, { today: TODAY }), "m1").toSupply > 0);
});

test("высокий спрос: дни без заказов не разбавляют среднее", () => {
  // 45 заказов за 5 дней из 14 → среднее 3,2 ≥ 3 → делим на 5 дней = 9/день
  const data = { orders: orders("m1", "Центральный федеральный округ", 45, { days: 5 }) };
  const s = sku(calcWbSupply(data, base, { today: TODAY }), "m1");
  assert.equal(row(s, "Центр").demand, 9);
  const s2 = sku(calcWbSupply(data, { ...base, fullStockThreshold: 100 }, { today: TODAY }), "m1");
  assert.equal(Math.round(row(s2, "Центр").demand * 1000) / 1000, Math.round((45 / 14) * 1000) / 1000);
});

test("глубина просмотра ограничивает период; заказы вне периода не считаются", () => {
  const data = {
    orders: merge(
      orders("m1", "Центральный федеральный округ", 7, { days: 7 }),
      orders("m1", "Центральный федеральный округ", 30, { days: 5, offset: 10 }),
    ),
  };
  assert.equal(sku(calcWbSupply(data, { ...base, depth: 7 }, { today: TODAY }), "m1").orders, 7);
  assert.equal(sku(calcWbSupply(data, { ...base, depth: 20 }, { today: TODAY }), "m1").orders, 37);
});

test("горизонт и страховой запас меняют результат", () => {
  const data = { orders: orders("m1", "Центральный федеральный округ", 14) };
  const a = sku(calcWbSupply(data, { ...base, horizon: 14, reservePct: 0 }, { today: TODAY }), "m1");
  assert.equal(row(a, "Центр").toSupply, 14); // 1/день × 14 дней
  const b = sku(calcWbSupply(data, { ...base, horizon: 10, reservePct: 100 }, { today: TODAY }), "m1");
  assert.equal(row(b, "Центр").toSupply, 20); // 1 × 10 × 2
});

test("срок доставки кластера не влияет на расчёт", () => {
  const data = {
    orders: merge(
      orders("m1", "Центральный федеральный округ", 14),
      orders("m1", "Сибирский федеральный округ", 14),
    ),
  };
  const s = sku(calcWbSupply(data, { ...base, reservePct: 0 }, { today: TODAY }), "m1");
  assert.equal(row(s, "Центр").toSupply, 14);
  assert.equal(row(s, "Сибирь и Дальний Восток").toSupply, 14);
});
test("фильтры: категория (с потомками), список артикулов, поиск", () => {
  const data = {
    orders: merge(
      orders("m1", "Центральный федеральный округ", 14),
      orders("m2", "Центральный федеральный округ", 14),
      orders("k1", "Центральный федеральный округ", 14),
    ),
    titles: { m1: "Ментол 1", m2: "Ментол 2", k1: "Кислота" },
    catalog: {
      byArticle: { m1: { categoryKey: "c-child" }, m2: { categoryKey: "c-other" }, k1: { categoryKey: "c-acid" } },
      categories: [
        { key: "c-parent", name: "Ментолы", parentKey: "", isFolder: true },
        { key: "c-child", name: "Ментол кристаллы", parentKey: "c-parent", isFolder: false },
        { key: "c-other", name: "Прочее", parentKey: "", isFolder: false },
        { key: "c-acid", name: "Кислоты", parentKey: "", isFolder: false },
      ],
    },
  };
  const names = (p) => calcWbSupply(data, { ...base, ...p }, { today: TODAY }).skus.map((s) => s.article).sort();
  assert.deepEqual(names({}), ["k1", "m1", "m2"]);
  assert.deepEqual(names({ categories: ["c-parent"] }), ["m1"]);
  assert.deepEqual(names({ categories: ["c-parent"], articles: ["k1"] }), ["k1", "m1"]);
  assert.deepEqual(names({ articles: ["m2"] }), ["m2"]);
  assert.deepEqual(names({ query: "ментол" }), ["m1", "m2"]);
  assert.deepEqual(names({ categories: ["c-parent"], query: "ментол 2" }), []);
  assert.equal(sku(calcWbSupply(data, base, { today: TODAY }), "m1").category, "Ментол кристаллы");
});

test("склады: кластеры по ТЗ, СНГ и неизвестные", () => {
  assert.equal(clusterByWarehouse("Электросталь").cluster, "Центр");
  assert.equal(clusterByWarehouse("Склад WB РФ").cluster, "Центр");
  assert.equal(clusterByWarehouse("СПБ Шушары").cluster, "Северо-Запад");
  assert.equal(clusterByWarehouse("Самара (Новосемейкино)").cluster, "Приволжье");
  assert.equal(clusterByWarehouse("Екатеринбург - Перспективный 12/2").cluster, "Урал");
  assert.equal(clusterByWarehouse("Невинномысск").cluster, "Юг и Северный Кавказ");
  assert.equal(clusterByWarehouse("Хабаровск").cluster, "Сибирь и Дальний Восток");
  assert.equal(clusterByWarehouse("СЦ Ереван").kind, "cis");
  assert.equal(clusterByWarehouse("Неведомый склад").kind, "unknown");
  const data = {
    orders: orders("m1", "Центральный федеральный округ", 14),
    remains: { m1: { nm: 1, wh: { "СК Ташкент": 500, "Новый склад": 7 }, returns: 0, toCustomers: 0 } },
  };
  const rep = calcWbSupply(data, base, { today: TODAY });
  assert.ok(rep.warnings.some((w) => w.includes("Новый склад")));
  assert.equal(sku(rep, "m1").stock, 0);
});

test("покрытие и дата обнуления", () => {
  const data = {
    orders: orders("m1", "Центральный федеральный округ", 14),
    remains: { m1: { nm: 1, wh: { Тула: 2 }, returns: 0, toCustomers: 0 } },
  };
  const r = row(sku(calcWbSupply(data, base, { today: TODAY }), "m1"), "Центр");
  assert.equal(r.coverage, 2);
  assert.equal(r.zeroDate, addDays(TODAY, 2));
});

console.log(`\nПройдено: ${passed}`);
if (process.exitCode) console.error("Есть падения");
