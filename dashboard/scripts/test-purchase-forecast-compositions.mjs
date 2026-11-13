/**
 * 15 сценариев разных составов номенклатуры:
 * доска loadPurchaseForecast vs независимый пересчёт OData
 * (остатки по Condition на каждую позицию, не через общий Balance map).
 * Формулы — как Alsn_ТекстыЗапросовУТ: Макет1 + Макет2.
 */
import { loadPurchaseForecast } from "../lib/load-purchase-forecast.mjs";
import { odataAllPages } from "../lib/odata.mjs";

const DATABASE = "ecotidy";
const HORIZON = 10;
const EMPTY = "00000000-0000-0000-0000-000000000000";

const A = {
  wipe20: "salf_monik_golub_20sht",
  gips: "naborgips",
  mistLife: "aromo_mist_LifeEmirates",
  mistChance: "aromo_mist_Chance",
  avto: "avtoparf_afgano8",
  baraban: "him_barabanstiral_180",
  mentol: "mentol_banya_50",
};

/** @type {Array<{id:number,name:string,items:Array<{article:string,dailyRate:number}>,orders?:Record<string,number>}>} */
const COMPOSITIONS = [
  { id: 1, name: "Только салфетки 20", items: [{ article: A.wipe20, dailyRate: 3 }] },
  { id: 2, name: "Только набор гипс", items: [{ article: A.gips, dailyRate: 2 }] },
  { id: 3, name: "Только мист Life", items: [{ article: A.mistLife, dailyRate: 5 }] },
  { id: 4, name: "Только мист Chance", items: [{ article: A.mistChance, dailyRate: 4 }] },
  { id: 5, name: "Только автопарфюм", items: [{ article: A.avto, dailyRate: 1 }] },
  { id: 6, name: "Только барабан 180", items: [{ article: A.baraban, dailyRate: 7 }] },
  { id: 7, name: "Только ментол", items: [{ article: A.mentol, dailyRate: 6 }] },
  {
    id: 8,
    name: "Оба миста",
    items: [
      { article: A.mistLife, dailyRate: 5 },
      { article: A.mistChance, dailyRate: 4 },
    ],
  },
  {
    id: 9,
    name: "Салфетки + гипс",
    items: [
      { article: A.wipe20, dailyRate: 3 },
      { article: A.gips, dailyRate: 2 },
    ],
  },
  {
    id: 10,
    name: "Барабан + ментол",
    items: [
      { article: A.baraban, dailyRate: 7 },
      { article: A.mentol, dailyRate: 6 },
    ],
  },
  {
    id: 11,
    name: "Гипс + авто + ментол",
    items: [
      { article: A.gips, dailyRate: 2 },
      { article: A.avto, dailyRate: 1 },
      { article: A.mentol, dailyRate: 6 },
    ],
  },
  {
    id: 12,
    name: "Все семь (как на скрине)",
    items: [
      { article: A.wipe20, dailyRate: 3 },
      { article: A.gips, dailyRate: 2 },
      { article: A.mistLife, dailyRate: 5 },
      { article: A.mistChance, dailyRate: 4 },
      { article: A.avto, dailyRate: 1 },
      { article: A.baraban, dailyRate: 7 },
      { article: A.mentol, dailyRate: 6 },
    ],
  },
  {
    id: 13,
    name: "Нулевые расходы",
    items: [
      { article: A.wipe20, dailyRate: 0 },
      { article: A.baraban, dailyRate: 0 },
    ],
  },
  { id: 14, name: "Большой расход салфеток", items: [{ article: A.wipe20, dailyRate: 50 }] },
  {
    id: 15,
    name: "Мисты + ручной заказ комплектующего",
    items: [
      { article: A.mistLife, dailyRate: 1 },
      { article: A.mistChance, dailyRate: 1 },
    ],
    orders: { "флакон_50мл": 100 },
  },
];

function near(a, b, eps = 0.02) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}
function round4(n) {
  return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
}

async function resolveArticle(article) {
  const filter = `Артикул eq '${article.replace(/'/g, "''")}' and DeletionMark eq false and IsFolder eq false`;
  const rows = await odataAllPages(
    `Catalog_Номенклатура?$format=json&$filter=${filter}&$select=Ref_Key,Description,Артикул&$top=3`,
    { database: DATABASE, maxPages: 1 }
  );
  return rows[0] || null;
}

async function balanceField(register, field, ref) {
  const rows = await odataAllPages(
    `${register}/Balance(Condition='Номенклатура_Key eq guid''${ref}''')?$format=json&$top=200`,
    { database: DATABASE, maxPages: 5 }
  );
  return rows.reduce((s, r) => s + Number(r[field] || 0), 0);
}

async function kitLines(ownerRef) {
  const variants = await odataAllPages(
    `Catalog_ВариантыКомплектацииНоменклатуры?$format=json&$filter=Owner_Key eq guid'${ownerRef}' and Основной eq true and DeletionMark eq false&$select=Ref_Key&$top=3`,
    { database: DATABASE, maxPages: 1 }
  );
  if (!variants.length) return [];
  const goods = await odataAllPages(
    `Catalog_ВариантыКомплектацииНоменклатуры_Товары?$format=json&$filter=Ref_Key eq guid'${variants[0].Ref_Key}'&$select=Номенклатура_Key,Количество&$top=200`,
    { database: DATABASE, maxPages: 2 }
  );
  return goods
    .filter((g) => g.Номенклатура_Key && g.Номенклатура_Key !== EMPTY)
    .map((g) => ({ ref: g.Номенклатура_Key, qty: Number(g.Количество) || 0 }));
}

