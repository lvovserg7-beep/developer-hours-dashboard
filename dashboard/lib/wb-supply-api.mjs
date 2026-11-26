/**
 * Источники данных WB для доски «Расчёт поставки ВБ» (по ТЗ и dev.wildberries.ru).
 *  - статистика: заказы             GET  statistics-api   /api/v1/supplier/orders            (1 запрос/мин)
 *  - аналитика:  остатки по складам GET  seller-analytics-api /api/v1/warehouse_remains      (задача → статус → файл)
 *  - поставки:   список и товары    supplies-api          /api/v1/supplies …                 (30 запросов/мин)
 *  - контент:    карточки           POST content-api      /content/v2/get/cards/list         (названия по артикулу)
 * Токен в логи и ответы не пишем.
 */

import { wbApiToken } from "./wb-seller.mjs";

const HOST = {
  statistics: "https://statistics-api.wildberries.ru",
  analytics: "https://seller-analytics-api.wildberries.ru",
  supplies: "https://supplies-api.wildberries.ru",
  content: "https://content-api.wildberries.ru",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireToken() {
  const token = wbApiToken();
  if (!token) throw new Error("Wildberries API не настроен. Укажите WB_API_TOKEN в dashboard/.env");
  return token;
}

/**
 * @param {keyof typeof HOST} host
 * @param {string} path
 * @param {{ method?: string, query?: object, body?: object, tries?: number, timeoutMs?: number, wait429Ms?: number, onWait?: (sec:number)=>void }} [opts]
 */
export async function wbRequest(host, path, opts = {}) {
  const token = requireToken();
  const url = new URL(`${HOST[host]}${path}`);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v == null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const tries = opts.tries ?? 4;
  let lastErr = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: opts.method || "GET",
        headers: {
          Authorization: token,
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
      });
    } catch (e) {
      lastErr = new Error(`WB ${host}: ${String(e?.message || e)}`);
      if (attempt < tries) {
        await sleep(3000 * attempt);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("x-ratelimit-retry")) || 0;
      const waitMs = Math.max(retry * 1000, opts.wait429Ms ?? 61000) + 1500;
      lastErr = new Error(`WB ${host}: лимит запросов (429)`);
      if (waitMs > (opts.maxWaitMs ?? 180000)) {
        const err = new Error(
          `WB ограничил запросы к ${host}: повтор возможен через ${Math.ceil(waitMs / 60000)} мин.`,
        );
        err.rateLimitedUntil = Date.now() + waitMs;
        throw err;
      }
      if (attempt < tries) {
        opts.onWait?.(Math.round(waitMs / 1000));
        await sleep(waitMs);
        continue;
      }
      throw lastErr;
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`WB ${host}: нет доступа (${res.status}). Проверьте категории токена WB_API_TOKEN.`);
    }
    if (res.status >= 500 && attempt < tries) {
      await sleep(4000 * attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`WB ${host} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`WB ${host} ${path}: ответ не JSON`);
    }
  }
  throw lastErr || new Error(`WB ${host}: запрос не выполнен`);
}

/**
 * Заказы с даты (по дате последнего изменения). flag=0 — инкремент по lastChangeDate.
 * @param {string} dateFrom  YYYY-MM-DD или RFC3339 без зоны (МСК)
 * @param {{ onWait?: (sec:number)=>void }} [opts]
 */
export async function fetchWbOrders(dateFrom, opts = {}) {
  const all = [];
  let from = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? `${dateFrom}T00:00:00` : dateFrom;
  for (let page = 0; page < 20; page++) {
    const rows = await wbRequest("statistics", "/api/v1/supplier/orders", {
      query: { dateFrom: from, flag: 0 },
      onWait: opts.onWait,
    });
    const list = Array.isArray(rows) ? rows : [];
    all.push(...list);
    if (list.length < 79000) break;
    from = String(list[list.length - 1].lastChangeDate || "").slice(0, 19);
    if (!from) break;
    await sleep(62000);
  }
  return all;
}

/** Строка заказа → компактный вид для снимка. */
export function compactOrder(row) {
  return {
    d: String(row.date || "").slice(0, 10),
    a: String(row.supplierArticle || "").trim(),
    n: Number(row.nmId) || 0,
    o: String(row.oblastOkrugName || "").trim(),
    w: String(row.warehouseType || "").includes("продавца") ? "S" : "W",
    x: row.isCancel ? 1 : 0,
    l: String(row.lastChangeDate || "").slice(0, 19),
  };
}

/**
 * Остатки по складам WB. Асинхронная задача: создать → ждать → скачать.
 * @param {{ onStep?: (text:string)=>void }} [opts]
 * @returns {Promise<Record<string, { nm: number, wh: Record<string, number>, returns: number, toCustomers: number, total: number }>>}
 */
export async function fetchWbWarehouseRemains(opts = {}) {
  const created = await wbRequest("analytics", "/api/v1/warehouse_remains", {
    query: { groupByNm: "true", groupBySa: "true", groupByBarcode: "true" },
    onWait: (s) => opts.onStep?.(`лимит WB, ждём ${s} с`),
  });
  const taskId = created?.data?.taskId;
  if (!taskId) throw new Error("WB остатки: не получен taskId");
  const started = Date.now();
  let status = "";
  while (Date.now() - started < 8 * 60 * 1000) {
    await sleep(6000);
    const st = await wbRequest("analytics", `/api/v1/warehouse_remains/tasks/${encodeURIComponent(taskId)}/status`, {
      onWait: (s) => opts.onStep?.(`лимит WB, ждём ${s} с`),
    });
    status = String(st?.data?.status || "");
    opts.onStep?.(`отчёт по остаткам: ${status || "…"}`);
    if (status === "done") break;
    if (status === "purged" || status === "canceled") throw new Error(`WB остатки: задача ${status}`);
  }
  if (status !== "done") throw new Error("WB остатки: отчёт не сформирован за 8 минут");
  const rows = await wbRequest("analytics", `/api/v1/warehouse_remains/tasks/${encodeURIComponent(taskId)}/download`, {
    onWait: (s) => opts.onStep?.(`лимит WB, ждём ${s} с`),
  });
  return aggregateWarehouseRemains(Array.isArray(rows) ? rows : []);
}

export function aggregateWarehouseRemains(rows) {
  const out = {};
  for (const row of rows) {
    const article = String(row.vendorCode || "").trim();
    if (!article) continue;
    const cur = (out[article] ||= { nm: Number(row.nmId) || 0, wh: {}, returns: 0, toCustomers: 0, total: 0 });
    for (const w of row.warehouses || []) {
      const name = String(w.warehouseName || "").trim();
      const qty = Number(w.quantity) || 0;
      if (!name) continue;
      if (name === "В пути до получателей") cur.toCustomers += qty;
      else if (name === "В пути возвраты на склад WB") cur.returns += qty;
      else if (name === "Всего находится на складах") cur.total += qty;
      else cur.wh[name] = (cur.wh[name] || 0) + qty;
    }
  }
  return out;
}

/**
 * Активные поставки (статусы 2–4) со складами и товарами.
 * Лимит API — 30 запросов в минуту, держим интервал ~2,2 с.
 * @param {{ today: string, onStep?: (text:string)=>void }} opts
 */
export async function fetchWbActiveSupplies(opts) {
  const gap = 2200;
  const today = opts.today;
  const till = today;
  const fromDate = new Date(`${today}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - 120);
  const from = fromDate.toISOString().slice(0, 10);

  const list = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const page = await wbRequest("supplies", "/api/v1/supplies", {
      method: "POST",
      query: { limit: 1000, offset },
      body: { dates: [{ from, till, type: "createDate" }], statusIDs: [2, 3, 4] },
      wait429Ms: 30000,
    });
    if (page != null && !Array.isArray(page)) {
      throw new Error(`WB поставки: неожиданный ответ (${Object.keys(page).slice(0, 5).join(", ")})`);
    }
    const items = Array.isArray(page) ? page : [];
    list.push(...items);
    await sleep(gap);
    if (items.length < 1000) break;
  }

  const out = [];
  let n = 0;
  for (const s of list) {
    n += 1;
    const preorder = s.supplyID == null;
    const id = preorder ? s.preorderID : s.supplyID;
    if (id == null) continue;
    opts.onStep?.(`поставки WB: ${n} из ${list.length}`);
    const details = await wbRequest("supplies", `/api/v1/supplies/${id}`, {
      query: { isPreorderID: preorder },
      wait429Ms: 30000,
    });
    await sleep(gap);
    const items = [];
    for (let offset = 0; offset < 100000; offset += 1000) {
      const goods = await wbRequest("supplies", `/api/v1/supplies/${id}/goods`, {
        query: { limit: 1000, offset, isPreorderID: preorder },
        wait429Ms: 30000,
      });
      const rows = Array.isArray(goods) ? goods : [];
      for (const g of rows) {
        const a = String(g.vendorCode || "").trim();
        if (!a) continue;
        items.push({
          a,
          q: Number(g.quantity) || 0,
          acc: Number(g.acceptedQuantity) || 0,
        });
      }
      await sleep(gap);
      if (rows.length < 1000) break;
    }
    out.push({
      id: String(id),
      preorder,
      status: Number(s.statusID ?? details?.statusID) || 0,
      warehouse: String(details?.actualWarehouseName || details?.warehouseName || s.warehouseName || "").trim(),
      createDate: String(s.createDate || details?.createDate || "").slice(0, 10),
      supplyDate: String(s.supplyDate || details?.supplyDate || "").slice(0, 10),
      items,
    });
  }
  return out;
}

/** Названия карточек: vendorCode → title. */
export async function fetchWbCardTitles(opts = {}) {
  const titles = {};
  let cursor = { limit: 100 };
  for (let page = 0; page < 200; page++) {
    const res = await wbRequest("content", "/content/v2/get/cards/list", {
      method: "POST",
      body: { settings: { cursor, filter: { withPhoto: -1 } } },
      wait429Ms: 10000,
    });
    const cards = res?.cards || [];
    for (const c of cards) {
      const a = String(c.vendorCode || "").trim();
      if (a) titles[a] = String(c.title || c.subjectName || "").trim();
    }
    const total = Number(res?.cursor?.total) || 0;
    opts.onStep?.(`карточки: ${Object.keys(titles).length}`);
    if (total < 100 || !cards.length) break;
    cursor = { limit: 100, updatedAt: res.cursor.updatedAt, nmID: res.cursor.nmID };
    await sleep(700);
  }
  return titles;
}
