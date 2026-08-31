import { wbMarketplace, wbSellerConfigured } from "./wb-seller.mjs";

/** Окно для закрытых поставок в статусе «сортируются». */
const SORTING_LOOKBACK_DAYS = 14;
/** Глубина карточек заданий; WB принимает не больше 30 дней за один запрос. */
const ORDERS_LOOKBACK_DAYS = 90;
const ORDERS_WINDOW_DAYS = 30;
const SUPPLY_PAGE = 1000;
const STATUS_CHUNK = 200;
const SLEEP_MS = 220;

/** Статусы WB «после» сортировки — такие поставки в блок «Сортируются» не берём, если их больше, чем sorted. */
const WB_AFTER_SORTING = new Set([
  "sold",
  "ready_for_pickup",
  "accepted_by_carrier",
  "sent_to_carrier",
  "postponed_delivery",
]);

const WB_STATUS_RU = {
  waiting: "Ожидает",
  sorted: "Сортируется",
  sold: "Продано",
  canceled: "Отменён",
  canceled_by_client: "Отменён покупателем",
  declined_by_client: "Отклонён покупателем",
  defect: "Брак",
  ready_for_pickup: "Готов к выдаче",
  postponed_delivery: "Доставка отложена",
  accepted_by_carrier: "Принят перевозчиком",
  sent_to_carrier: "Передан перевозчику",
};

const SUPPLIER_STATUS_RU = {
  new: "Новое",
  confirm: "На сборке",
  complete: "В доставке",
  cancel: "Отменено",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatMsk(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function rubFromWb(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / 100;
}

function wbStatusLabel(status) {
  const key = String(status || "").trim().toLowerCase();
  return WB_STATUS_RU[key] || status || "—";
}

function supplierStatusLabel(status) {
  const key = String(status || "").trim().toLowerCase();
  return SUPPLIER_STATUS_RU[key] || status || "—";
}

function withinLookback(iso, days) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t <= days * 24 * 60 * 60 * 1000;
}

async function listAllSupplies() {
  const out = [];
  let next = 0;
  for (let page = 0; page < 40; page += 1) {
    const data = await wbMarketplace("/api/v3/supplies", {
      query: { limit: SUPPLY_PAGE, next },
    });
    const chunk = Array.isArray(data.supplies) ? data.supplies : [];
    out.push(...chunk);
    next = data.next;
    if (next == null || next === 0 || !chunk.length) break;
    await sleep(SLEEP_MS);
  }
  return out;
}

async function supplyOrderIds(supplyId) {
  const data = await wbMarketplace(
    `/api/marketplace/v3/supplies/${encodeURIComponent(supplyId)}/order-ids`
  );
  return Array.isArray(data.orderIds) ? data.orderIds.map(Number).filter((n) => Number.isFinite(n)) : [];
}

async function fetchOrderStatuses(orderIds) {
  /** @type {Map<number, { id: number, supplierStatus: string, wbStatus: string }>} */
  const map = new Map();
  for (let i = 0; i < orderIds.length; i += STATUS_CHUNK) {
    const chunk = orderIds.slice(i, i + STATUS_CHUNK);
    if (!chunk.length) continue;
    const data = await wbMarketplace("/api/v3/orders/status", {
      method: "POST",
      body: { orders: chunk },
    });
    for (const row of data.orders || []) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      map.set(id, {
        id,
        supplierStatus: String(row.supplierStatus || ""),
        wbStatus: String(row.wbStatus || ""),
      });
    }
    if (i + STATUS_CHUNK < orderIds.length) await sleep(SLEEP_MS);
  }
  return map;
}

function orderDateWindows(lookbackDays = ORDERS_LOOKBACK_DAYS) {
  const nowSec = Math.floor(Date.now() / 1000);
  const oldest = nowSec - lookbackDays * 24 * 3600;
  const windowSec = ORDERS_WINDOW_DAYS * 24 * 3600;
  const windows = [];
  for (let to = nowSec; to > oldest; to -= windowSec) {
    const from = Math.max(oldest, to - windowSec);
    windows.push({ dateFrom: from, dateTo: to });
    if (from <= oldest) break;
  }
  return windows;
}

