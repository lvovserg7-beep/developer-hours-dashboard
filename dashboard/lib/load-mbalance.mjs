import { odataConfig, odataAllPages } from "./odata.mjs";

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const MONTHS_RU = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

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

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Конец месяца как начало следующего дня (как граница Balance в 1С). */
function monthEndBoundary(year, monthIndex0) {
  const y = monthIndex0 === 11 ? year + 1 : year;
  const m = monthIndex0 === 11 ? 1 : monthIndex0 + 2;
  return `${y}-${pad2(m)}-01T00:00:00`;
}

function parseDateInput(value, fallback) {
  const s = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function monthsInRange(fromYmd, toYmd) {
  const [fy, fm] = fromYmd.split("-").map(Number);
  const [ty, tm] = toYmd.split("-").map(Number);
  const out = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m, label: `${MONTHS_RU[m - 1]} ${y} г.`, boundary: monthEndBoundary(y, m - 1) });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

async function all(path, database = "trade") {
  return odataAllPages(path, { maxPages: 400, database });
}

async function resolveByKeys(entity, ids, select, database) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && !isEmptyGuid(id)))];
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await all(`${entity}?$filter=${filter}&$select=${select}&$format=json`, database);
    for (const row of rows) map.set(row.Ref_Key, row);
  }
  return map;
}

