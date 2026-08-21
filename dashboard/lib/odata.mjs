import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function loadTradeOData() {
  const fromEnvUrl = process.env.ODATA_DB_TRADE_BASE_URL || process.env.ODATA_BASE_URL;
  const fromEnvUser = process.env.ODATA_DB_TRADE_USERNAME || process.env.ODATA_USERNAME;
  const fromEnvPass = process.env.ODATA_DB_TRADE_PASSWORD || process.env.ODATA_PASSWORD;
  if (fromEnvUrl && fromEnvUser && fromEnvPass) {
    return {
      base: fromEnvUrl.endsWith("/") ? fromEnvUrl : `${fromEnvUrl}/`,
      user: fromEnvUser,
      pass: fromEnvPass,
    };
  }

  const cfg = JSON.parse(readFileSync(join(homedir(), ".cursor", "mcp.json"), "utf8"));
  const env = cfg.mcpServers["1c-odata"].env;
  const base = env.ODATA_DB_TRADE_BASE_URL.endsWith("/")
    ? env.ODATA_DB_TRADE_BASE_URL
    : `${env.ODATA_DB_TRADE_BASE_URL}/`;
  return { base, user: env.ODATA_DB_TRADE_USERNAME, pass: env.ODATA_DB_TRADE_PASSWORD };
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
