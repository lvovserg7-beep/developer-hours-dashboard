import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localEnvPath = join(dirname(fileURLToPath(import.meta.url)), "..", "odata.env");

function normalize(url, user, pass) {
  if (!url || !user || !pass) return null;
  return {
    base: url.endsWith("/") ? url : `${url}/`,
    user,
    pass,
  };
}

function fromProcessEnv() {
  return normalize(
    process.env.ODATA_DB_TRADE_BASE_URL || process.env.ODATA_BASE_URL,
    process.env.ODATA_DB_TRADE_USERNAME || process.env.ODATA_USERNAME,
    process.env.ODATA_DB_TRADE_PASSWORD || process.env.ODATA_PASSWORD
  );
}

function fromLocalEnvFile() {
  if (!existsSync(localEnvPath)) return null;
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
  return normalize(
    values.ODATA_DB_TRADE_BASE_URL || values.ODATA_BASE_URL,
    values.ODATA_DB_TRADE_USERNAME || values.ODATA_USERNAME,
    values.ODATA_DB_TRADE_PASSWORD || values.ODATA_PASSWORD
  );
}

function fromMcpJson() {
  const mcpPath = join(homedir(), ".cursor", "mcp.json");
  if (!existsSync(mcpPath)) return null;
  const env = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers?.["1c-odata"]?.env;
  if (!env) return null;
  return normalize(env.ODATA_DB_TRADE_BASE_URL, env.ODATA_DB_TRADE_USERNAME, env.ODATA_DB_TRADE_PASSWORD);
}

function loadTradeOData() {
  const loaded = fromProcessEnv() || fromLocalEnvFile() || fromMcpJson();
  if (loaded) return loaded;
  throw new Error(
    `Нет доступа к 1С. На этой машине нет Cursor (файл ${join(homedir(), ".cursor", "mcp.json")}). ` +
      `Создайте файл ${localEnvPath} по образцу odata.env.example и укажите адрес, логин и пароль OData.`
  );
}

export function odataConfig() {
  const { base, user, pass } = loadTradeOData();
  return {
    base,
    host: new URL(base).host,
    authHeader: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`,
  };
}

export async function odataGet(path) {
  const { base, authHeader } = odataConfig();
  const url = path.startsWith("http") ? path : new URL(path, base).toString();
  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${url.slice(0, 180)} ${text.slice(0, 280).replace(/\s+/g, " ")}`);
  }
  return JSON.parse(text);
}

export async function odataAllPages(path, maxPages = 50) {
  const rows = [];
  let next = path;
  let pages = 0;
  while (next && pages < maxPages) {
    const data = await odataGet(next);
    rows.push(...(data.value || []));
    next = data["odata.nextLink"] || data["@odata.nextLink"] || null;
    pages += 1;
  }
  return rows;
}
