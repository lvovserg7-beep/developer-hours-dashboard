import { ozonSellerConfigured, ozonSellerPost } from "./ozon-seller.mjs";

const CLOSED = new Set(["closed", "cancelled", "canceled"]);
const LOOKBACK_DAYS = 90;
const LIMIT = 50;
const POSTING_LIMIT = 100;
const POSTING_LOOKBACK_DAYS = 60;
const AWAITING_STATUSES = ["awaiting_deliver"];
const MSK = "Europe/Moscow";

const STATUS_RU = {
  closed: "Закрыт",
  cancelled: "Отменён",
  canceled: "Отменён",
  formed: "Формируется",
  confirmed: "Подтверждён",
  in_process: "В работе",
  shipped: "Отгружен",
};

const ACT_TYPE_RU = {
  ozon_digital: "Электронный",
  ozon: "Бумажный",
};

const POSTING_STATUS_RU = {
  awaiting_deliver: "Ожидает отгрузки",
  awaiting_packaging: "Ожидает сборки",
  awaiting_registration: "Ожидает регистрации",
  awaiting_approve: "Ожидает подтверждения",
  delivering: "Доставляется",
  delivered: "Доставлено",
  cancelled: "Отменён",
};

const POSTING_SUBSTATUS_RU = {
  posting_transferring_to_delivery: "Готов к отгрузке",
  posting_awaiting_packaging: "Ожидает сборки",
  posting_in_arbitration: "Арбитраж",
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, n) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

function isOpenAct(act) {
  const status = String(act?.status || "").trim().toLowerCase();
  return status && !CLOSED.has(status);
}

function statusLabel(status) {
  const key = String(status || "").trim().toLowerCase();
  return STATUS_RU[key] || status || "—";
}

function actTypeLabel(type) {
  const key = String(type || "").trim();
  return ACT_TYPE_RU[key] || type || "—";
}

function postingStatusLabel(status, substatus) {
  const sub = String(substatus || "").trim().toLowerCase();
  if (sub && POSTING_SUBSTATUS_RU[sub]) return POSTING_SUBSTATUS_RU[sub];
  const key = String(status || "").trim().toLowerCase();
  return POSTING_STATUS_RU[key] || status || "—";
}

function formatMsk(iso, options) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { timeZone: MSK, ...options }).format(d);
}

function sameMskDay(iso, now = new Date()) {
  if (!iso) return false;
  const a = formatMsk(iso, { year: "numeric", month: "2-digit", day: "2-digit" });
  const b = formatMsk(now.toISOString(), { year: "numeric", month: "2-digit", day: "2-digit" });
  return Boolean(a) && a === b;
}

function tariffLabel(raw) {
  const t = raw.tariffication || {};
  const charge = Number(t.current_tariff_charge);
  const type = String(t.current_tariff_type || "").trim();
  const until = t.next_tariff_starts_at || "";
  if (type === "discount" && Number.isFinite(charge) && charge > 0 && until) {
    const when = sameMskDay(until) ? "сегодня" : formatMsk(until, { day: "numeric", month: "short" });
    const hm = formatMsk(until, { hour: "2-digit", minute: "2-digit" });
    return `Скидка ${charge} ₽ ${when} до ${hm}`.replace(/\s+/g, " ").trim();
  }
  if (type === "no_discount") return "Без скидки";
  if (type === "commission" && Number.isFinite(charge) && charge > 0) return `Комиссия ${charge} ₽`;
  return "";
}

function shipmentDeadlineLabel(iso) {
  if (!iso) return "";
  const day = formatMsk(iso, { day: "numeric", month: "short" });
  const hm = formatMsk(iso, { hour: "2-digit", minute: "2-digit" });
  if (!day || !hm) return "";
  return `${day} до ${hm}`.replace(".", "");
}