/** Долг «по бонусам»: физлица и ФИО; типовые юрлица/бренды — поставщики. */
function isBonusPartner(partner) {
  if (!partner) return false;
  const name = String(partner.Description || "").trim();
  if (partner.ЮрФизЛицо === "ЧастноеЛицо") return true;
  // Поставщики-организации (остальное с ФИО — в бонусы, даже если тип «Компания»).
  if (/Корпорац|1С\b|Битрикс|СОФТЕХ|ЭТП|Манго|Телеком/i.test(name)) return false;
  if (/^(АО|ЗАО|ПАО|ИП)\b/i.test(name)) return false;
  if (/^ООО\b/i.test(name) && !/СМБ/i.test(name)) return false;
  return /^[А-ЯЁA-Z][а-яёa-z'’\-«"\s]+\s+[А-ЯЁA-Z]/u.test(name) || /СМБ/i.test(name);
}

function emptyLeaf() {
  return { end: 0, change: 0 };
}

function addTo(map, name, amount) {
  if (!map.has(name)) map.set(name, 0);
  map.set(name, map.get(name) + num(amount));
}

async function loadArticles(database) {
  const rows = await all(
    "ChartOfCharacteristicTypes_СтатьиАктивовПассивов?$format=json&$select=Ref_Key,Description,Parent_Key,IsFolder,АктивПассив,РеквизитДопУпорядочивания,DeletionMark",
    database
  );
  return rows.filter((r) => !r.DeletionMark);
}

async function papByName(boundary, articles, database) {
  const byId = new Map(articles.map((a) => [a.Ref_Key, a]));
  const rows = await all(
    `AccumulationRegister_ПрочиеАктивыПассивы/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  const byName = new Map();
  for (const r of rows) {
    const name = byId.get(r.Статья_Key)?.Description || r.Статья_Key;
    addTo(byName, name, r.СуммаBalance);
  }
  for (const [k, v] of [...byName.entries()]) byName.set(k, roundMoney(v));
  return byName;
}

async function clientsDocs(boundary, database) {
  const rows = await all(
    `AccumulationRegister_РасчетыСКлиентамиПоДокументам/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  let debt = 0;
  let advances = 0;
  for (const r of rows) {
    debt += num(r.ДолгBalance);
    advances += num(r.ПредоплатаBalance);
  }
  return { debt: roundMoney(debt), advances: roundMoney(advances) };
}

async function suppliersDocs(boundary, database) {
  const rows = await all(
    `AccumulationRegister_РасчетыСПоставщикамиПоДокументам/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  const keys = [...new Set(rows.map((r) => r.АналитикаУчетаПоПартнерам_Key).filter(Boolean))];
  const analytics = await resolveByKeys(
    "Catalog_КлючиАналитикиУчетаПоПартнерам",
    keys,
    "Ref_Key,Партнер_Key",
    database
  );
  const partnerIds = [...new Set([...analytics.values()].map((a) => a.Партнер_Key).filter((id) => !isEmptyGuid(id)))];
  const partners = await resolveByKeys(
    "Catalog_Партнеры",
    partnerIds,
    "Ref_Key,Description,ЮрФизЛицо",
    database
  );

  let advances = 0;
  let supplierDebt = 0;
  let bonusDebt = 0;
  for (const r of rows) {
    advances += num(r.ПредоплатаBalance);
    const pid = analytics.get(r.АналитикаУчетаПоПартнерам_Key)?.Партнер_Key;
    const partner = partners.get(pid);
    const d = num(r.ДолгBalance);
    if (isBonusPartner(partner)) bonusDebt += d;
    else supplierDebt += d;
  }
  return {
    advances: roundMoney(advances),
    supplierDebt: roundMoney(supplierDebt),
    bonusDebt: roundMoney(bonusDebt),
  };
}

async function cashBank(boundary, database) {
  const rows = await all(
    `AccumulationRegister_ДенежныеСредстваБезналичные/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  let sum = 0;
  for (const r of rows) sum += num(r.СуммаBalance);
  return roundMoney(sum);
}

async function cashCash(boundary, database) {
  const rows = await all(
    `AccumulationRegister_ДенежныеСредстваНаличные/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  let sum = 0;
  for (const r of rows) sum += num(r.СуммаBalance);
  return roundMoney(sum);
}

async function cashInTransit(boundary, database) {
  const rows = await all(
    `AccumulationRegister_ДенежныеСредстваВПути/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  let toBank = 0;
  let toCash = 0;
  for (const r of rows) {
    // Внутренние переводы между своими счетами в отчёт УБ не входят.
    if (String(r.ВидПереводаДенежныхСредств || "") === "ПеречислениеНаДругойСчет") continue;
    const s = num(r.СуммаBalance);
    const t = String(r.Получатель_Type || "");
    if (/Банковск/i.test(t)) toBank += s;
    else if (/Касс/i.test(t)) toCash += s;
  }
  return { toBank: roundMoney(toBank), toCash: roundMoney(toCash) };
}

async function cashAccountable(boundary, database) {
  const rows = await all(
    `AccumulationRegister_ДенежныеСредстваУПодотчетныхЛиц/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  let asset = 0;
  let liability = 0;
  for (const r of rows) {
    const s = num(r.СуммаBalance);
    if (s >= 0) asset += s;
    else liability += s;
  }
  return { asset: roundMoney(asset), liability: roundMoney(liability) };
}

async function goodsWholesale(boundary, database) {
  const rows = await all(
    `AccumulationRegister_СебестоимостьТоваров/Balance(Period=datetime'${boundary}')?$format=json`,
    database
  );
  let sum = 0;
  for (const r of rows) {
    if (String(r.РазделУчета || "") !== "ТоварыНаСкладах") continue;
    sum += num(r.СтоимостьBalance) + num(r.СуммаДопРасходовBalance);
  }
  return roundMoney(sum);
}

function pap(map, name) {
  return roundMoney(map.get(name) || 0);
}

/**
 * Типовой отчёт УТ «Управленческий баланс»:
 * оперативные регистры + AccumulationRegister_ПрочиеАктивыПассивы.
 */
export async function loadMBalance(opts = {}) {
  const database = opts.database || "trade";
  const cfg = odataConfig(database);
  const today = new Date();
  const defaultTo = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  const defaultFrom = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-01`;
  const dateFrom = parseDateInput(opts.dateFrom, defaultFrom);
  const dateTo = parseDateInput(opts.dateTo, defaultTo);
  const months = monthsInRange(dateFrom, dateTo);
  if (!months.length) throw new Error("Пустой период");
  if (months.length > 12) throw new Error("Период слишком длинный (макс. 12 месяцев)");

  const warnings = [];
  const articles = await loadArticles(database);

  /** @type {{ key: string, label: string, end: number[], change: number[] }[]} */
  const periodCols = months.map((m) => ({ key: `${m.year}-${pad2(m.month)}`, label: m.label }));

  const valuesByMonth = [];

  for (const month of months) {
    const b = month.boundary;
    const [
      papMap,
      cli,
      sup,
      bank,
      cash,
      transit,
      accountable,
      goods,
    ] = await Promise.all([
      papByName(b, articles, database),
      clientsDocs(b, database),
      suppliersDocs(b, database),
      cashBank(b, database),
      cashCash(b, database),
      cashInTransit(b, database),
      cashAccountable(b, database),
      goodsWholesale(b, database),
    ]);

    const leaf = {
      "Выданные авансы": roundMoney(sup.advances),
      "Задолженность клиентов": roundMoney(cli.debt + pap(papMap, "Задолженность клиентов")),
      "Денежные средства (безналичные)": bank,
      "Денежные средства (безналичные) к поступлению": transit.toBank,
      "Денежные средства (наличные)": cash,
      "Денежные средства (наличные) к поступлению": transit.toCash,
      "Стаб фонд": pap(papMap, "Стаб фонд"),
      "Денежные средства (у подотчетных лиц)|asset": accountable.asset,
      "Спец Счет": pap(papMap, "Спец Счет"),
      EcoTidy: pap(papMap, "ЭкоTidy") || pap(papMap, "EcoTidy"),
      "Товары на оптовых складах": roundMoney(goods + pap(papMap, "Товары на оптовых складах")),
      "Основные средства": pap(papMap, "Основные средства"),
      "Налоги ЗП": pap(papMap, "Налоги ЗП"),
      "Денежные средства (у подотчетных лиц)|liab": accountable.liability,
      "Задолженность перед поставщиками": roundMoney(
        sup.supplierDebt + pap(papMap, "Задолженность перед поставщиками")
      ),
      "Полученные авансы": cli.advances,
      "Задолженность перед откатчиками": pap(papMap, "Задолженность перед откатчиками"),
      Налоги: pap(papMap, "Налоги"),
      "Задолженность по ЗП": pap(papMap, "Задолженность по ЗП"),
      "Задолженность по бонусам": roundMoney(sup.bonusDebt + pap(papMap, "Задолженность по бонусам")),
      "Сомнительные долги": pap(papMap, "Сомнительные долги"),
      "Доля Аллсан": pap(papMap, "Доля Аллсан"),
      "Прибыли и убытки": pap(papMap, "Прибыли и убытки"),
    };
    valuesByMonth.push(leaf);
  }

  function series(getter) {
    const end = valuesByMonth.map((m) => roundMoney(getter(m)));
    const change = end.map((v, i) => roundMoney(i === 0 ? 0 : v - end[i - 1]));
    // для первого месяца изменение считаем от нуля не показываем как 0 — в 1С есть оборот;
    // оставим change[0] = end[0] если нет предыдущего в выборке? На скрине у апреля есть изменение.
    // Без остатка «на начало» точный оборот первого месяца неизвестен → для i=0 ставим null-флаг через 0 и warning.
    return { end, change };
  }

  // Для «Изменение» первого месяца: остаток на начало = Balance на dateFrom
  const startBoundary = `${dateFrom}T00:00:00`;
  let startLeaf = null;
  try {
    const [
      papMap,
      cli,
      sup,
      bank,
      cash,
      transit,
      accountable,
      goods,
    ] = await Promise.all([
      papByName(startBoundary, articles, database),
      clientsDocs(startBoundary, database),
      suppliersDocs(startBoundary, database),
      cashBank(startBoundary, database),
      cashCash(startBoundary, database),
      cashInTransit(startBoundary, database),
      cashAccountable(startBoundary, database),
      goodsWholesale(startBoundary, database),
    ]);
    startLeaf = {
      "Выданные авансы": roundMoney(sup.advances),
      "Задолженность клиентов": roundMoney(cli.debt + pap(papMap, "Задолженность клиентов")),
      "Денежные средства (безналичные)": bank,
      "Денежные средства (безналичные) к поступлению": transit.toBank,
      "Денежные средства (наличные)": cash,
      "Денежные средства (наличные) к поступлению": transit.toCash,
      "Стаб фонд": pap(papMap, "Стаб фонд"),
      "Денежные средства (у подотчетных лиц)|asset": accountable.asset,
      "Спец Счет": pap(papMap, "Спец Счет"),
      EcoTidy: pap(papMap, "ЭкоTidy") || pap(papMap, "EcoTidy"),
      "Товары на оптовых складах": roundMoney(goods + pap(papMap, "Товары на оптовых складах")),
      "Основные средства": pap(papMap, "Основные средства"),
      "Налоги ЗП": pap(papMap, "Налоги ЗП"),
      "Денежные средства (у подотчетных лиц)|liab": accountable.liability,
      "Задолженность перед поставщиками": roundMoney(
        sup.supplierDebt + pap(papMap, "Задолженность перед поставщиками")
      ),
      "Полученные авансы": cli.advances,
      "Задолженность перед откатчиками": pap(papMap, "Задолженность перед откатчиками"),
      Налоги: pap(papMap, "Налоги"),
      "Задолженность по ЗП": pap(papMap, "Задолженность по ЗП"),
      "Задолженность по бонусам": roundMoney(sup.bonusDebt + pap(papMap, "Задолженность по бонусам")),
      "Сомнительные долги": pap(papMap, "Сомнительные долги"),
      "Доля Аллсан": pap(papMap, "Доля Аллсан"),
      "Прибыли и убытки": pap(papMap, "Прибыли и убытки"),
    };
  } catch (err) {
    warnings.push(`Не удалось посчитать остаток на начало периода: ${err.message || err}`);
  }

  function leafSeries(key) {
    const end = valuesByMonth.map((m) => roundMoney(m[key] || 0));
    const change = end.map((v, i) => {
      if (i > 0) return roundMoney(v - end[i - 1]);
      if (startLeaf) return roundMoney(v - roundMoney(startLeaf[key] || 0));
      return 0;
    });
    return { end, change };
  }

  function sumSeries(keys) {
    const end = valuesByMonth.map((_, i) =>
      roundMoney(keys.reduce((s, k) => s + (valuesByMonth[i][k] || 0), 0))
    );
    const change = end.map((v, i) => {
      if (i > 0) return roundMoney(v - end[i - 1]);
      if (startLeaf) {
        const start = keys.reduce((s, k) => s + (startLeaf[k] || 0), 0);
        return roundMoney(v - roundMoney(start));
      }
      return 0;
    });
    return { end, change };
  }

  function node(id, name, level, childrenKeys, side) {
    const ser = Array.isArray(childrenKeys) && childrenKeys.length ? sumSeries(childrenKeys) : leafSeries(id);
    return {
      id,
      name,
      level,
      side,
      end: ser.end,
      change: ser.change,
      hideIfZero: level > 1,
    };
  }

  const assetDebtorKeys = ["Выданные авансы", "Задолженность клиентов"];
  const assetCashKeys = [
    "Денежные средства (безналичные)",
    "Денежные средства (безналичные) к поступлению",
    "Денежные средства (наличные)",
    "Денежные средства (наличные) к поступлению",
    "Стаб фонд",
    "Денежные средства (у подотчетных лиц)|asset",
    "Спец Счет",
    "EcoTidy",
  ];
  const assetGoodsKeys = ["Товары на оптовых складах"];
  const assetAllKeys = [
    ...assetDebtorKeys,
    ...assetCashKeys,
    ...assetGoodsKeys,
    "Основные средства",
    "Налоги ЗП",
  ];

  const liabCashKeys = ["Денежные средства (у подотчетных лиц)|liab"];
  const liabCredKeys = [
    "Задолженность перед поставщиками",
    "Полученные авансы",
    "Задолженность перед откатчиками",
  ];
  const liabEmpKeys = ["Задолженность по ЗП", "Задолженность по бонусам"];
  const liabProfitKeys = ["Сомнительные долги", "Доля Аллсан", "Прибыли и убытки"];
  const liabAllKeys = [...liabCashKeys, ...liabCredKeys, "Налоги", ...liabEmpKeys, ...liabProfitKeys];

  const rows = [
    { ...node("assets", "Активы", 0, assetAllKeys, "asset"), bold: true },
    { ...node("debtors", "Дебиторская задолженность", 1, assetDebtorKeys, "asset"), bold: true },
    node("Выданные авансы", "Выданные авансы", 2, null, "asset"),
    node("Задолженность клиентов", "Задолженность клиентов", 2, null, "asset"),
    { ...node("cashA", "Денежные средства", 1, assetCashKeys, "asset"), bold: true },
    node("Денежные средства (безналичные)", "Денежные средства (безналичные)", 2, null, "asset"),
    node(
      "Денежные средства (безналичные) к поступлению",
      "Денежные средства (безналичные) к поступлению",
      2,
      null,
      "asset"
    ),
    node("Денежные средства (наличные)", "Денежные средства (наличные)", 2, null, "asset"),
    node(
      "Денежные средства (наличные) к поступлению",
      "Денежные средства (наличные) к поступлению",
      2,
      null,
      "asset"
    ),
    node("Стаб фонд", "Стаб фонд", 2, null, "asset"),
    node("Денежные средства (у подотчетных лиц)|asset", "Денежные средства (у подотчетных лиц)", 2, null, "asset"),
    node("Спец Счет", "Спец Счет", 2, null, "asset"),
    node("EcoTidy", "EcoTidy", 2, null, "asset"),
    { ...node("goods", "Товары", 1, assetGoodsKeys, "asset"), bold: true },
    node("Товары на оптовых складах", "Товары на оптовых складах", 2, null, "asset"),
    node("Основные средства", "Основные средства", 1, null, "asset"),
    node("Налоги ЗП", "Налоги ЗП", 1, null, "asset"),

    { ...node("liab", "Пассивы", 0, liabAllKeys, "liability"), bold: true },
    { ...node("cashL", "Денежные средства", 1, liabCashKeys, "liability"), bold: true },
    node("Денежные средства (у подотчетных лиц)|liab", "Денежные средства (у подотчетных лиц)", 2, null, "liability"),
    { ...node("cred", "Кредиторская задолженность", 1, liabCredKeys, "liability"), bold: true },
    node("Задолженность перед поставщиками", "Задолженность перед поставщиками", 2, null, "liability"),
    node("Полученные авансы", "Полученные авансы", 2, null, "liability"),
    node("Задолженность перед откатчиками", "Задолженность перед откатчиками", 2, null, "liability"),
    node("Налоги", "Налоги", 1, null, "liability"),
    { ...node("emp", "Задолженность перед сотрудниками", 1, liabEmpKeys, "liability"), bold: true },
    node("Задолженность по ЗП", "Задолженность по ЗП", 2, null, "liability"),
    node("Задолженность по бонусам", "Задолженность по бонусам", 2, null, "liability"),
    { ...node("profit", "Прибыль очищенная", 1, liabProfitKeys, "liability"), bold: true },
    node("Сомнительные долги", "Сомнительные долги", 2, null, "liability"),
    node("Доля Аллсан", "Доля Аллсан", 2, null, "liability"),
    node("Прибыли и убытки", "Прибыли и убытки", 2, null, "liability"),
  ];

  const assets = sumSeries(assetAllKeys);
  const liabs = sumSeries(liabAllKeys);
  const imbalance = {
    end: assets.end.map((a, i) => roundMoney(a + liabs.end[i])),
    change: assets.change.map((a, i) => roundMoney(a + liabs.change[i])),
  };

  const hasImbalance = imbalance.end.some((v) => Math.abs(v) >= 0.01);
  if (hasImbalance) warnings.push("Нарушен баланс активов и пассивов");

  return {
    generatedAt: new Date().toISOString(),
    database,
    organization: opts.organization || "",
    dateFrom,
    dateTo,
    periods: periodCols,
    rows,
    imbalance: { name: "Нарушен баланс активов и пассивов", ...imbalance },
    totals: { assets: assets.end, liabilities: liabs.end, imbalance: imbalance.end },
    note:
      "Типовой управленческий баланс УТ: остатки на конец месяца из оперативных регистров " +
      "(расчёты с клиентами/поставщиками по документам, ДС, себестоимость товаров) " +
      "плюс регистр «Прочие активы и пассивы». " +
      "Долги физлиц в расчётах с поставщиками относятся к «Задолженность по бонусам».",
    warnings,
    source: [
      "AccumulationRegister_ПрочиеАктивыПассивы/Balance",
      "AccumulationRegister_РасчетыСКлиентамиПоДокументам/Balance",
      "AccumulationRegister_РасчетыСПоставщикамиПоДокументам/Balance",
      "AccumulationRegister_ДенежныеСредстваБезналичные/Balance",
      "AccumulationRegister_ДенежныеСредстваНаличные/Balance",
      "AccumulationRegister_ДенежныеСредстваВПути/Balance",
      "AccumulationRegister_ДенежныеСредстваУПодотчетныхЛиц/Balance",
      "AccumulationRegister_СебестоимостьТоваров/Balance",
    ],
    meta: { months: months.length, host: cfg.host },
  };
}
