import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChartParts } from "./lib/render-charts.mjs";
import { loadActiveEmployees } from "./load-employees.mjs";
import { loadPnl, defaultPnlRange, normalizePnlGroup } from "./lib/load-pnl.mjs";
import { loadPnlEcotidy } from "./lib/load-pnl-ecotidy.mjs";
import { loadUnitsReport, defaultUnitsRange } from "./lib/load-units.mjs";
import { loadPlan, defaultPlanRange } from "./lib/load-plan.mjs";
import { loadBudget, defaultBudgetRange } from "./lib/load-budget.mjs";
import { loadBitrixAnalytics, defaultBitrixRange } from "./lib/load-bitrix.mjs";
import { loadBitrixFrequency } from "./lib/load-bitrix-freq.mjs";
import { loadOzonCost, defaultOzonRange } from "./lib/load-ozon.mjs";
import { loadOzonDrr, defaultOzonDrrRange } from "./lib/load-ozon-drr.mjs";
import { loadWbProfit, defaultWbRange } from "./lib/load-wb.mjs";
import {
  cookieName,
  ensureAuthReady,
  checkLogin,
  signSession,
  readSession,
  listPublicUsers,
  createUser,
  updateUser,
  removeUser,
  publicUser,
  filterDashboardData,
  userHasTab,
} from "./lib/auth.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const IIS_DIR = process.env.IIS_PUBLISH_DIR || "C:\\inetpub\\wwwroot\\employees";
const CACHE_MS = 10 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const SNAPSHOT_PATH = join(root, "data", "snapshot.json");

let cache = { at: 0, data: null, html: "", error: null, inflight: null, stale: false };

const EMPTY_DATA = {
  generatedAt: "",
  source: "Аллсан Интеграция",
  organization: "Аллсан Интеграция",
  kpis: {},
  charts: {},
  totals: { employees: 0, tasks: 0, unassigned: 0, activity: 0 },
  employees: [],
  activity: [],
};

function hasHoursPayload(data) {
  if (!data || typeof data !== "object") return false;
  const tasks = Number(data.totals?.tasks) || 0;
  const hours = Number(data.kpis?.hoursInWork) || 0;
  const done = Number(data.kpis?.hoursCompleted) || 0;
  if (tasks > 0 || hours > 0 || done > 0) return true;
  const charts = data.charts || {};
  return Object.values(charts).some((rows) => Array.isArray(rows) && rows.length > 0);
}

function loadSnapshotFromDisk() {
  try {
    if (!existsSync(SNAPSHOT_PATH)) return null;
    const raw = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    if (!hasHoursPayload(raw)) return null;
    return raw;
  } catch (err) {
    console.warn("snapshot read failed:", err.message || err);
    return null;
  }
}

function saveSnapshotToDisk(data) {
  try {
    if (!hasHoursPayload(data)) return;
    mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(data), "utf8");
  } catch (err) {
    console.warn("snapshot write failed:", err.message || err);
  }
}

function renderHtml(data, user) {
  const template = readFileSync(join(root, "public", "index.html"), "utf8");
  const payload = JSON.stringify(filterDashboardData(data, user)).replace(/</g, "\\u003c");
  const parts = renderChartParts(filterDashboardData(data, user));
  return template
    .replace("__EMBEDDED_DATA__", payload)
    .replace("__USER__", JSON.stringify(publicUser(user)).replace(/</g, "\\u003c"))
    .replace("__META__", parts.meta)
    .replace("__CHART_STATUS__", parts.status)
    .replace("__CHART_KPIS__", parts.kpis)
    .replace("__CHART_DEV_WORK__", parts.devWork)
    .replace("__CHART_CLIENT_DONE__", parts.clientDone)
    .replace("__CHART_ANALYST_DONE__", parts.analystDone)
    .replace("__CHART_DEV_DONE__", parts.devDone)
    .replace("__ACTIVITY__", parts.activity)
    .replace("__CLIENT_OPTIONS__", parts.clientOptions)
    .replace("__STATUS_OPTIONS__", parts.statusOptions);
}

async function refresh(force = false) {
  const now = Date.now();
  const ttl = cache.stale || !hasHoursPayload(cache.data) ? RETRY_MS : CACHE_MS;
  if (!force && cache.data && now - cache.at < ttl) return cache;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    const data = await loadActiveEmployees();
    if (!hasHoursPayload(data)) {
      throw new Error("1С вернула пустой снимок часов");
    }
    cache = {
      at: Date.now(),
      data,
      html: "",
      error: null,
      inflight: null,
      stale: false,
    };
    saveSnapshotToDisk(data);
    publishToIis();
    return cache;
  })().catch((err) => {
    cache.inflight = null;
    cache.error = String(err.message || err);
    if (hasHoursPayload(cache.data)) {
      cache.stale = true;
      cache.at = Date.now();
      console.warn("hours refresh failed, keeping previous snapshot:", cache.error);
    } else {
      const disk = loadSnapshotFromDisk();
      if (disk) {
        cache.data = disk;
        cache.stale = true;
        cache.at = Date.now();
        console.warn("hours refresh failed, loaded disk snapshot:", cache.error);
      } else {
        cache.data = EMPTY_DATA;
        cache.stale = true;
        cache.at = 0;
        console.warn("hours refresh failed, no snapshot yet:", cache.error);
      }
    }
    return cache;
  });

  return cache.inflight;
}

