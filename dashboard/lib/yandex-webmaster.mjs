import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];
const API = "https://api.webmaster.yandex.net/v4";

function readLocalEnvMap() {
  const localEnvPath = localEnvPaths.find((p) => existsSync(p));
  if (!localEnvPath) return {};
  const values = {};
  for (const line of readFileSync(localEnvPath, "utf8").split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 1) continue;
    const key = text.slice(0, eq).trim();
    let val = text.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    values[key] = val;
  }
  return values;
}

function env(key) {
  const fromProc = process.env[key];
  if (fromProc != null && String(fromProc).trim() !== "") return String(fromProc).trim();
  const local = readLocalEnvMap();
  const v = local[key];
  return v != null && String(v).trim() !== "" ? String(v).trim() : "";
}

export function yandexWebmasterToken() {
  const token = env("YANDEX_WEBMASTER_TOKEN") || env("YANDEX_WEBMASTER_OAUTH_TOKEN");
  if (!token) {
    throw new Error(
      "Нет токена Яндекс.Вебмастера. Укажите YANDEX_WEBMASTER_TOKEN в dashboard/.env"
    );
  }
  return token;
}

export function yandexConfigured() {
  try {
    yandexWebmasterToken();
    return true;
  } catch {
    return false;
  }
}

/** Host id из env (через запятую) или пустой список — тогда берём все из API. */
export function yandexHostIdsFromEnv() {
  const multi = env("YANDEX_WEBMASTER_HOST_IDS") || env("YANDEX_WEBMASTER_HOST_ID");
  return [...new Set(multi.split(/[,;]+/).map((s) => s.trim()).filter(Boolean))];
}

async function ywFetch(path, query = {}) {
  const token = yandexWebmasterToken();
  const url = new URL(path.startsWith("http") ? path : `${API}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Яндекс.Вебмастер: не JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = data.error_message || data.message || data.error_code || text.slice(0, 280);
    throw new Error(`Яндекс.Вебмастер: ${msg}`);
  }
  return data;
}

let cachedUserId = "";

export async function yandexUserId() {
  if (cachedUserId) return cachedUserId;
  const fromEnv = env("YANDEX_WEBMASTER_USER_ID");
  if (fromEnv) {
    cachedUserId = fromEnv;
    return cachedUserId;
  }
  const data = await ywFetch("/user");
  const id = data.user_id ?? data.userId;
  if (id == null) throw new Error("Яндекс.Вебмастер: не удалось получить user_id");
  cachedUserId = String(id);
  return cachedUserId;
}

export async function yandexListHosts() {
  const userId = await yandexUserId();
  const data = await ywFetch(`/user/${userId}/hosts`);
  return Array.isArray(data.hosts) ? data.hosts : [];
}

export async function yandexResolveHostIds() {
  const fromEnv = yandexHostIdsFromEnv();
  if (fromEnv.length) return fromEnv;
  const hosts = await yandexListHosts();
  return hosts
    .filter((h) => h.verified !== false)
    .map((h) => h.host_id || h.hostId)
    .filter(Boolean);
}

/**
 * Агрегированный тренд по сайту (показы/клики/позиции по дням).
 * @param {string} hostId
 * @param {string} dateFrom YYYY-MM-DD
 * @param {string} dateTo YYYY-MM-DD
 */
export async function yandexQueryHistory(hostId, dateFrom, dateTo) {
  const userId = await yandexUserId();
  const encHost = encodeURIComponent(hostId);
  return ywFetch(`/user/${userId}/hosts/${encHost}/search-queries/all/history`, {
    date_from: dateFrom,
    date_to: dateTo,
    query_indicator: ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION", "AVG_CLICK_POSITION"],
  });
}

/**
 * Популярные запросы за период.
 */
export async function yandexPopularQueries(hostId, dateFrom, dateTo, opts = {}) {
  const userId = await yandexUserId();
  const encHost = encodeURIComponent(hostId);
  const limit = Math.min(Number(opts.limit) || 100, 500);
  return ywFetch(`/user/${userId}/hosts/${encHost}/search-queries/popular`, {
    date_from: dateFrom,
    date_to: dateTo,
    order_by: opts.orderBy || "TOTAL_CLICKS",
    limit,
    offset: Number(opts.offset) || 0,
    device_type_indicator: opts.deviceType || "ALL",
    query_indicator: ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION", "AVG_CLICK_POSITION"],
  });
}
