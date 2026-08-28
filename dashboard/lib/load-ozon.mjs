import { odataGet } from "./odata.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB = "ecotidy";
const PAGE = 400;
const EMPTY = "00000000-0000-0000-0000-000000000000";
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Документные операции → поля отчёта (без рекламы/premium — они из регистров). */
const DOC_OP_MAP = {
  "Оплата эквайринга": "acquiring",
  "Доставка и обработка возврата, отмены, невыкупа": "deliveryReturn",
  "Кросс-докинг": "crossDock",
  "Услуга размещения товаров на складе": "storageServices",
  "Доставка покупателю — отмена начисления": "deliveryCancel",
  "Утилизация": "otherFulfillment",
  "Перечисление за доставку от покупателя": "deliveryBias",
  "Возврат перечисления за доставку": "deliveryBias",
  "Услуги доставки Партнерами Ozon на схеме realFBS": "deliveryRfbs",
  "Агентское вознаграждение за доставку Партнерами Oz": "deliveryRfbs",
  "Обработка товара в составе грузоместа на FBO": "storageOps",
  "Начисления по операциям на складе": "storageOps",
};

/**
 * Поля отчёта в порядке колонок 1С «Расчёт себестоимости».
 * adOrder = Реклама заказ; deliveryCancel = Доставка покупателю отмена начисления;
 * decompensation = Декомпенсация за возвращение на сток.
 */
const MONEY_FIELDS = [
  "sale",
  "returns",
  "cost",
  "commission",
  "acquiring",
  "deliveryOzon",
  "deliveryReturn",
  "crossDock",
  "deliveryCancel",
  "deliveryRfbs",
  "deliveryBias",
  "deliveryKgt",
  "storageOps",
  "storageServices",
  "otherFulfillment",
  "adStencil",
  "adSearch",
  "adOrder",
  "premium",
  "tax",
  "decompensation",
  "compShortage",
  "compLoss",
];

const SERVICE_MAP = {
  Эквайринг: "acquiring",
  ПолучениеВозвратаОтменыНевыкупаОтПокупателя: "returnsReg",
  ДоставкаИОбработкаВозвратаОтменыНевыкупа: "deliveryReturn",
  ДоставкаRFBS: "deliveryRfbs",
  ДоставкаТоваровНаСкладOzonКроссДокинг: "crossDock",
  ПеречислениеЗаДоставкуОтПокупателя: "deliveryBias",
  ВозвратПеречисленияЗаДоставкуПокупателю: "deliveryBias",
  КомпенсацияПеречисленияЗаДоставку: "deliveryBias",
  ДоставкаПокупателюОтменаНачисления: "deliveryCancel",
  ДоставкаКГТ: "deliveryKgt",
  НачисленияПоОперациямНаСкладеОзон: "storageOps",
  УслугаРазмещенияТоваровНаСкладе: "storageServices",
  КраткосрочноеРазмещениеВозвратаFBS: "storageServices",
  ДолгосрочноеРазмещениеВозвратаFBS: "storageServices",
  УдержаниеЗаНедовложениеТовара: "storageOps",
  ПодпискаPremium: "premium",
  ДекомпенсацияЗаВозвращениеНаСток: "decompensation",
  КомпенсацияЗаУтерюТовара: "compLoss",
  КомпенсацияЗаУтерянныйНаСкладеТовар: "compLoss",
  КомпенсацияЗаПовреждённыйНаСкладеТовар: "compShortage",
  НачислениеПоПретензии: "compShortage",
  Прочее: "otherFulfillment",
  Неопределено: "otherFulfillment",
  УтилизацияТовара: "otherFulfillment",
  БаллыЗаОтзывы: "otherFulfillment",
  ПриобретениеОтзывовНаПлатформе: "otherFulfillment",
  УслугаБрендоваяПолка: "otherFulfillment",
  УслугаПродвиженияБонусыПродавца: "otherFulfillment",
  ЗвездныеТовары: "otherFulfillment",
  ЛогистикаВРЦ: "otherFulfillment",
  УслугаDropOffВПунктеПриёмаЗаказов: "otherFulfillment",
  ПеревыставлениеВозвратовНаПунктеВыдачи: "otherFulfillment",
  ВзаимозачётСДругимиДоговорамиКонтрагента: "otherFulfillment",
  ИнвентаризацияВзаиморасчетов: "otherFulfillment",
  ПрочиеКомпенсации: "otherFulfillment",
};