function startHoursRefreshLoop() {
  setInterval(() => {
    refresh(true)
      .then((snap) => {
        if (snap.error) return;
        const t = snap.data?.totals || {};
        console.log(
          `Hours cache updated: employees ${t.employees}, tasks ${t.tasks}, hours ${snap.data?.kpis?.hoursInWork}, done ${snap.data?.kpis?.hoursCompleted}`
        );
      })
      .catch((err) => console.warn("hours refresh loop:", err.message || err));
  }, CACHE_MS);
}

function publishToIis() {
  try {
    mkdirSync(IIS_DIR, { recursive: true });
    writeFileSync(
      join(IIS_DIR, "index.html"),
      `<!DOCTYPE html><meta charset="utf-8"><title>Дашборд</title><p>Откройте дашборд на порту 8787 и войдите под своей учёткой.</p>`,
      "utf8"
    );
    writeFileSync(join(IIS_DIR, "web.config"), IIS_WEB_CONFIG, "utf8");
    cache.published = IIS_DIR;
  } catch (err) {
    cache.publishError = String(err.message || err);
  }
}

const IIS_WEB_CONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <defaultDocument>
      <files>
        <clear />
        <add value="index.html" />
      </files>
    </defaultDocument>
    <httpProtocol>
      <customHeaders>
        <add name="Cache-Control" value="no-store" />
      </customHeaders>
    </httpProtocol>
    <staticContent>
      <clientCache cacheControlMode="DisableCache" />
    </staticContent>
  </system.webServer>
