import { odataConfig, odataAllPages } from "./odata.mjs";

const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

/** Хозоперации «оплата от клиента» в УТ. */
const CLIENT_PAYMENT_OPS = new Set([
  "ПоступлениеОплатыОтКлиента",
  "ПоступлениеОплатыПоПлатежнойКарте",
  "ПоступлениеОплатыОтКлиентаПоПлатежнойКарте",
]);

const OP_LABELS = {
  ПоступлениеОплатыОтКлиента: "Оплата от клиента",
  ПоступлениеОплатыПоПлатежнойКарте: "Оплата по карте",
  ПоступлениеОплатыОтКлиентаПоПлатежнойКарте: "Оплата по карте",
};

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

function parseDateInput(value, fallback) {
  const s = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback;
}

function monthBounds(year, month1to12) {
  const y = Number(year);
  const m = Number(month1to12);
  const from = `${y}-${pad2(m)}-01`;
  const last = new Date(y, m, 0).getDate();
  const to = `${y}-${pad2(m)}-${pad2(last)}`;
  return { from, to };
}

async function all(path, database = "trade") {
  return odataAllPages(path, { maxPages: 200, database });
}

async function resolveByKeys(entity, ids, select, database) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && !isEmptyGuid(id)))];
  for (let i = 0; i < list.length; i += 12) {
    const part = list.slice(i, i + 12);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await all(`${entity}?$filter=${filter}&$select=${select}&$format=json`, database);
    for (const row of rows) map.set(row.Ref_Key, row);
  }
  return map;
}

function matchesClientFilter(name, clientFilter) {
  const q = String(clientFilter || "").trim().toLowerCase();
  if (!q) return true;
  return String(name || "").toLowerCase().includes(q);
}

function isAllsanOrg(name) {
  return /аллсан/i.test(String(name || ""));
}

/**
 * Реестр оплат клиентов (Аллсан) за период.
 * Документы: ПоступлениеБезналичныхДенежныхСредств + ПриходныйКассовыйОрдер,
 * хозоперация «ПоступлениеОплатыОтКлиента» (+ оплата картой).
 */