async function independentCalc(items, horizon, orders = {}) {
  const products = [];
  const componentAgg = new Map();

  for (const item of items) {
    const nom = await resolveArticle(item.article);
    if (!nom) throw new Error(`Нет артикула ${item.article}`);
    const stock = await balanceField("AccumulationRegister_ТоварыНаСкладах", "ВНаличииBalance", nom.Ref_Key);
    const required = round2(item.dailyRate * horizon);
    const qtyForCalc = round2(required - stock); // Макет1: Заказано = 0
    products.push({
      article: item.article,
      ref: nom.Ref_Key,
      dailyRate: round2(item.dailyRate),
      required,
      stock: round2(stock),
      qtyForCalc,
    });
    for (const line of await kitLines(nom.Ref_Key)) {
      const cur = componentAgg.get(line.ref) || { need: 0, daily: 0 };
      cur.need += qtyForCalc * line.qty;
      cur.daily = Math.max(cur.daily, item.dailyRate * line.qty);
      componentAgg.set(line.ref, cur);
    }
  }

  const components = [];
  for (const [ref, agg] of componentAgg) {
    const nom = await odataAllPages(
      `Catalog_Номенклатура?$format=json&$filter=Ref_Key eq guid'${ref}'&$select=Ref_Key,Артикул&$top=1`,
      { database: DATABASE, maxPages: 1 }
    );
    const article = String(nom[0]?.Артикул || "").trim();
    const stock = await balanceField("AccumulationRegister_ТоварыНаСкладах", "ВНаличииBalance", ref);
    const ordered = await balanceField("AccumulationRegister_ЗаказыПоставщикам", "ЗаказаноBalance", ref);
    const inOrder = Number(orders[article] ?? orders[ref] ?? 0) || 0;
    const need = round4(agg.need);
    const daily = round4(agg.daily);
    const days = daily === 0 ? 0 : Math.round(stock / daily);
    const toOrder = round4(need - ordered - stock - inOrder);
    components.push({
      ref,
      article,
      need,
      stock: round4(stock),
      ordered: round4(ordered),
      inOrder: round4(inOrder),
      days,
      toOrder,
    });
  }
  return { products, components };
}

function compareCase(board, indep) {
  const errors = [];
  if (board.products.length !== indep.products.length) {
    errors.push(`изделий: board=${board.products.length} indep=${indep.products.length}`);
  }
  for (const p of indep.products) {
    const b = board.products.find((x) => x.article === p.article || x.ref === p.ref);
    if (!b) {
      errors.push(`нет изделия ${p.article}`);
      continue;
    }
    for (const key of ["dailyRate", "required", "stock", "qtyForCalc"]) {
      if (!near(b[key], p[key])) errors.push(`${p.article}.${key}: board=${b[key]} indep=${p[key]}`);
    }
  }
  const boardByRef = new Map(board.components.map((c) => [c.ref, c]));
  if (board.components.length !== indep.components.length) {
    errors.push(`комплектующих: board=${board.components.length} indep=${indep.components.length}`);
  }
  for (const c of indep.components) {
    const b = boardByRef.get(c.ref);
    if (!b) {
      errors.push(`нет комплектующего ${c.article || c.ref}`);
      continue;
    }
    for (const key of ["need", "stock", "ordered", "inOrder", "days", "toOrder"]) {
      const eps = key === "days" ? 0.51 : 0.02;
      if (!near(b[key], c[key], eps)) {
        errors.push(`comp ${c.article || c.ref}.${key}: board=${b[key]} indep=${c[key]}`);
      }
    }
  }
  return errors;
}

const results = [];
for (const scenario of COMPOSITIONS) {
  process.stdout.write(`#${scenario.id} ${scenario.name}... `);
  try {
    const orders = scenario.orders || {};
    const board = await loadPurchaseForecast({
      userId: "test-compositions",
      horizon: HORIZON,
      items: scenario.items,
      orders,
      persist: false,
    });
    const indep = await independentCalc(scenario.items, HORIZON, orders);
    // Для сценария 15: если артикула заказа нет среди комплектующих — подставим первый компонент
    if (scenario.id === 15 && indep.components.length && Object.keys(orders).length) {
      const firstArt = indep.components[0].article;
      if (firstArt && !(firstArt in orders)) {
        const patchedOrders = { [firstArt]: 100 };
        const board2 = await loadPurchaseForecast({
          userId: "test-compositions",
          horizon: HORIZON,
          items: scenario.items,
          orders: patchedOrders,
          persist: false,
        });
        const indep2 = await independentCalc(scenario.items, HORIZON, patchedOrders);
        const errors = compareCase(board2, indep2);
        const ok = errors.length === 0;
        results.push({
          id: scenario.id,
          name: scenario.name + ` (заказ ${firstArt}=100)`,
          ok,
          products: board2.products.length,
          components: board2.components.length,
          errors: errors.slice(0, 8),
        });
        console.log(ok ? "OK" : `FAIL (${errors.length})`);
        continue;
      }
    }
    const errors = compareCase(board, indep);
    const ok = errors.length === 0;
    results.push({
      id: scenario.id,
      name: scenario.name,
      ok,
      products: board.products.length,
      components: board.components.length,
      warnings: board.warnings || [],
      errors: errors.slice(0, 8),
    });
    console.log(ok ? `OK (p=${board.products.length} c=${board.components.length})` : `FAIL (${errors.length})`);
  } catch (err) {
    results.push({ id: scenario.id, name: scenario.name, ok: false, errors: [String(err.message || err)] });
    console.log("ERROR", err.message || err);
  }
}

const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
process.exit(passed === results.length ? 0 : 1);
