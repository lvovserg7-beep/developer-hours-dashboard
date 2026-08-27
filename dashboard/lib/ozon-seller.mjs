import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];
const API = "https://api-seller.ozon.ru";

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

/**
 * POST к Seller API. Секрет не логировать.
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
  if (!res.ok) {
    const msg = data.message || data.error || data.code || text.slice(0, 280);
    throw new Error(`Ozon Seller API: ${msg}`);
  }
  return data;
}
