import { odataGet } from "./odata.mjs";

const DB = "ecotidy";
const PAGE = 500;
const EMPTY = "00000000-0000-0000-0000-000000000000";
const UNDISTRIBUTED = "Нераспределенные расходы";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
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

export function defaultWbRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: ymd(from), to: ymd(to) };
}

function resolveRange(fromRaw, toRaw) {
  const from = parseYmd(fromRaw) || parseYmd(defaultWbRange().from);
  const to = parseYmd(toRaw) || parseYmd(defaultWbRange().to);
  if (from > to) throw new Error("Дата «с» не может быть позже «по»");
  return {
    from: ymd(from),
    to: ymd(to),
    fromIso: `${ymd(from)}T00:00:00`,
    toIso: `${ymd(to)}T23:59:59`,
  };
}

function eachDay(fromDate, toDate) {
  const days = [];
  const cur = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const end = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  while (cur <= end) {
    days.push(ymd(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

async function fetchAll(path) {
  const rows = [];
  for (let page = 0; page < 2000; page++) {
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
        const current = index;
        index += 1;
        await worker(items[current], current);
      }
    })
  );
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

function emptyMetrics() {
  return {
    revenue: 0,
    saleQty: 0,
    saleRub: 0,
    retQty: 0,
    retRub: 0,
    lost: 0,
    penalty: 0,
    surcharge: 0,
    logistics: 0,
    storage: 0,
    acceptance: 0,
    deduction: 0,
    cost: 0,
  };
}

function addMetrics(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    target[k] = (target[k] || 0) + num(v);
  }
}

function finishMetrics(m, taxRate) {
  const revenue = round2(m.revenue);
  const saleQty = round2(m.saleQty);
  const saleRub = round2(m.saleRub);
  const retQty = round2(m.retQty);
  const retRub = round2(m.retRub);
  const lost = round2(m.lost);
  const penalty = round2(m.penalty);
  const surcharge = round2(m.surcharge);
  const logistics = round2(m.logistics);
  const storage = round2(m.storage);
  const acceptance = round2(m.acceptance);
  const deduction = round2(m.deduction);
  const cost = round2(m.cost);
  const buyout = saleQty + retQty ? round2((saleQty / (saleQty + retQty)) * 100) : 0;
  const pay = round2(
    saleRub - retRub + lost + surcharge - logistics - penalty - storage - acceptance - deduction
  );
  const tax = round2(revenue * (taxRate / 100));
  const profit = round2(pay - cost - tax);
  const margin = revenue ? Math.round((profit / revenue) * 100) : 0;
  return {
    revenue,
    saleQty,
    saleRub,
    retQty,
    retRub,
    buyout,
    logistics,
    lost,
    penalty,
    surcharge,
    storage,
    acceptance,
    deduction,
    pay,
    cost,
    tax,
    profit,
    margin,
  };
}

/**
 * Расчёт рентабельности Wildberries (база ecotidy).
 * Источник: отчёт «Рассчет себестоимости вб» / Расчет рентабельности WB.
 * Документы грузим по дням (месячный $filter на OData зависает).
 */
export async function loadWbProfit(fromRaw, toRaw, opts = {}) {
  const range = resolveRange(fromRaw, toRaw);
  const fromDate = parseYmd(range.from);
  const toDate = parseYmd(range.to);
  const days = eachDay(fromDate, toDate);
  const warnings = [];
  const skipCost = opts.skipCost === true;

  const taxData = await odataGet("Constant_ALSN_WB_НалогНаПрибыль?$format=json", DB);
  const taxRate = num(taxData.value?.[0]?.Value) || 0;

  const select = [
    "Номенклатура",
    "ОбоснованиеОплаты",
    "Количество",
    "ЦенаРозничная",
    "КПеречислениюПродавцу",
    "Доплаты",
    "СтоимостьЛогистики",
    "Штрафы",
    "СтоимостьХранения",
    "СтоимостьПлатнойПриемки",
    "ПрочиеУдержания",
  ].join(",");

  const byNom = new Map();
  const ensureNom = (id) => {
    const key = id || EMPTY;
    if (!byNom.has(key)) byNom.set(key, emptyMetrics());
    return byNom.get(key);
  };

  let rowCount = 0;
  const dayDocs = new Array(days.length);
  await mapPool(days, 4, async (day, idx) => {
    try {
      dayDocs[idx] = await fetchAll(
        `Document_ALSN_РеализацияWildberries?$format=json&$filter=Date ge datetime'${day}T00:00:00' and Date le datetime'${day}T23:59:59' and DeletionMark eq false&$select=${select}`
      );
    } catch (err) {
      warnings.push(`${day}: ${String(err.message || err).slice(0, 100)}`);
      dayDocs[idx] = [];
    }
  });

  for (const rows of dayDocs) {
    if (!rows) continue;
    rowCount += rows.length;
    for (const r of rows) {
      const raw = String(r.Номенклатура || "");
      const nom = raw && raw !== EMPTY ? raw : EMPTY;
      const m = ensureNom(nom);
      const reason = String(r.ОбоснованиеОплаты || "");
      const qty = num(r.Количество);
      const price = num(r.ЦенаРозничная);
      if (reason === "Продажа") {
        m.revenue += qty * price;
        m.saleQty += qty;
        m.saleRub += num(r.КПеречислениюПродавцу);
      } else if (reason === "Возврат") {
        m.revenue -= qty * price;
        m.retQty += qty;
        m.retRub += num(r.КПеречислениюПродавцу);
      }
      // В СКД: Доплаты документа → КорректировкаРуб; ДоплатыРуб всегда 0
      m.surcharge += num(r.Доплаты);
      m.logistics += num(r.СтоимостьЛогистики);
      m.penalty += num(r.Штрафы);
      m.storage += num(r.СтоимостьХранения);
      m.acceptance += num(r.СтоимостьПлатнойПриемки);
      m.deduction += num(r.ПрочиеУдержания);
    }
  }

  const nomIds = [...byNom.keys()].filter((k) => k && k !== EMPTY);

  if (!skipCost && nomIds.length) {
    try {
      const keyByNom = new Map();
      for (let i = 0; i < nomIds.length; i += 8) {
        const part = nomIds.slice(i, i + 8);
        const filter = encodeURIComponent(part.map((id) => `Номенклатура_Key eq guid'${id}'`).join(" or "));
        const keys = await fetchAll(
          `Catalog_КлючиАналитикиУчетаНоменклатуры?$format=json&$filter=${filter}&$select=Ref_Key,Номенклатура_Key`
        );
        for (const k of keys) {
          if (k.Номенклатура_Key) keyByNom.set(k.Ref_Key, k.Номенклатура_Key);
        }
      }

      const unitAgg = new Map();
      const costByDay = new Array(days.length);
      await mapPool(days, 4, async (day, idx) => {
        try {
          costByDay[idx] = await fetchAll(
            `AccumulationRegister_СебестоимостьТоваров_RecordType?$format=json&$filter=Period ge datetime'${day}T00:00:00' and Period le datetime'${day}T23:59:59' and Active eq true and RecordType eq 'Expense'&$select=АналитикаУчетаНоменклатуры_Key,Количество,Стоимость,ДопРасходы`
          );
        } catch {
          costByDay[idx] = [];
        }
      });
      for (const costRows of costByDay) {
        if (!costRows) continue;
        for (const row of costRows) {
          const nom = keyByNom.get(row.АналитикаУчетаНоменклатуры_Key);
          if (!nom) continue;
          const cur = unitAgg.get(nom) || { qty: 0, sum: 0 };
          cur.qty += num(row.Количество);
          cur.sum += num(row.Стоимость) + num(row.ДопРасходы);
          unitAgg.set(nom, cur);
        }
      }

      for (const [nom, metrics] of byNom.entries()) {
        if (nom === EMPTY) continue;
        const u = unitAgg.get(nom);
        const unit = u && u.qty ? u.sum / u.qty : 0;
        metrics.cost += unit * (metrics.saleQty - metrics.retQty);
      }
      warnings.push(
        "Себестоимость — средняя по расходу регистра «Себестоимость товаров» (в XML 1С блок себестоимости подставляется расширением)."
      );
    } catch (err) {
      warnings.push(`Себестоимость: ${String(err.message || err).slice(0, 180)}`);
    }
  } else if (skipCost) {
    warnings.push("Себестоимость пропущена (ускоренный режим).");
  }

  const nomMap = await fetchByKeys( "Catalog_Номенклатура", nomIds, "Ref_Key,Description");

  const rows = [];
  for (const [nom, metrics] of byNom.entries()) {
    const name =
      nom === EMPTY ? UNDISTRIBUTED : nomMap.get(nom)?.Description || `Номенклатура ${String(nom).slice(0, 8)}`;
    rows.push({
      name,
      undistr: nom === EMPTY,
      metrics: finishMetrics(metrics, taxRate),
    });
  }
  rows.sort((a, b) => {
    if (a.undistr !== b.undistr) return a.undistr ? -1 : 1;
    return a.name.localeCompare(b.name, "ru");
  });

  const totalRaw = emptyMetrics();
  for (const m of byNom.values()) addMetrics(totalRaw, m);

  return {
    generatedAt: new Date().toISOString(),
    source: "1С ecotidy",
    organization: "ПЕРВЫЙ ИНТЕГРАТОР ООО",
    title: "Расчет рентабельности WB",
    period: { from: range.from, to: range.to },
    taxRate,
    rows: rows.map(({ name, metrics }) => ({ name, metrics })),
    total: finishMetrics(totalRaw, taxRate),
    counts: { docs: rowCount, nomenclature: nomIds.length, days: days.length },
    warnings,
  };
}
