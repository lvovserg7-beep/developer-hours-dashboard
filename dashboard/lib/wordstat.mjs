/**
 * Частота запросов Яндекс.Wordstat (v2 через Yandex Cloud Search API).
 * Нужны: YANDEX_WORDSTAT_API_KEY (или YANDEX_SEARCH_API_KEY) + YANDEX_FOLDER_ID.
 * Опционально legacy: YANDEX_WORDSTAT_TOKEN → api.wordstat.yandex.net (если доступ ещё есть).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];
const CLOUD_BASE = "https://searchapi.api.cloud.yandex.net";
const LEGACY_BASE = "https://api.wordstat.yandex.net";

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

function toInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const n = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function wordstatConfigured() {
  const apiKey = env("YANDEX_WORDSTAT_API_KEY") || env("YANDEX_SEARCH_API_KEY");
  const folderId = env("YANDEX_WORDSTAT_FOLDER_ID") || env("YANDEX_FOLDER_ID");
  if (apiKey && folderId) return true;
  if (env("YANDEX_WORDSTAT_TOKEN")) return true;
  return false;
}

function cloudCredentials() {
  const apiKey = env("YANDEX_WORDSTAT_API_KEY") || env("YANDEX_SEARCH_API_KEY");
  const folderId = env("YANDEX_WORDSTAT_FOLDER_ID") || env("YANDEX_FOLDER_ID");
  if (!apiKey || !folderId) return null;
  return { apiKey, folderId };
}

/** Точная частотность: фраза в кавычках Wordstat. */
export function wordstatExactPhrase(query) {
  const q = String(query || "").trim().replaceAll('"', "");
  if (!q) return "";
  return `"${q}"`;
}

async function fetchCloudTop(phrase) {
  const cred = cloudCredentials();
  if (!cred) throw new Error("Wordstat Cloud не настроен (API key + folderId)");
  const res = await fetch(`${CLOUD_BASE}/v2/wordstat/topRequests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Api-Key ${cred.apiKey}`,
    },
    body: JSON.stringify({
      folderId: cred.folderId,
      phrase,
      numPhrases: 50,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Wordstat Cloud: не JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Wordstat Cloud ${res.status}: ${data.message || data.error || text.slice(0, 280)}`);
  }
  return data;
}

async function fetchLegacyTop(phrase) {
  const token = env("YANDEX_WORDSTAT_TOKEN");
  if (!token) throw new Error("Нет YANDEX_WORDSTAT_TOKEN");
  const res = await fetch(`${LEGACY_BASE}/v1/topRequests`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ phrase }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Wordstat legacy: не JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`Wordstat legacy ${res.status}: ${data.message || data.error_code || text.slice(0, 280)}`);
  }
  return data;
}

/**
 * Частота фразы за ~30 дней (Wordstat).
 * @returns {Promise<{ frequency: number, backend: string }>}
 */
export async function fetchWordstatFrequency(query) {
  const raw = String(query || "").trim();
  if (!raw) return { frequency: 0, backend: "none" };
  const phrase = wordstatExactPhrase(raw);
  const data = cloudCredentials()
    ? await fetchCloudTop(phrase)
    : await fetchLegacyTop(phrase);

  const results = data.results || data.topRequests || data.requestInfo?.topRequests || [];
  const needle = raw.toLowerCase();
  const exact = results.find((r) => String(r.phrase || r.queryText || "").trim().toLowerCase() === needle);
  if (exact) {
    return {
      frequency: toInt(exact.count ?? exact.number),
      backend: cloudCredentials() ? "cloud" : "legacy",
    };
  }
  // Для фразы в кавычках totalCount обычно и есть точная частотность.
  const total = toInt(data.totalCount ?? data.total_count);
  return {
    frequency: total,
    backend: cloudCredentials() ? "cloud" : "legacy",
  };
}
