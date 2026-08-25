import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvPaths = [join(dashboardDir, ".env"), join(dashboardDir, "odata.env")];

/** @typedef {"trade" | "ecotidy"} ODataDb */

const DB_META = {
  trade: {
    envPrefix: "ODATA_DB_TRADE",
    legacyUrl: "ODATA_BASE_URL",
    legacyUser: "ODATA_USERNAME",
    legacyPass: "ODATA_PASSWORD",
    label: "УТ / Аллсан Интеграция",
    defaultOrg: "Аллсан Интеграция",
  },
  ecotidy: {
    envPrefix: "ODATA_DB_ECOTIDY",
    label: "Экотайди / Первый интегратор",
    defaultOrg: "ПЕРВЫЙ ИНТЕГРАТОР ООО",
  },
};

function normalize(url, user, pass, meta) {
  if (!url || !user || !pass) return null;
  return {
    base: url.endsWith("/") ? url : `${url}/`,
    user,
    pass,
    label: meta.label,
    defaultOrg: meta.defaultOrg,
  };
}

function pickFromMap(values, db) {
  const meta = DB_META[db];
  const p = meta.envPrefix;
  return normalize(
    values[`${p}_BASE_URL`] || (db === "trade" ? values[meta.legacyUrl] : undefined),
    values[`${p}_USERNAME`] || (db === "trade" ? values[meta.legacyUser] : undefined),
    values[`${p}_PASSWORD`] || (db === "trade" ? values[meta.legacyPass] : undefined),
    meta
  );
}

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

function fromProcessEnv(db) {
  return pickFromMap(process.env, db);
}

function fromLocalEnvFile(db) {
  const values = readLocalEnvMap();
  if (!values) return null;
  return pickFromMap(values, db);
}

function fromMcpJson(db) {
  const mcpPath = join(homedir(), ".cursor", "mcp.json");
  if (!existsSync(mcpPath)) return null;
  const env = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers?.["1c-odata"]?.env;
  if (!env) return null;
  return pickFromMap(env, db);
}

/**
 * @param {ODataDb} [db]
 */
export function resolveODataDb(db) {
  const raw = (db || process.env.ODATA_DEFAULT_DB || "trade").toLowerCase();
  if (raw === "trade" || raw === "ecotidy") return raw;
  throw new Error(`Неизвестная база OData: ${raw}. Доступны: trade, ecotidy.`);
}

/**
 * @param {ODataDb} [db]
 */
function loadOData(db) {
  const key = resolveODataDb(db);
  const loaded = fromProcessEnv(key) || fromLocalEnvFile(key) || fromMcpJson(key);
  if (loaded) return { ...loaded, db: key };
  const p = DB_META[key].envPrefix;
  throw new Error(
    `Нет доступа к 1С (${key}). Создайте файл ${join(dashboardDir, ".env")} по образцу .env.example ` +
      `и укажите ${p}_BASE_URL, ${p}_USERNAME, ${p}_PASSWORD.`
  );
}

/**
 * @param {ODataDb} [db]
 */
export function odataConfig(db) {
  const { base, user, pass, label, defaultOrg, db: resolved } = loadOData(db);
  return {
    db: resolved,
    base,
    host: new URL(base).host,
    label,
    defaultOrg,
    authHeader: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

/**
 * @param {string} path
 * @param {ODataDb | { database?: ODataDb }} [dbOrOpts]
 */
export async function odataGet(path, dbOrOpts) {
  const db = typeof dbOrOpts === "string" ? dbOrOpts : dbOrOpts?.database;
  const { base, authHeader } = odataConfig(db);
  const url = path.startsWith("http") ? path : new URL(path, base).toString();
  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: "application/json" },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${url.slice(0, 180)} ${text.slice(0, 280).replace(/\s+/g, " ")}`);
  }
  return JSON.parse(text);
}

/**
 * @param {string} path
 * @param {number | { maxPages?: number, database?: ODataDb }} [maxPagesOrOpts]
 * @param {ODataDb} [dbLegacy]
 */
export async function odataAllPages(path, maxPagesOrOpts = 50, dbLegacy) {
  let maxPages = 50;
  /** @type {ODataDb | undefined} */
  let database;
  if (typeof maxPagesOrOpts === "number") {
    maxPages = maxPagesOrOpts;
    database = dbLegacy;
  } else if (maxPagesOrOpts && typeof maxPagesOrOpts === "object") {
    maxPages = maxPagesOrOpts.maxPages ?? 50;
    database = maxPagesOrOpts.database;
  }

  const rows = [];
  let next = path;
  let pages = 0;
  while (next && pages < maxPages) {
    const data = await odataGet(next, database);
    rows.push(...(data.value || []));
    next = data["odata.nextLink"] || data["@odata.nextLink"] || null;
    pages += 1;
  }
  return rows;
}