const AD_MAP = {
  Трафареты: "adStencil",
  ПродвижениеВПоиске: "adSearch",
  НачисленияПоЗаказуВсеТовары: "adOrder",
};

/** Операции продаж/возвратов в Alsn_Начисления (как в отчёте 1С). */
const SALE_OPS = new Set([
  "Доставка покупателю",
  "Получение возврата, отмены, невыкупа от покупателя",
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

function emptyMetrics() {
  const m = { qty: 0 };
  for (const f of MONEY_FIELDS) m[f] = 0;
  m.returnsReg = 0;
  m.undistributed = 0;
  return m;
}

function addMetrics(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    target[k] = (target[k] || 0) + num(v);
  }
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

export function defaultOzonRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: ymd(from), to: ymd(to) };
}

function resolveRange(fromRaw, toRaw) {
  const from = parseYmd(fromRaw) || parseYmd(defaultOzonRange().from);
  const to = parseYmd(toRaw) || parseYmd(defaultOzonRange().to);
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
    let chunk = [];
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await odataGet(`${path}${sep}$top=${PAGE}&$skip=${page * PAGE}`, DB);
        chunk = data.value || [];
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
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

function textIncludes(hay, needle) {
  return String(hay || "").toLowerCase().includes(String(needle || "").toLowerCase());
}

function mapServiceField(vid) {
  const key = enumTail(vid);
  if (SERVICE_MAP[key]) return SERVICE_MAP[key];
  for (const [name, field] of Object.entries(SERVICE_MAP)) {
    if (key.includes(name) || textIncludes(vid, name)) return field;
  }
  return "otherFulfillment";
}

function mapAdField(vid) {
  const key = enumTail(vid);
  if (AD_MAP[key]) return AD_MAP[key];
  if (/трафарет/i.test(key)) return "adStencil";
  if (/поиск/i.test(key)) return "adSearch";
  if (/заказ/i.test(key)) return "adOrder";
  return "otherFulfillment";
}

function finishMetrics(m, taxRate) {
  const sale = m.sale;
  const returns = m.returns + m.returnsReg;
  const cost = m.cost;
  const marketing = m.adStencil + m.adSearch + m.adOrder + m.premium;
  const delivery =
    m.deliveryOzon +
    m.deliveryReturn +
    m.deliveryRfbs +
    m.crossDock +
    m.deliveryBias +
    m.deliveryCancel +
    m.deliveryKgt;
  const storage = m.storageOps + m.storageServices;
  const other = m.otherFulfillment + m.compShortage + m.compLoss + m.decompensation;
  const expenses =
    cost + m.commission + m.acquiring + delivery + storage + other + marketing + m.tax;
  // Как в СКД: выручка − расходы − (−возвраты). Для «Не распределено» добавляем
  // ПрибыльНераспределенныеРасходы (add-back), валовая = прибыль − эти расходы.
  const u = num(m.undistributed);
  let margin = sale - expenses - -returns;
  if (u) margin += u;
  const gross = margin - u;
  const marginPct = sale ? (margin / sale) * 100 : 0;
  const grossPct = sale ? (gross / sale) * 100 : 0;
  const roi = cost ? (gross / cost) * 100 : 0;
  const costPerUnit = m.qty ? cost / m.qty : 0;
  return {
    qty: round2(m.qty),
    sale: round2(sale),
    returns: round2(returns),
    cost: round2(cost),
    costPerUnit: round2(costPerUnit),
    commission: round2(m.commission),
    acquiring: round2(m.acquiring),
    deliveryOzon: round2(m.deliveryOzon),
    deliveryReturn: round2(m.deliveryReturn),
    deliveryRfbs: round2(m.deliveryRfbs),
    crossDock: round2(m.crossDock),
    deliveryBias: round2(m.deliveryBias),
    deliveryCancel: round2(m.deliveryCancel),
    deliveryKgt: round2(m.deliveryKgt),
    storageOps: round2(m.storageOps),
    storageServices: round2(m.storageServices),
    otherFulfillment: round2(m.otherFulfillment),
    adStencil: round2(m.adStencil),
    adSearch: round2(m.adSearch),
    adOrder: round2(m.adOrder),
    premium: round2(m.premium),
    tax: round2(m.tax || sale * (taxRate / 100)),
    taxRate,
    decompensation: round2(m.decompensation),
    compShortage: round2(m.compShortage),
    compLoss: round2(m.compLoss),
    undistributed: round2(u),
    margin: round2(margin),
    marginPct: round2(marginPct),
    gross: round2(gross),
    grossPct: round2(grossPct),
    roi: round2(roi),
  };
}

/**
 * Расчёт себестоимости Озон (база ecotidy / Первый интегратор).
 * @param {string} fromRaw
 * @param {string} toRaw
 * @param {{ skipCost?: boolean, skipRegisters?: boolean, log?: boolean, refresh?: boolean }} [opts]
 */
export async function loadOzonCost(fromRaw, toRaw, opts = {}) {
  const range = resolveRange(fromRaw, toRaw);
  const cacheKey = `ozon-cost-${range.from}_${range.to}_c${opts.skipCost ? 0 : 1}_r${opts.skipRegisters ? 0 : 1}.json`;
  const cachePath = join(CACHE_DIR, cacheKey);
  if (!opts.refresh && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8"));
      const age = Date.now() - Date.parse(cached.generatedAt || 0);
      if (Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
        return { ...cached, cached: true, cacheAgeSec: Math.round(age / 1000) };
      }
    } catch {
      /* пересчитаем */
    }
  }

  const report = await loadOzonCostFresh(fromRaw, toRaw, opts);
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath, JSON.stringify(report), "utf8");
  } catch {
    /* кэш не обязателен */
  }
  return report;
}