export async function loadClientPayments(opts = {}) {
  const database = opts.database || "trade";
  const cfg = odataConfig(database);
  const warnings = [];

  const today = new Date();
  let dateFrom;
  let dateTo;
  if (opts.year && opts.month) {
    const b = monthBounds(opts.year, opts.month);
    dateFrom = b.from;
    dateTo = b.to;
  } else {
    dateFrom = parseDateInput(opts.dateFrom, `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-01`);
    const last = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    dateTo = parseDateInput(
      opts.dateTo,
      `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(last)}`
    );
  }

  const fromIso = `${dateFrom}T00:00:00`;
  const toIso = `${dateTo}T23:59:59`;
  const clientFilter = String(opts.client || "").trim();

  const orgs = await all("Catalog_Организации?$format=json&$select=Ref_Key,Description", database);
  const alsnOrgs = orgs.filter((o) => isAllsanOrg(o.Description));
  if (!alsnOrgs.length) {
    throw new Error("В базе trade не найдена организация с «Аллсан» в названии.");
  }
  const orgKeys = new Set(alsnOrgs.map((o) => o.Ref_Key));
  const orgNameByKey = new Map(alsnOrgs.map((o) => [o.Ref_Key, o.Description]));

  const periodFilter = `Date ge datetime'${fromIso}' and Date le datetime'${toIso}' and Posted eq true and DeletionMark eq false`;

  let bankDocs = [];
  let cashDocs = [];
  try {
    bankDocs = await all(
      `Document_ПоступлениеБезналичныхДенежныхСредств?$format=json&$filter=${encodeURIComponent(periodFilter)}&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,Организация_Key,ХозяйственнаяОперация,НазначениеПлатежа,Комментарий,ПроведеноБанком,ДатаПроведенияБанком,ТипПлатежногоДокумента`,
      database
    );
  } catch (err) {
    throw new Error(`Не удалось прочитать поступления безналичных: ${err.message || err}`);
  }
  try {
    cashDocs = await all(
      `Document_ПриходныйКассовыйОрдер?$format=json&$filter=${encodeURIComponent(periodFilter)}&$select=Ref_Key,Number,Date,СуммаДокумента,Контрагент_Key,Организация_Key,ХозяйственнаяОперация,Комментарий,ПринятоОт`,
      database
    );
  } catch (err) {
    warnings.push(`Кассовые ордера недоступны: ${err.message || err}`);
  }

  const raw = [];
  for (const d of bankDocs) {
    if (!orgKeys.has(d.Организация_Key)) continue;
    if (!CLIENT_PAYMENT_OPS.has(d.ХозяйственнаяОперация)) continue;
    raw.push({
      kind: "bank",
      ref: d.Ref_Key,
      number: d.Number,
      date: d.Date,
      amount: num(d.СуммаДокумента),
      counterpartyKey: d.Контрагент_Key,
      organizationKey: d.Организация_Key,
      operation: d.ХозяйственнаяОперация,
      purpose: d.НазначениеПлатежа || "",
      comment: d.Комментарий || "",
      bankPosted: Boolean(d.ПроведеноБанком),
      bankDate: d.ДатаПроведенияБанком || null,
    });
  }
  for (const d of cashDocs) {
    if (!orgKeys.has(d.Организация_Key)) continue;
    if (!CLIENT_PAYMENT_OPS.has(d.ХозяйственнаяОперация)) continue;
    raw.push({
      kind: "cash",
      ref: d.Ref_Key,
      number: d.Number,
      date: d.Date,
      amount: num(d.СуммаДокумента),
      counterpartyKey: d.Контрагент_Key,
      organizationKey: d.Организация_Key,
      operation: d.ХозяйственнаяОперация,
      purpose: d.ПринятоОт || "",
      comment: d.Комментарий || "",
      bankPosted: true,
      bankDate: null,
    });
  }

  const cpKeys = [...new Set(raw.map((r) => r.counterpartyKey).filter((id) => !isEmptyGuid(id)))];
  const counterparties = await resolveByKeys(
    "Catalog_Контрагенты",
    cpKeys,
    "Ref_Key,Description,Партнер_Key",
    database
  );
  const partnerKeys = [
    ...new Set([...counterparties.values()].map((c) => c.Партнер_Key).filter((id) => !isEmptyGuid(id))),
  ];
  const partners = await resolveByKeys("Catalog_Партнеры", partnerKeys, "Ref_Key,Description", database);

  // Партнёр из расшифровки безнала (если в шапке контрагент пустой/общий)
  const bankRefs = raw.filter((r) => r.kind === "bank").map((r) => r.ref);
  const linePartnerByDoc = new Map();
  for (let i = 0; i < bankRefs.length; i += 8) {
    const part = bankRefs.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    try {
      const lines = await all(
        `Document_ПоступлениеБезналичныхДенежныхСредств_РасшифровкаПлатежа?$filter=${filter}&$select=Ref_Key,Партнер_Key,Сумма&$format=json`,
        database
      );
      for (const line of lines) {
        if (isEmptyGuid(line.Партнер_Key)) continue;
        if (!linePartnerByDoc.has(line.Ref_Key)) linePartnerByDoc.set(line.Ref_Key, line.Партнер_Key);
      }
    } catch {
      /* расшифровка опциональна */
    }
  }
  const extraPartnerIds = [...new Set([...linePartnerByDoc.values()])].filter((id) => !partners.has(id));
  if (extraPartnerIds.length) {
    const extra = await resolveByKeys("Catalog_Партнеры", extraPartnerIds, "Ref_Key,Description", database);
    for (const [k, v] of extra) partners.set(k, v);
  }

  const clientsSet = new Set();
  const rows = [];
  for (const r of raw) {
    const cp = counterparties.get(r.counterpartyKey);
    const partnerKey = linePartnerByDoc.get(r.ref) || cp?.Партнер_Key || "";
    const client =
      partners.get(partnerKey)?.Description ||
      cp?.Description ||
      (isEmptyGuid(r.counterpartyKey) ? "Без клиента" : r.counterpartyKey);
    if (!matchesClientFilter(client, clientFilter)) continue;
    clientsSet.add(client);
    rows.push({
      date: String(r.date || "").slice(0, 10),
      number: r.number || "",
      client,
      amount: roundMoney(r.amount),
      channel: r.kind === "cash" ? "Наличные" : "Безнал",
      operation: OP_LABELS[r.operation] || r.operation,
      purpose: String(r.purpose || "").trim(),
      comment: String(r.comment || "").trim(),
      organization: orgNameByKey.get(r.organizationKey) || "",
      bankPosted: r.bankPosted,
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return String(b.number).localeCompare(String(a.number), "ru");
  });

  const totalAmount = roundMoney(rows.reduce((s, r) => s + r.amount, 0));
  const clients = [...clientsSet].sort((a, b) => a.localeCompare(b, "ru"));

  if (!rows.length) {
    warnings.push("За период нет проведённых оплат от клиентов по организациям Аллсан");
  }

  return {
    generatedAt: new Date().toISOString(),
    database,
    dateFrom,
    dateTo,
    clientFilter,
    organizations: alsnOrgs.map((o) => o.Description),
    note:
      "Реестр оплат клиентов по организациям с «Аллсан» в названии (trade). " +
      "Безнал: «Поступление безналичных ДС», касса: «ПКО», хозоперация «Поступление оплаты от клиента».",
    warnings,
    total: { count: rows.length, amount: totalAmount },
    clients,
    rows,
    meta: {
      bankDocs: bankDocs.length,
      cashDocs: cashDocs.length,
      matched: rows.length,
    },
  };
}
