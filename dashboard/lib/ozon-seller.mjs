import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];
const API = "https://api-seller.ozon.ru";
/** Не чаще одного запроса в секунду: часть методов Seller API (акты FBS) режет чаще. */
const MIN_GAP_MS = 1200;
const RATE_RETRIES = 6;

let requestChain = Promise.resolve();
let nextSlotAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimit(status, data, text) {
  if (status === 429) return true;
  const msg = String(data?.message || data?.error || data?.code || text || "").toLowerCase();
  return msg.includes("rate limit") || msg.includes("too many requests");
}

function readLocalEnvMap() {
  const values = {};
  for (const file of localEnvPaths) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const text = line.trim();
      if (!text || text.startsWith("#")) continue;
      const eq = text.indexOf("=");
      if (eq < 1) continue;
      const key = text.slice(0, eq).trim();
      let val = text.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (values[key] == null || values[key] === "") values[key] = val;
    }
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

export function ozonSellerCredentials() {
  const clientId = env("OZON_SELLER_CLIENT_ID") || env("OZON_CLIENT_ID");
  const apiKey = env("OZON_SELLER_API_KEY") || env("OZON_API_KEY");
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

export function ozonSellerConfigured() {
  return Boolean(ozonSellerCredentials());
}

async function ozonSellerPostOnce(url, cred, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Client-Id": cred.clientId,
      "Api-Key": cred.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Ozon Seller API: не JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  return { ok: res.ok, status: res.status, data, text, retryAfter: res.headers.get("retry-after") };
}

/**
 * POST к Seller API. Секрет не логировать.
 * Запросы идут по одному, с паузой. При лимите в секунду — пауза и повтор.
 * @param {string} path
 * @param {object} body
 */
export async function ozonSellerPost(path, body = {}) {
  const cred = ozonSellerCredentials();
  if (!cred) {
    throw new Error(
      "Ozon Seller API не настроен. Укажите OZON_SELLER_CLIENT_ID и OZON_SELLER_API_KEY в dashboard/.env"
    );
  }
  const url = path.startsWith("http") ? path : `${API}${path.startsWith("/") ? path : `/${path}`}`;
  const run = async () => {
    let pause = 20000;
    for (let attempt = 0; attempt <= RATE_RETRIES; attempt += 1) {
      const wait = Math.max(0, nextSlotAt - Date.now());
      if (wait) await sleep(wait);
      nextSlotAt = Date.now() + MIN_GAP_MS;
      const result = await ozonSellerPostOnce(url, cred, body);
      if (result.ok) return result.data;
      if (isRateLimit(result.status, result.data, result.text) && attempt < RATE_RETRIES) {
        const retryAfterSec = Number(result.retryAfter);
        const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : pause;
        nextSlotAt = Date.now() + delay;
        console.warn(`Ozon Seller API: лимит, повтор ${attempt + 1}/${RATE_RETRIES} через ${delay} мс (${path})`);
        await sleep(delay);
        pause = Math.min(pause * 2, 60000);
        continue;
      }
      const msg = result.data.message || result.data.error || result.data.code || result.text.slice(0, 280);
      throw new Error(`Ozon Seller API: ${msg} [${path}]`);
    }
    throw new Error("Ozon Seller API: не удалось выполнить запрос");
  };
  const queued = requestChain.then(run, run);
  requestChain = queued.then(
    () => {},
    () => {}
  );
  return queued;
}