function mapProduct(raw) {
  const qty = Number(raw.quantity) || 0;
  const price = Number(raw.price);
  return {
    offerId: raw.offer_id || "",
    name: raw.name || "",
    sku: raw.sku || null,
    quantity: qty,
    price: Number.isFinite(price) ? price : 0,
    currency: raw.currency_code || "RUB",
  };
}

function mapPosting(raw) {
  const method = raw.delivery_method || {};
  const products = Array.isArray(raw.products) ? raw.products.map(mapProduct) : [];
  const price = products.reduce((sum, p) => sum + p.price * (p.quantity || 1), 0);
  const quantity = products.reduce((sum, p) => sum + (p.quantity || 0), 0);
  return {
    postingNumber: raw.posting_number || "",
    orderNumber: raw.order_number || "",
    status: raw.status || "",
    substatus: raw.substatus || "",
    statusLabel: postingStatusLabel(raw.status, raw.substatus),
    inProcessAt: raw.in_process_at || "",
    shipmentDate: raw.shipment_date || "",
    shipmentDateWithoutDelay: raw.shipment_date_without_delay || "",
    shipmentDeadlineLabel: shipmentDeadlineLabel(raw.shipment_date_without_delay || raw.shipment_date),
    trackingNumber: raw.tracking_number || "",
    warehouse: method.warehouse || "",
    deliveryMethodName: method.name || "",
    deliveryService: [method.tpl_provider, String(method.name || "").split(",").pop()?.trim()]
      .filter((v, i, arr) => v && arr.indexOf(v) === i)
      .join(", "),
    tariffLabel: tariffLabel(raw),
    products,
    quantity,
    price,
  };
}

async function fetchPostingsByStatus(status, sinceIso, toIso) {
  const list = [];
  let offset = 0;
  for (let page = 0; page < 20; page += 1) {
    const data = await ozonSellerPost("/v3/posting/fbs/list", {
      limit: POSTING_LIMIT,
      offset,
      dir: "ASC",
      filter: {
        since: sinceIso,
        to: toIso,
        status,
      },
    });
    const chunk = Array.isArray(data.result?.postings) ? data.result.postings : [];
    list.push(...chunk);
    if (!data.result?.has_next || chunk.length === 0) break;
    offset += chunk.length;
  }
  return list;
}

export async function loadOzonFbsAwaitingPostings() {
  if (!ozonSellerConfigured()) {
    throw new Error(
      "Ozon Seller API не настроен. Укажите OZON_SELLER_CLIENT_ID и OZON_SELLER_API_KEY в dashboard/.env"
    );
  }
  const to = new Date();
  const from = addDays(startOfLocalDay(to), -(POSTING_LOOKBACK_DAYS - 1));
  const sinceIso = new Date(from.getFullYear(), from.getMonth(), from.getDate()).toISOString();
  const toIso = to.toISOString();
  const seen = new Set();
  const raw = [];
  for (const status of AWAITING_STATUSES) {
    const chunk = await fetchPostingsByStatus(status, sinceIso, toIso);
    for (const posting of chunk) {
      const id = posting?.posting_number;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      raw.push(posting);
    }
  }
  const postings = raw.map(mapPosting).sort((a, b) => {
    const da = a.inProcessAt || "";
    const db = b.inProcessAt || "";
    return da.localeCompare(db) || String(a.postingNumber).localeCompare(String(b.postingNumber));
  });
  return {
    period: { from: ymd(from), to: ymd(startOfLocalDay(to)) },
    postings,
    count: postings.length,
  };
}

