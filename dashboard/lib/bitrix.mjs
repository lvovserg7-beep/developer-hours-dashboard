import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];

function readLocalEnvMap() {
  const localEnvPath = localEnvPaths.find((p) => existsSync(p));
  if (!localEnvPath) return null;
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

function normalizeWebhook(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * Базовый URL входящего webhook Bitrix24 (с завершающим `/`).
 * Секрет — часть пути; хранить только в `.env`, не в git.
 */
export function bitrixConfig() {
  const fromEnv = normalizeWebhook(process.env.BITRIX24_WEBHOOK_URL);
  if (fromEnv) {
    return { base: fromEnv, host: new URL(fromEnv).host };
  }
  const local = readLocalEnvMap();
  const fromFile = normalizeWebhook(local?.BITRIX24_WEBHOOK_URL);
  if (fromFile) {
    return { base: fromFile, host: new URL(fromFile).host };
  }
  throw new Error(
    `Нет webhook Bitrix24. Укажите BITRIX24_WEBHOOK_URL в ${join(dashboardDir, ".env")} ` +
      `(образец — .env.example). Формат: https://xxx.bitrix24.ru/rest/{user}/{code}/`
  );
}

/**
 * Вызов метода REST Bitrix24.
 * @param {string} method например `crm.deal.list` или `profile`
 * @param {Record<string, unknown>} [params]
 * @param {{ start?: number }} [opts]
 */
export async function bitrixCall(method, params = {}, opts = {}) {
  const { base } = bitrixConfig();
  const name = String(method || "").replace(/^\//, "").replace(/\.json$/i, "");
  if (!name) throw new Error("Не указан метод Bitrix24");

  const url = new URL(`${name}.json`, base);
  const body = { ...params };
  if (opts.start != null) body.start = opts.start;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Bitrix24 ${name}: не JSON (${res.status}) ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.error) {
    const msg = data.error_description || data.error || text.slice(0, 280);
    throw new Error(`Bitrix24 ${name}: ${msg}`);
  }
  return data;
}

/**
 * Все страницы list-метода (поле `next`).
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {{ maxPages?: number }} [opts]
 */
export async function bitrixAll(method, params = {}, opts = {}) {
  const maxPages = opts.maxPages ?? 50;
  const rows = [];
  let start = 0;
  let pages = 0;
  while (pages < maxPages) {
    const data = await bitrixCall(method, params, { start });
    const chunk = data.result;
    if (Array.isArray(chunk)) rows.push(...chunk);
    else if (chunk != null) rows.push(chunk);
    if (data.next == null) break;
    start = data.next;
    pages += 1;
  }
  return rows;
}

/** Короткая проверка доступа: профиль пользователя webhook. */
export async function bitrixHealth() {
  const { base, host } = bitrixConfig();
  const data = await bitrixCall("profile");
  const profile = data.result || {};
  return {
    ok: true,
    host,
    // не отдаём полный webhook наружу
    portal: base.replace(/\/rest\/.*$/, "/"),
    userId: profile.ID ?? profile.id ?? null,
    name: [profile.NAME, profile.LAST_NAME].filter(Boolean).join(" ") || profile.NAME || null,
  };
}

/**
 * Id воронок сделок «Архив» (и подобных) — их не включаем в отчёты.
 * @returns {Promise<string[]>}
 */
export async function bitrixArchiveDealCategoryIds() {
  const cats = await bitrixAll("crm.dealcategory.list", {}, { maxPages: 10 });
  return cats
    .filter((c) => /архив/i.test(String(c?.NAME || "")))
    .map((c) => String(c.ID))
    .filter(Boolean);
}

/**
 * Фильтр crm.deal.list без воронок «Архив».
 * @param {Record<string, unknown>} [base]
 * @param {string[]} [archiveIds]
 */
export function bitrixDealFilterWithoutArchive(base = {}, archiveIds = []) {
  const filter = { ...base };
  const ids = [...new Set((archiveIds || []).map(String).filter(Boolean))];
  if (ids.length === 1) filter["!CATEGORY_ID"] = ids[0];
  else if (ids.length > 1) filter["!CATEGORY_ID"] = ids;
  return filter;
}
