import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];

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

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function loadServiceAccount() {
  const rawJson = env("GSC_CREDENTIALS_JSON");
  if (rawJson && rawJson.startsWith("{")) {
    return JSON.parse(rawJson);
  }
  const pathRaw = env("GSC_CREDENTIALS_PATH") || rawJson;
  if (!pathRaw) {
    throw new Error(
      "Нет ключа Google Search Console. Укажите GSC_CREDENTIALS_PATH (JSON service account) в dashboard/.env"
    );
  }
  const path = isAbsolute(pathRaw) ? pathRaw : resolve(dashboardDir, pathRaw);
  if (!existsSync(path)) throw new Error(`Файл ключа GSC не найден: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

let cachedToken = { accessToken: "", exp: 0 };

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.accessToken && cachedToken.exp > now + 60) return cachedToken.accessToken;

  const sa = loadServiceAccount();
  const clientEmail = sa.client_email;
  const privateKey = String(sa.private_key || "").replace(/\\n/g, "\n");
  if (!clientEmail || !privateKey) throw new Error("В JSON GSC нет client_email или private_key");

  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: clientEmail,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  );
  const unsigned = `${header}.${claim}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = b64url(signer.sign(privateKey));
  const assertion = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`GSC OAuth: ${data.error_description || data.error || res.status}`);
  }
  cachedToken = {
    accessToken: data.access_token,
    exp: now + Number(data.expires_in || 3600),
  };
  return cachedToken.accessToken;
}

/** Сайты из GSC_SITE_URL / GSC_SITE_URLS (через запятую). */
export function gscSiteUrls() {
  const multi = env("GSC_SITE_URLS");
  const single = env("GSC_SITE_URL");
  const list = (multi || single || "")
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

export function gscConfigured() {
  try {
    loadServiceAccount();
    return gscSiteUrls().length > 0;
  } catch {
    return false;
  }
}

/**
 * Search Analytics query.
 * @param {string} siteUrl
 * @param {{ startDate: string, endDate: string, dimensions?: string[], rowLimit?: number, startRow?: number }} opts
 */
export async function gscSearchAnalytics(siteUrl, opts) {
  const token = await getAccessToken();
  const site = encodeURIComponent(siteUrl);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${site}/searchAnalytics/query`;
  const body = {
    startDate: opts.startDate,
    endDate: opts.endDate,
    dimensions: opts.dimensions || ["date"],
    rowLimit: Math.min(Number(opts.rowLimit) || 25000, 25000),
    startRow: Number(opts.startRow) || 0,
    searchType: opts.searchType || "web",
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GSC: не JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`GSC ${siteUrl}: ${data.error?.message || text.slice(0, 280)}`);
  }
  return data;
}

/** Все страницы searchAnalytics. */
export async function gscSearchAnalyticsAll(siteUrl, opts) {
  const rows = [];
  let startRow = 0;
  const pageSize = Math.min(Number(opts.rowLimit) || 25000, 25000);
  for (let page = 0; page < 40; page += 1) {
    const data = await gscSearchAnalytics(siteUrl, { ...opts, rowLimit: pageSize, startRow });
    const chunk = Array.isArray(data.rows) ? data.rows : [];
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    startRow += chunk.length;
  }
  return rows;
}