function mapAct(raw) {
  const docs = raw.related_docs || {};
  return {
    id: raw.id,
    status: raw.status || "",
    statusLabel: statusLabel(raw.status),
    deliveryMethodId: raw.delivery_method_id || null,
    deliveryMethodName: raw.delivery_method_name || "",
    integrationType: raw.integration_type || "",
    containersCount: Number(raw.containers_count) || 0,
    departureDate: raw.departure_date || "",
    createdAt: raw.created_at || "",
    updatedAt: raw.updated_at || "",
    actType: raw.act_type || "",
    actTypeLabel: actTypeLabel(raw.act_type),
    isPartial: Boolean(raw.is_partial),
    hasPostingsForNextCarriage: Boolean(raw.has_postings_for_next_carriage),
    partialNum: Number(raw.partial_num) || 0,
    relatedDocs: {
      acceptance: docs.act_of_acceptance || null,
      mismatch: docs.act_of_mismatch || null,
      excess: docs.act_of_excess || null,
    },
  };
}

function daySpan(fromDate, toDate) {
  return Math.round((toDate - fromDate) / 86400000) + 1;
}

async function fetchActsInRange(fromDate, toDate, seen, list, depth = 0) {
  if (fromDate > toDate) return;
  const data = await ozonSellerPost("/v2/posting/fbs/act/list", {
    limit: LIMIT,
    filter: {
      date_from: ymd(fromDate),
      date_to: ymd(toDate),
    },
  });
  const chunk = Array.isArray(data.result) ? data.result : [];
  const days = daySpan(fromDate, toDate);
  if (chunk.length >= LIMIT && days > 1 && depth < 8) {
    const mid = addDays(fromDate, Math.floor(days / 2) - 1);
    await fetchActsInRange(fromDate, mid, seen, list, depth + 1);
    await fetchActsInRange(addDays(mid, 1), toDate, seen, list, depth + 1);
    return;
  }
  for (const act of chunk) {
    const id = act?.id;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    list.push(act);
  }
}

export async function loadOzonFbsOpenActs({ days } = {}) {
  if (!ozonSellerConfigured()) {
    throw new Error(
      "Ozon Seller API не настроен. Укажите OZON_SELLER_CLIENT_ID и OZON_SELLER_API_KEY в dashboard/.env"
    );
  }
  const lookback = Number(days);
  const windowDays =
    Number.isFinite(lookback) && lookback > 0 ? Math.min(Math.floor(lookback), 180) : LOOKBACK_DAYS;
  const to = startOfLocalDay();
  const from = addDays(to, -(windowDays - 1));
  const seen = new Set();
  const list = [];
  let cursorTo = to;
  while (cursorTo >= from) {
    const chunkFrom = addDays(cursorTo, -29);
    const rangeFrom = chunkFrom < from ? from : chunkFrom;
    await fetchActsInRange(rangeFrom, cursorTo, seen, list);
    cursorTo = addDays(rangeFrom, -1);
  }
  const acts = list.filter(isOpenAct).map(mapAct).sort((a, b) => {
    const da = a.departureDate || a.createdAt || "";
    const db = b.departureDate || b.createdAt || "";
    return db.localeCompare(da) || Number(b.id) - Number(a.id);
  });
  return {
    generatedAt: new Date().toISOString(),
    period: { from: ymd(from), to: ymd(to) },
    totals: {
      open: acts.length,
      fetched: list.length,
    },
    acts,
    note:
      "Незакрытые акты ФБС из /v2/posting/fbs/act/list. Закрытые и отменённые скрыты. " +
      "Период — последние " +
      windowDays +
      " дней (ограничение метода по дате).",
  };
}

export async function loadOzonFbsDashboard({ days } = {}) {
  const [actsReport, awaiting] = await Promise.all([
    loadOzonFbsOpenActs({ days }),
    loadOzonFbsAwaitingPostings(),
  ]);
  return {
    ...actsReport,
    postings: awaiting.postings,
    postingPeriod: awaiting.period,
    totals: {
      ...actsReport.totals,
      awaiting: awaiting.count,
    },
    postingNote:
      "Отправления в статусе «ожидают отгрузки» (awaiting_deliver) из /v3/posting/fbs/list. " +
      "Тот же список, что вкладка «Ожидают отгрузки» в кабинете продавца.",
  };
}
