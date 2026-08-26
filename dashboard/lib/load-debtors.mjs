import { odataGet } from "./odata.mjs";
import { odataConfig } from "./odata.mjs";

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

function isEmptyGuid(id) {
  return !id || id === EMPTY_GUID;
}

async function odataAll(path, database = "trade") {
  const rows = [];
  let next = path.includes("?") ? path : `${path}?$format=json`;
  if (!next.includes("$format=")) next += (next.includes("?") ? "&" : "?") + "$format=json";
  let pages = 0;
  while (next && pages < 200) {
    const data = await odataGet(next, database);
    rows.push(...(data.value || []));
    next = data["odata.nextLink"] || data["@odata.nextLink"] || null;
    pages += 1;
  }
  return rows;
}

async function resolveByKeys(entity, ids, select, database = "trade") {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && !isEmptyGuid(id)))];
  for (let i = 0; i < list.length; i += 12) {
    const part = list.slice(i, i + 12);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await odataAll(`${entity}?$filter=${filter}&$select=${select}`, database);
    for (const row of rows) map.set(row.Ref_Key, row);
  }
  return map;
}

function emptyBucket() {
  return {
    clientDebt: 0,
    ourDebt: 0,
    paying: 0,
    toPay: 0,
    toShip: 0,
    shipping: 0,
  };
}

function addBalance(bucket, row) {
  const sum = num(row.СуммаBalance);
  if (sum > 0) bucket.clientDebt += sum;
  else bucket.ourDebt += -sum;

  const toPay = num(row.КОплатеBalance);
  if (toPay > 0) bucket.toPay += toPay;

  bucket.paying += num(row.ОплачиваетсяBalance);
  bucket.toShip += Math.max(0, num(row.КОтгрузкеBalance));
  bucket.shipping += Math.max(0, num(row.ОтгружаетсяBalance));
}

function finishBucket(raw) {
  const clientDebt = roundMoney(raw.clientDebt);
  const ourDebt = roundMoney(raw.ourDebt);
  return {
    clientDebt,
    ourDebt,
    saldo: roundMoney(clientDebt - ourDebt),
    paying: roundMoney(raw.paying),
    toPay: roundMoney(raw.toPay),
    toShip: roundMoney(raw.toShip),
    shipping: roundMoney(raw.shipping),
  };
}

/**
 * Типовой отчёт УТ «Задолженность клиентов» по остаткам регистра «РасчетыСКлиентами».
 * Долг клиента = положительная Сумма, наш долг = отрицательная Сумма.
 */
export async function loadDebtors(opts = {}) {
  const database = opts.database || "trade";
  const cfg = odataConfig(database);
  const warnings = [];

  let balances = [];
  try {
    balances = await odataAll(
      "AccumulationRegister_РасчетыСКлиентами/Balance?$top=1000",
      database
    );
  } catch (err) {
    throw new Error(`Не удалось прочитать РасчетыСКлиентами/Balance: ${err.message || err}`);
  }

  const analyticsKeys = [...new Set(balances.map((r) => r.АналитикаУчетаПоПартнерам_Key).filter(Boolean))];
  const currencyKeys = [...new Set(balances.map((r) => r.Валюта_Key).filter((id) => !isEmptyGuid(id)))];

  const [analytics, currencies] = await Promise.all([
    resolveByKeys(
      "Catalog_КлючиАналитикиУчетаПоПартнерам",
      analyticsKeys,
      "Ref_Key,Партнер_Key,Организация_Key,Description",
      database
    ),
    resolveByKeys("Catalog_Валюты", currencyKeys, "Ref_Key,Description,Code", database),
  ]);

  const partnerKeys = [...new Set([...analytics.values()].map((a) => a.Партнер_Key).filter((id) => !isEmptyGuid(id)))];
  const orgKeys = [...new Set([...analytics.values()].map((a) => a.Организация_Key).filter((id) => !isEmptyGuid(id)))];
  const [partners, organizations] = await Promise.all([
    resolveByKeys("Catalog_Партнеры", partnerKeys, "Ref_Key,Description", database),
    resolveByKeys("Catalog_Организации", orgKeys, "Ref_Key,Description", database),
  ]);

  const orgFilter = String(opts.organization || "").trim().toLowerCase();
  const byClient = new Map();
  const totalRaw = emptyBucket();
  let currencyLabel = "RUB";

  for (const row of balances) {
    const an = analytics.get(row.АналитикаУчетаПоПартнерам_Key);
    const orgName = organizations.get(an?.Организация_Key)?.Description || "";
    if (orgFilter && !String(orgName).toLowerCase().includes(orgFilter)) continue;

    const partnerKey = an?.Партнер_Key || "";
    const client =
      partners.get(partnerKey)?.Description ||
      String(an?.Description || "").split(";")[0].trim() ||
      "Без клиента";

    if (!byClient.has(client)) byClient.set(client, emptyBucket());
    addBalance(byClient.get(client), row);
    addBalance(totalRaw, row);

    const cur = currencies.get(row.Валюта_Key);
    if (cur?.Code || cur?.Description) currencyLabel = cur.Code || cur.Description;
  }

  const rows = [...byClient.entries()]
    .map(([client, raw]) => ({ client, ...finishBucket(raw) }))
    .filter((r) => r.clientDebt || r.ourDebt || r.toPay || r.paying || r.toShip || r.shipping)
    .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo) || a.client.localeCompare(b.client, "ru"));

  const total = finishBucket(totalRaw);

  if (!rows.length) warnings.push("Нет остатков расчётов с клиентами");

  return {
    generatedAt: new Date().toISOString(),
    database,
    source: "AccumulationRegister_РасчетыСКлиентами/Balance",
    organization: opts.organization || cfg.defaultOrg || "",
    currency: currencyLabel,
    note:
      "Как типовой отчёт 1С «Задолженность клиентов»: остатки регистра «Расчеты с клиентами». " +
      "Долг клиента — положительная «Сумма», наш долг — отрицательная. " +
      "Планируемая оплата — ресурс «К оплате», отгрузка — «К отгрузке» / «Отгружается». " +
      "Колонки «Просрочено» и детализация аванс/предоплата/кредит в этой версии не выводятся.",
    warnings,
    total,
    rows,
    meta: {
      balanceRows: balances.length,
      clients: rows.length,
    },
  };
}