async function fetchOrdersById(neededIds) {
  /** @type {Map<number, object>} */
  const map = new Map();
  if (!neededIds.size) return map;

  try {
    const neu = await wbMarketplace("/api/v3/orders/new");
    for (const o of neu.orders || []) {
      const id = Number(o.id);
      if (neededIds.has(id)) map.set(id, o);
    }
  } catch {
    // new — опционально
  }

  for (const { dateFrom, dateTo } of orderDateWindows()) {
    if (map.size >= neededIds.size) break;
    let next = 0;
    for (let page = 0; page < 40; page += 1) {
      const data = await wbMarketplace("/api/v3/orders", {
        query: { limit: 1000, next, dateFrom, dateTo },
      });
      const orders = Array.isArray(data.orders) ? data.orders : [];
      for (const o of orders) {
        const id = Number(o.id);
        if (neededIds.has(id)) map.set(id, o);
      }
      next = data.next;
      if (map.size >= neededIds.size) break;
      if (next == null || next === 0 || !orders.length) break;
      await sleep(SLEEP_MS);
    }
    await sleep(SLEEP_MS);
  }
  return map;
}

function mapOrderLine(raw, status) {
  const price = rubFromWb(raw?.finalPrice ?? raw?.price);
  const salePrice = rubFromWb(raw?.salePrice);
  return {
    id: Number(raw?.id) || Number(status?.id) || 0,
    article: String(raw?.article || ""),
    nmId: raw?.nmId != null ? Number(raw.nmId) : null,
    skus: Array.isArray(raw?.skus) ? raw.skus.map(String) : [],
    price,
    salePrice,
    createdAt: raw?.createdAt || "",
    createdAtLabel: formatMsk(raw?.createdAt),
    warehouseId: raw?.warehouseId != null ? Number(raw.warehouseId) : null,
    officeId: raw?.officeId != null ? Number(raw.officeId) : null,
    supplierStatus: status?.supplierStatus || "",
    supplierStatusLabel: supplierStatusLabel(status?.supplierStatus),
    wbStatus: status?.wbStatus || "",
    wbStatusLabel: wbStatusLabel(status?.wbStatus),
  };
}

/**
 * ready — открытая с waiting.
 * sorting — закрытая, есть sorted, и sorted не меньше статусов «после сортировки» (sold и т.п.).
 */
function classifySupply(supply, orderIds, statusMap) {
  if (!orderIds.length) return null;
  const statuses = orderIds.map((id) => statusMap.get(id)).filter(Boolean);
  const waitingIds = statuses.filter((s) => s.wbStatus === "waiting").map((s) => s.id);
  const sortedIds = statuses.filter((s) => s.wbStatus === "sorted").map((s) => s.id);
  const afterCount = statuses.filter((s) => WB_AFTER_SORTING.has(s.wbStatus)).length;
  const done = supply.done === true;

  if (!done && waitingIds.length) {
    return { kind: "ready", orderIds: waitingIds };
  }
  if (done && sortedIds.length && sortedIds.length >= afterCount) {
    return { kind: "sorting", orderIds: sortedIds };
  }
  return null;
}

function buildSupplyRow(supply, orderIds, statusMap, detailMap) {
  const orders = orderIds.map((id) => mapOrderLine(detailMap.get(id), statusMap.get(id)));
  return {
    id: supply.id,
    name: supply.name || supply.id,
    createdAt: supply.createdAt || "",
    createdAtLabel: formatMsk(supply.createdAt),
    closedAt: supply.closedAt || "",
    closedAtLabel: formatMsk(supply.closedAt),
    scanDt: supply.scanDt || "",
    scanDtLabel: formatMsk(supply.scanDt),
    destinationOfficeId: supply.destinationOfficeId ?? null,
    cargoType: supply.cargoType ?? null,
    done: supply.done === true,
    orderCount: orders.length,
    sortedCount: orders.filter((o) => o.wbStatus === "sorted").length,
    waitingCount: orders.filter((o) => o.wbStatus === "waiting").length,
    orders,
  };
}

/**
 * QR-код поставки (PNG base64). Доступен только после передачи в доставку.
 */