async function loadOzonCostFresh(fromRaw, toRaw, opts = {}) {
  const range = resolveRange(fromRaw, toRaw);
  const warnings = [];
  const t0 = Date.now();
  const tick = (label) => {
    if (opts.log) console.error(`[ozon +${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);
  };

  const saleFilter =
    `(НазваниеТипаОперации eq 'Доставка покупателю' or НазваниеТипаОперации eq 'Получение возврата, отмены, невыкупа от покупателя')` +
    ` and СтоимостьТоваровСУчётомСкидокПродавца ne 0`;

  tick("sale+registers");
  let services = [];
  let servicesNoNom = [];
  let ads = [];
  const boot = [
    odataGet("Constant_НалогНаПрибыль?$format=json", DB),
    fetchAll(
      `Document_Alsn_Начисления?$format=json&$filter=Date ge datetime'${range.fromIso}' and Date le datetime'${range.toIso}' and Posted eq true and ${saleFilter}&$select=Ref_Key,НазваниеТипаОперации,СтоимостьТоваровСУчётомСкидокПродавца,СуммаОперации,КомиссияЗаПродажуИлиВозвратКомиссии`
    ),
  ];
  if (!opts.skipRegisters) {
    boot.push(
      fetchAll(
        `AccumulationRegister_AlsnДополнительныеУслуги_RecordType?$format=json&$filter=Period ge datetime'${range.fromIso}' and Period le datetime'${range.toIso}' and Active eq true&$select=Номенклатура,ВидНачисления,Сумма`
      ).catch((err) => {
        warnings.push(`Услуги: ${String(err.message || err).slice(0, 120)}`);
        return [];
      }),
      fetchAll(
        `AccumulationRegister_AlsnДополнительныеУслугиБезНоменклатуры_RecordType?$format=json&$filter=Period ge datetime'${range.fromIso}' and Period le datetime'${range.toIso}' and Active eq true&$select=ВидНачисления,Сумма`
      ).catch((err) => {
        warnings.push(`Услуги без ном.: ${String(err.message || err).slice(0, 120)}`);
        return [];
      }),
      fetchAll(
        `AccumulationRegister_Alsn_РасходыНаРекламу_RecordType?$format=json&$filter=Period ge datetime'${range.fromIso}' and Period le datetime'${range.toIso}' and Active eq true&$select=Номенклатура,ВидРекламнойКомпании,Сумма`
      ).catch((err) => {
        warnings.push(`Реклама: ${String(err.message || err).slice(0, 120)}`);
        return [];
      })
    );
  }
  const bootRows = await Promise.all(boot);
  const taxData = bootRows[0];
  const saleDocs = bootRows[1];
  if (!opts.skipRegisters) {
    services = bootRows[2] || [];
    servicesNoNom = bootRows[3] || [];
    ads = bootRows[4] || [];
    tick(`regs services=${services.length} noNom=${servicesNoNom.length} ads=${ads.length}`);
  } else {
    warnings.push("Регистры доп. услуг и рекламы пропущены (ускоренный режим).");
  }
  const taxRate = num(taxData.value?.[0]?.Value) || 0;
  tick(`sale docs done ${saleDocs.length}`);

  const goodsByRef = new Map();
  const saleKeys = saleDocs.map((d) => d.Ref_Key);
  const keyBatches = [];
  for (let i = 0; i < saleKeys.length; i += 8) keyBatches.push(saleKeys.slice(i, i + 8));
  let goodsErrors = 0;
  tick(`goods batches ${keyBatches.length}`);
  await mapPool(keyBatches, 4, async (part) => {
    try {
      const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
      const data = await odataGet(
        `Document_Alsn_Начисления_Товары?$format=json&$filter=${filter}&$select=Ref_Key,Номенклатура&$top=200`,
        DB
      );
      for (const row of data.value || []) {
        const list = goodsByRef.get(row.Ref_Key) || [];
        list.push(String(row.Номенклатура || ""));
        goodsByRef.set(row.Ref_Key, list);
      }
    } catch {
      goodsErrors += 1;
    }
  });
  if (goodsErrors) warnings.push(`Товары: ошибки загрузки в ${goodsErrors} пакетах`);
  tick(`goods done map=${goodsByRef.size} err=${goodsErrors}`);

  const byNom = new Map();
  const ensureNom = (id) => {
    const key = id || EMPTY;
    if (!byNom.has(key)) byNom.set(key, emptyMetrics());
    return byNom.get(key);
  };

  for (const doc of saleDocs) {
    let goods = goodsByRef.get(doc.Ref_Key) || [];
    if (!goods.length) goods = [EMPTY];
    const countByNom = new Map();
    for (const nom of goods) countByNom.set(nom, (countByNom.get(nom) || 0) + 1);
    const totalLines = goods.length;
    const saleDoc = num(doc.СтоимостьТоваровСУчётомСкидокПродавца);
    const opDoc = num(doc.СуммаОперации);
    const comDoc = num(doc.КомиссияЗаПродажуИлиВозвратКомиссии);

    for (const [nom, cnt] of countByNom.entries()) {
      const share = cnt / totalLines;
      const salePart = saleDoc * share;
      const opPart = opDoc * share;
      const comPart = comDoc * share;
      const patch = emptyMetrics();
      patch.qty = salePart < 0 ? -cnt : cnt;
      if (salePart < 0) {
        patch.returns = salePart;
        patch.sale = 0;
        patch.tax = 0;
      } else {
        patch.sale = salePart;
        patch.returns = 0;
        patch.tax = salePart * (taxRate / 100);
      }
      patch.deliveryOzon = salePart - opPart + comPart;
      patch.commission = -comPart;
      addMetrics(ensureNom(nom), patch);
    }
  }

  // Запасной путь: прочие операции из документов (полный режим — только регистры, как в 1С).
  if (opts.skipRegisters) {
    try {
      const otherDocs = await fetchAll(
        `Document_Alsn_Начисления?$format=json&$filter=Date ge datetime'${range.fromIso}' and Date le datetime'${range.toIso}' and Posted eq true&$select=Ref_Key,НазваниеТипаОперации,СуммаОперации`
      );
      for (const doc of otherDocs) {
        const name = doc.НазваниеТипаОперации || "";
        if (SALE_OPS.has(name)) continue;
        let field = DOC_OP_MAP[name];
        if (!field) {
          for (const [opName, f] of Object.entries(DOC_OP_MAP)) {
            if (name.startsWith(opName) || name.includes(opName)) {
              field = f;
              break;
            }
          }
        }
        if (!field) continue;
        const amount = -num(doc.СуммаОперации);
        if (!amount) continue;
        const patch = emptyMetrics();
        patch[field] = amount;
        addMetrics(ensureNom("__doc__"), patch);
      }
    } catch (err) {
      warnings.push(`Прочие операции: ${String(err.message || err).slice(0, 120)}`);
    }
  }

  tick(`apply regs services=${services.length}`);

  for (const row of services) {
    const field = mapServiceField(row.ВидНачисления);
    const amount = -num(row.Сумма);
    const patch = emptyMetrics();
    if (field === "returnsReg") patch.returnsReg = amount;
    else patch[field] = amount;
    addMetrics(ensureNom(row.Номенклатура), patch);
  }

  const undistributed = emptyMetrics();
  for (const row of servicesNoNom) {
    const field = mapServiceField(row.ВидНачисления);
    const amount = -num(row.Сумма);
    if (field === "returnsReg") undistributed.returnsReg += amount;
    else undistributed[field] = (undistributed[field] || 0) + amount;
    undistributed.undistributed += amount;
  }

  for (const row of ads) {
    const field = mapAdField(row.ВидРекламнойКомпании);
    const patch = emptyMetrics();
    patch[field] = num(row.Сумма);
    addMetrics(ensureNom(row.Номенклатура), patch);
  }

  const nomIds = [...byNom.keys()].filter((k) => k && k !== EMPTY && k !== "__doc__");
  const unitCost = new Map();
  if (!opts.skipCost) {
    tick("cost");
    try {
      const keyByNom = new Map();
      const keyBatches = [];
      for (let i = 0; i < nomIds.length; i += 8) keyBatches.push(nomIds.slice(i, i + 8));
      await mapPool(keyBatches, 4, async (part) => {
        const filter = encodeURIComponent(part.map((id) => `Номенклатура_Key eq guid'${id}'`).join(" or "));
        const data = await odataGet(
          `Catalog_КлючиАналитикиУчетаНоменклатуры?$format=json&$filter=${filter}&$select=Ref_Key,Номенклатура_Key&$top=200`,
          DB
        );
        for (const k of data.value || []) {
          if (k.Номенклатура_Key) keyByNom.set(k.Ref_Key, k.Номенклатура_Key);
        }
      });

      const analyticsIds = [...keyByNom.keys()];
      const agg = new Map();
      const analBatches = [];
      // Короткие пакеты — иначе OData 404 из‑за длины URL.
      for (let i = 0; i < analyticsIds.length; i += 3) analBatches.push(analyticsIds.slice(i, i + 3));
      await mapPool(analBatches, 4, async (part) => {
        const keyFilter = part.map((id) => `АналитикаУчетаНоменклатуры_Key eq guid'${id}'`).join(" or ");
        const data = await odataGet(
          `AccumulationRegister_СебестоимостьТоваров_RecordType?$format=json&$filter=Period ge datetime'${range.fromIso}' and Period le datetime'${range.toIso}' and Active eq true and RecordType eq 'Expense' and (${keyFilter})&$select=АналитикаУчетаНоменклатуры_Key,Количество,Стоимость,ДопРасходы,СтоимостьУпр,ДопРасходыУпр&$top=1000`,
          DB
        );
        for (const row of data.value || []) {
          const nom = keyByNom.get(row.АналитикаУчетаНоменклатуры_Key);
          if (!nom) continue;
          const cur = agg.get(nom) || { qty: 0, sum: 0 };
          cur.qty += num(row.Количество);
          const cost = num(row.Стоимость) + num(row.ДопРасходы);
          const costUpr = num(row.СтоимостьУпр) + num(row.ДопРасходыУпр);
          cur.sum += cost || costUpr;
          agg.set(nom, cur);
        }
      });
      for (const [nom, v] of agg.entries()) {
        unitCost.set(nom, v.qty ? v.sum / v.qty : 0);
      }
      tick(`cost units ${unitCost.size}`);
    } catch (err) {
      warnings.push(`Себестоимость: ${String(err.message || err).slice(0, 180)}`);
    }
  } else {
    warnings.push("Себестоимость по номенклатуре пропущена (ускоренный режим).");
  }

  for (const [nom, metrics] of byNom.entries()) {
    const unit = unitCost.get(nom) || 0;
    if (unit && metrics.qty) metrics.cost += unit * metrics.qty;
  }

  tick(`noms ${nomIds.length}`);
  const nomMap = await fetchByKeys(
    "Catalog_Номенклатура",
    nomIds,
    "Ref_Key,Description,ТоварнаяКатегория_Key"
  );
  tick(`nomMap ${nomMap.size}`);
  const catIds = [...nomMap.values()].map((r) => r.ТоварнаяКатегория_Key).filter(Boolean);
  const catMap = await fetchByKeys("Catalog_ТоварныеКатегории", catIds, "Ref_Key,Description");
  tick(`catMap ${catMap.size}`);

  const groups = new Map();
  const mergeUndistributed = (metrics) => {
    const name = "Не распределено";
    if (!groups.has(name)) groups.set(name, { name, metrics: emptyMetrics(), children: [] });
    addMetrics(groups.get(name).metrics, metrics);
  };

  for (const [nom, metrics] of byNom.entries()) {
    if (nom === EMPTY || nom === "__doc__") {
      mergeUndistributed(metrics);
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

  if (Object.values(undistributed).some((v) => num(v))) {
    mergeUndistributed(undistributed);
  }

  const groupRows = [...groups.values()]
    .map((g) => ({
      name: g.name,
      metrics: finishMetrics(g.metrics, taxRate),
      children: g.children
        .map((c) => ({ name: c.name, metrics: finishMetrics(c.metrics, taxRate) }))
        .sort((a, b) => a.name.localeCompare(b.name, "ru")),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const totalRaw = emptyMetrics();
  for (const g of groups.values()) addMetrics(totalRaw, g.metrics);
  const total = finishMetrics(totalRaw, taxRate);

  return {
    generatedAt: new Date().toISOString(),
    source: "1С ecotidy",
    organization: "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    period: { from: range.from, to: range.to },
    taxRate,
    groups: groupRows,
    total,
    warnings: [...new Set(warnings)].slice(0, 12),
    note:
      "Как отчёт 1С «Расчёт себестоимости» Озон: продажи и комиссия из Alsn_Начисления, " +
      "доп. услуги и реклама из регистров ALSN, себестоимость — средняя по расходу регистра «Себестоимость товаров». " +
      "Пустые колонки скрываются, как в 1С.",
  };
}
