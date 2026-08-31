import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];
const MARKETPLACE = "https://marketplace-api.wildberries.ru";

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

export function wbApiToken() {
  return env("WB_API_TOKEN") || env("WILDBERRIES_API_TOKEN") || "";
}

export function wbSellerConfigured() {
  return Boolean(wbApiToken());
}

/**
 * Запрос к Marketplace API WB. Токен не логировать.
 * @param {string} path
 * @param {{ method?: string, body?: object, query?: Record<string, string|number> }} [opts]
 */
export async function wbMarketplace(path, opts = {}) {
  const token = wbApiToken();
  if (!token) {
    throw new Error("Wildberries API не настроен. Укажите WB_API_TOKEN в dashboard/.env");
  }
  const url = new URL(path.startsWith("http") ? path : `${MARKETPLACE}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts.query || {})) {
    if (v == null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetch(url, {
      method: opts.method || "GET",
      headers: {
        Authorization: token,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Wildberries API: не JSON (${res.status}) ${text.slice(0, 200)}`);
    }
    if (res.status === 429 && attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    if (!res.ok) {
      const msg = data.message || data.title || data.detail || data.code || text.slice(0, 280);
      throw new Error(`Wildberries API: ${msg}`);
    }
    return data;
  }
  throw new Error("Wildberries API: слишком много запросов");
}

export async function wbPing() {
  return wbMarketplace("/ping");
}