export async function getWbFbsSupplyQr(supplyId, type = "png") {
  if (!wbSellerConfigured()) {
    throw new Error("Wildberries API не настроен. Укажите WB_API_TOKEN в dashboard/.env");
  }
  const id = String(supplyId || "").trim();
  if (!id) throw new Error("Не указан ID поставки");
  const fmt = ["png", "svg", "zplv", "zplh"].includes(String(type)) ? String(type) : "png";
  const data = await wbMarketplace(`/api/v3/supplies/${encodeURIComponent(id)}/barcode`, {
    query: { type: fmt },
  });
  return {
    supplyId: id,
    barcode: String(data.barcode || id),
    type: fmt,
    file: String(data.file || ""),
    mime: fmt === "png" ? "image/png" : fmt === "svg" ? "image/svg+xml" : "application/octet-stream",
  };
}

/**
 * Передать открытую поставку в доставку (для сдачи на ФБС) и вернуть QR.
 */
export async function deliverWbFbsSupplyAndQr(supplyId) {
  if (!wbSellerConfigured()) {
    throw new Error("Wildberries API не настроен. Укажите WB_API_TOKEN в dashboard/.env");
  }
  const id = String(supplyId || "").trim();
  if (!id) throw new Error("Не указан ID поставки");
  await wbMarketplace(`/api/v3/supplies/${encodeURIComponent(id)}/deliver`, { method: "PATCH" });
  await sleep(400);
  const qr = await getWbFbsSupplyQr(id, "png");
  return { delivered: true, ...qr };
}

/**
 * Поставки FBS WB: готовы к отгрузке + сортируются (без «после сортировки»).
 */
export async function loadWbFbsSuppliesReport() {
  if (!wbSellerConfigured()) {
    throw new Error("Wildberries API не настроен. Укажите WB_API_TOKEN в dashboard/.env");
  }

  const supplies = await listAllSupplies();
  const candidates = supplies.filter((s) => {
    if (!s?.id) return false;
    if (s.done !== true) return true;
    return (
      withinLookback(s.scanDt, SORTING_LOOKBACK_DAYS) ||
      withinLookback(s.closedAt, SORTING_LOOKBACK_DAYS)
    );
  });

  /** @type {{ supply: object, orderIds: number[] }[]} */
  const withOrders = [];
  for (const supply of candidates) {
    await sleep(SLEEP_MS);
    const orderIds = await supplyOrderIds(supply.id);
    if (!orderIds.length) continue;
    withOrders.push({ supply, orderIds });
  }

  const allIds = [...new Set(withOrders.flatMap((x) => x.orderIds))];
  const statusMap = await fetchOrderStatuses(allIds);

  /** @type {{ supply: object, kind: string, orderIds: number[] }[]} */
  const classified = [];
  for (const { supply, orderIds } of withOrders) {
    const hit = classifySupply(supply, orderIds, statusMap);
    if (!hit) continue;
    classified.push({ supply, kind: hit.kind, orderIds: hit.orderIds });
  }

  const detailMap = await fetchOrdersById(new Set(classified.flatMap((x) => x.orderIds)));

  const ready = [];
  const sorting = [];
  for (const { supply, kind, orderIds } of classified) {
    const row = buildSupplyRow(supply, orderIds, statusMap, detailMap);
    if (kind === "ready") ready.push(row);
    else sorting.push(row);
  }

  ready.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  sorting.sort((a, b) => String(b.scanDt || b.closedAt).localeCompare(String(a.scanDt || a.closedAt)));

  return {
    generatedAt: new Date().toISOString(),
    source: "Wildberries Marketplace API",
    ready,
    sorting,
    totals: {
      ready: ready.length,
      sorting: sorting.length,
      readyOrders: ready.reduce((n, s) => n + s.orderCount, 0),
      sortingOrders: sorting.reduce((n, s) => n + s.orderCount, 0),
      suppliesSeen: supplies.length,
      candidates: candidates.length,
    },
    note:
      "«Готово к отгрузке» — открытые поставки (waiting). «Сортируются» — недавно сданные, задания только sorted; " +
      "поставки, где уже больше sold / готов к выдаче, не показываем. " +
      "QR-код доступен после передачи в доставку (кнопка у поставки). " +
      "Документация: https://dev.wildberries.ru/docs/openapi/orders-fbs",
  };
}