</configuration>
`;

function send(res, status, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(buf);
}

function json(res, status, obj, extra = {}) {
  send(res, status, JSON.stringify(obj), "application/json; charset=utf-8", extra);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, clear = false) {
  const max = clear ? 0 : 14 * 24 * 60 * 60;
  return `${cookieName()}=${clear ? "" : encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${max}`;
}

function currentUser(req) {
  return readSession(parseCookies(req)[cookieName()] || "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 200_000) {
        reject(new Error("Слишком большое тело запроса"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  try {
    if (path === "/login.html" || path === "/login") {
      const html = readFileSync(join(root, "public", "login.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (path === "/favicon.ico" || path === "/favicon.png") {
      const candidates = [
        join(root, "public", "favicon.ico"),
        join(root, "public", "assets", "favicon.ico"),
        join(root, "public", "assets", "favicon.png"),
      ];
      const file = candidates.find((p) => existsSync(p));
      if (!file) return send(res, 404, "Not found", "text/plain; charset=utf-8");
      const type = file.endsWith(".png") ? "image/png" : "image/x-icon";
      return send(res, 200, readFileSync(file), type, {
        "Cache-Control": "public, max-age=86400",
      });
    }

    if (path.startsWith("/assets/")) {
      const rel = path.slice("/assets/".length).replace(/\.\./g, "");
      const assetsRoot = resolve(root, "public", "assets");
      const file = resolve(assetsRoot, rel);
      if (!file.startsWith(assetsRoot) || !existsSync(file)) {
        return send(res, 404, "Not found", "text/plain; charset=utf-8");
      }
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      const types = {
        ".svg": "image/svg+xml; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
      };
      const headers = {};
      if (rel.startsWith("favicon")) headers["Cache-Control"] = "public, max-age=86400";
      return send(res, 200, readFileSync(file), types[ext] || "application/octet-stream", headers);
    }

    if (path === "/api/login" && req.method === "POST") {
      const body = await readJson(req);
      const user = checkLogin(body.login, body.password);
      if (!user) return json(res, 401, { error: "Неверный логин или пароль" });
      return json(res, 200, { ok: true, user: publicUser(user) }, { "Set-Cookie": sessionCookie(signSession(user.id)) });
    }

    if (path === "/api/logout" && req.method === "POST") {
      return json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", true) });
    }

    const user = currentUser(req);
    if (!user) {
      if (path.startsWith("/api/")) return json(res, 401, { error: "Нужно войти" });
      return redirect(res, "/login.html");
    }

    if (path === "/api/me") return json(res, 200, publicUser(user));

    if (path === "/api/admin/users") {
      if (!user.admin) return json(res, 403, { error: "Нужны права администратора" });
      if (req.method === "GET") return json(res, 200, { users: listPublicUsers() });
      if (req.method === "POST") {
        const body = await readJson(req);
        return json(res, 201, createUser(body));
      }
      if (req.method === "PATCH") {
        const id = url.searchParams.get("id");
        if (!id) return json(res, 400, { error: "Не указан пользователь" });
        const body = await readJson(req);
        return json(res, 200, updateUser(id, body));
      }
      if (req.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (!id) return json(res, 400, { error: "Не указан пользователь" });
        removeUser(id, user.id);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "Метод не поддерживается" });
    }

    if (path === "/api/pnl") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "pnl")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Доходы и расходы»." });
      }
      const range = defaultPnlRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      const group = normalizePnlGroup(url.searchParams.get("group"));
      try {
        const data = await loadPnl(from, to, group);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/pnlecotidy") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "pnlecotidy")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Доходы и расходы ПИ»." });
      }
      const range = defaultPnlRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      const group = normalizePnlGroup(url.searchParams.get("group"));
      try {
        const data = await loadPnlEcotidy(from, to, group);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/units") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "units")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Сводка юнитов»." });
      }
      const range = defaultUnitsRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        const data = await loadUnitsReport(from, to);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период|настроек/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/plan") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "plan")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Исполнение плана»." });
      }
      const range = defaultPlanRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        const data = await loadPlan(from, to);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/budget") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "budget")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Бюджет план-факт»." });
      }
      const range = defaultBudgetRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      const group = normalizePnlGroup(url.searchParams.get("group"));
      try {
        const data = await loadBudget(from, to, group);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период|файл плана/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/bitrix") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "bitrix")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Bitrix»." });
      }
      const preset = String(url.searchParams.get("preset") || "week");
      const from = String(url.searchParams.get("from") || "");
      const to = String(url.searchParams.get("to") || "");
      try {
        const data = await loadBitrixAnalytics({ preset, from, to });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период|webhook|Bitrix24/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/bitrixfreq") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "bitrixfreq")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Чистота ведения Битрикс»." });
      }
      try {
        const data = await loadBitrixFrequency();
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /webhook|Bitrix24/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/ozon") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "ozon")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Озон»." });
      }
      const range = defaultOzonRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        // По умолчанию без тяжёлых регистров себестоимости/рекламы (?cost=1&registers=1 — полный режим)
        const skipCost = url.searchParams.get("cost") !== "1";
        const skipRegisters = url.searchParams.get("registers") !== "1";
        const data = await loadOzonCost(from, to, { skipCost, skipRegisters });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/ozondrr") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "ozondrr")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Озон ДРР»." });
      }
      const range = defaultOzonDrrRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        const data = await loadOzonDrr(from, to);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/wb") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "wb")) {
        return json(res, 403, { error: "Нет доступа к вкладке «WB»." });
      }
      const range = defaultWbRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        const skipCost = url.searchParams.get("cost") === "0";
        const data = await loadWbProfit(from, to, { skipCost });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/employees" || path === "/api/health") {
      const force = url.searchParams.get("force") === "1" || url.searchParams.get("refresh") === "1";
      const snap = await refresh(force);
      if (path === "/api/health") {
        return json(res, 200, {
          ok: true,
          generatedAt: snap.data?.generatedAt,
          employees: snap.data?.totals?.employees,
          tasks: snap.data?.totals?.tasks,
          stale: Boolean(snap.stale),
          error: snap.error || null,
        });
      }
      return json(res, 200, filterDashboardData(snap.data, user));
    }

    if (path === "/" || path === "/index.html") {
      const snap = await refresh(true);
      return send(res, 200, renderHtml(snap.data, user), "text/html; charset=utf-8");
    }

    if (path.startsWith("/api/")) return json(res, 404, { error: "Нет такого адреса: " + path });
    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (err) {
    console.error(err);
    const msg = String(err.message || err);
    if (path.startsWith("/api/")) return json(res, 400, { error: msg });
    send(res, 502, `<!DOCTYPE html><meta charset="utf-8"><title>Ошибка</title><p>Не удалось получить данные.</p>`, "text/html; charset=utf-8");
  }
});

ensureAuthReady();
{
  const disk = loadSnapshotFromDisk();
  if (disk) {
    cache.data = disk;
    cache.stale = true;
    cache.at = 0;
    console.log(
      `Loaded hours snapshot from disk: employees ${disk.totals?.employees}, tasks ${disk.totals?.tasks}`
    );
  }
}

console.log("Updating hours cache from 1C on startup...");
refresh(true)
  .then((snap) => {
    if (snap.error) {
      console.warn(`Startup hours refresh: ${snap.error}`);
    } else {
      const t = snap.data?.totals || {};
      console.log(
        `Startup hours OK: employees ${t.employees}, tasks ${t.tasks}, hours ${snap.data?.kpis?.hoursInWork}, done ${snap.data?.kpis?.hoursCompleted}`
      );
    }
    if (snap.publishError) console.log(`IIS publish skipped: ${snap.publishError}`);
  })
  .catch((err) => {
    console.warn("Startup hours refresh failed:", err.message || err);
  })
  .finally(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Dashboard http://localhost:${PORT}/`);
      if (existsSync(join(IIS_DIR, "index.html"))) {
        console.log(`IIS snapshot http://localhost/employees/`);
      }
      startHoursRefreshLoop();
    });
  });