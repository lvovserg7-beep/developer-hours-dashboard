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
import { loadOzonFbsDashboard } from "./lib/load-ozon-fbs-acts.mjs";
import { loadOzonFboSupplies, defaultOzonFboRange, defaultOzonFboFilterRange } from "./lib/load-ozon-fbo.mjs";
import { loadWbProfit, defaultWbRange } from "./lib/load-wb.mjs";
import { loadWbFbsSuppliesReport, getWbFbsSupplyQr, deliverWbFbsSupplyAndQr } from "./lib/load-wb-fbs-supplies.mjs";
import { loadDebtors } from "./lib/load-debtors.mjs";
import { loadMBalance } from "./lib/load-mbalance.mjs";
import { loadClientPayments } from "./lib/load-client-payments.mjs";
import { loadSeoReport, loadSeoProductsReport, loadSeoPositionsReport, refreshSeoTrailingCache, attachYandexSqi } from "./lib/load-seo.mjs";
import {
  cookieName,
  ensureAuthReady,
  checkLogin,
  signSession,
  readSession,
  listPublicUsers,
  createUser,
  updateUser,
  updateOwnTabOrder,
  removeUser,
  publicUser,
  filterDashboardData,
  userHasTab,
  sessionRefreshNeeds,
  clientIp,
  checkLoginThrottle,
  registerLoginFailure,
  clearLoginFailures,
} from "./lib/auth.mjs";
import {
  listBoardCaches,
  clearBoardCache,
  registerHoursCacheHooks,
  resolveCachePeriod,
  defaultCacheClearPeriod,
  trailingCachePeriod,
} from "./lib/board-cache.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
/** IIS-снимок: только если задан IIS_PUBLISH_DIR, либо дефолт на Windows. На Linux без env — не публикуем. */
const IIS_DIR = (() => {
  const fromEnv = String(process.env.IIS_PUBLISH_DIR || "").trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "win32") return "C:\\inetpub\\wwwroot\\employees";
  return "";
})();
const CACHE_MS = 10 * 60 * 1000;
const SEO_REFRESH_MS = (() => {
  const n = Number(process.env.SEO_REFRESH_MS);
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60 * 1000;
})();
const RETRY_MS = 30 * 1000;
const SNAPSHOT_PATH = join(root, "data", "snapshot.json");

let cache = { at: 0, data: null, html: "", error: null, inflight: null, stale: false };
let hoursEpoch = 0;

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

  const epoch = hoursEpoch;
  cache.inflight = (async () => {
    const data = await loadActiveEmployees();
    if (epoch !== hoursEpoch) return cache;
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
    if (epoch !== hoursEpoch) return cache;
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

registerHoursCacheHooks({
  inspect() {
    return {
      memory: !!(cache.data && hasHoursPayload(cache.data)),
      stale: !!cache.stale,
      updatedAt: cache.at ? new Date(cache.at).toISOString() : null,
    };
  },
  clear() {
    hoursEpoch += 1;
    cache = { at: 0, data: null, html: "", error: null, inflight: null, stale: false };
  },
});

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

function logSeoTrailing(result, reason) {
  const seo = result.seo || {};
  const pos = result.pos || {};
  const wordstat = result.wordstat || {};
  const classes = result.classes || {};
  const gscDone = (seo.gsc || []).filter((x) => !x.skipped).length;
  const yaDone = (seo.yandex || []).filter((x) => !x.skipped).length;
  console.log(
    `SEO trailing ${reason}: ${result.from}…${result.to}, gsc=${gscDone}, yandex=${yaDone}, ` +
      `positions fetched=${pos.fetched || 0} rows=${pos.rows || 0}, ` +
      `wordstat fetched=${wordstat.fetched || 0} skipped=${wordstat.skipped || 0}`
  );
  const cls = classes.cls || {};
  console.log(`SEO product classes: total=${cls.total || 0}, added=${cls.added || 0}`);
  const brand = classes.brand || {};
  console.log(`SEO brand reclass: updated=${brand.updated || 0}, added=${brand.added || 0}, total=${brand.total || 0}`);
  const boxes = classes.boxes || {};
  console.log(`SEO boxes reclass: updated=${boxes.updated || 0}, added=${boxes.added || 0}, total=${boxes.total || 0}`);
  for (const w of seo.warnings || []) console.warn("SEO:", w);
  for (const w of pos.warnings || []) console.warn("SEO positions:", w);
  for (const w of wordstat.warnings || []) console.warn("SEO wordstat:", w);
}

function trailingCacheDays() {
  const n = Number(process.env.CACHE_TRAILING_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 7;
}

function envFlagOn(name, fallback = true) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function todayYmdLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY_OPEN_MARK = join(root, "data", "cache-day-open.json");

function readDayOpenMark() {
  try {
    if (!existsSync(DAY_OPEN_MARK)) return null;
    return JSON.parse(readFileSync(DAY_OPEN_MARK, "utf8"));
  } catch {
    return null;
  }
}

function writeDayOpenMark(openDay, extra = {}) {
  try {
    if (!existsSync(join(root, "data"))) mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      DAY_OPEN_MARK,
      JSON.stringify({ openDay, at: new Date().toISOString(), ...extra }, null, 2),
      "utf8"
    );
  } catch (err) {
    console.warn("cache-day-open mark:", err.message || err);
  }
}

function markCacheDayHandled(reason) {
  writeDayOpenMark(todayYmdLocal(), { reason });
}

function runSeoTrailingRefresh(reason, opts = {}) {
  const days = opts.days != null ? opts.days : trailingCacheDays();
  console.log(`SEO trailing refresh (${reason}, last ${days} day(s) overwrite)...`);
  return refreshSeoTrailingCache({
    days,
    force: Boolean(opts.force) || (reason === "startup" && process.env.SEO_FORCE_SYNC === "1"),
  })
    .then((result) => logSeoTrailing(result, reason))
    .catch((err) => console.warn(`SEO trailing ${reason} failed:`, err.message || err));
}

async function refreshOzonTrailingCache(period) {
  console.log(`Ozon trailing refresh: ${period.from}…${period.to}...`);
  try {
    const report = await loadOzonCost(period.from, period.to, {
      refresh: true,
      log: true,
    });
    const rows = Array.isArray(report?.rows) ? report.rows.length : 0;
    console.log(`Ozon trailing OK: ${period.from}…${period.to}, rows=${rows}`);
  } catch (err) {
    console.warn(`Ozon trailing ${period.from}…${period.to} failed:`, err.message || err);
  }
}

/**
 * Сброс SEO-кэша за окно (без Озона) и перечитывание.
 * Озон при автозапуске по умолчанию выключен — полный пересчёт валит Node на слабых машинах.
 * Часы обновляются при открытии главной (`refresh(true)`), если у пользователя есть доска часов/активности.
 * @param {string} reason
 * @param {{ days?: number, boards?: { seo?: boolean, ozon?: boolean } }} [opts]
 */
async function runAllTrailingCacheRefresh(reason, opts = {}) {
  if (!envFlagOn("CACHE_TRAILING_STARTUP", true) && reason === "startup") {
    console.log("Startup trailing cache refresh disabled (CACHE_TRAILING_STARTUP=0)");
    return;
  }
  if (!envFlagOn("CACHE_FIRST_OPEN_DAY", true) && reason === "first-open") {
    console.log("First-open day cache refresh disabled (CACHE_FIRST_OPEN_DAY=0)");
    return;
  }
  const days = opts.days != null ? Math.max(1, Math.floor(Number(opts.days) || 1)) : trailingCacheDays();
  const period = trailingCachePeriod(days);
  const boards = opts.boards || { seo: true, ozon: true };
  console.log(
    `Cache trailing ${reason}: last ${days} day(s) (${period.from}…${period.to}), boards seo=${!!boards.seo} ozon=${!!boards.ozon}...`
  );

  // По умолчанию не сносим кэш перед перечитыванием: SEO сам перезаписывает дни.
  // Полный invalidate (в т.ч. файлы Озона) — только явно CACHE_TRAILING_INVALIDATE=1.
  if (boards.seo && envFlagOn("CACHE_TRAILING_INVALIDATE", false)) {
    try {
      for (const board of ["seo", "seoqueries", "seopositions"]) {
        const cleared = clearBoardCache(board, { from: period.from, to: period.to });
        console.log(`Cache trailing invalidate ${board}: removed=${cleared.removed || 0}, rows=${cleared.rows || 0}`);
      }
    } catch (err) {
      console.warn(`Cache trailing invalidate failed:`, err.message || err);
    }
  }

  if (boards.seo) {
    try {
      await runSeoTrailingRefresh(reason, { days, force: reason === "first-open" });
    } catch (err) {
      console.warn(`Cache trailing SEO ${reason} failed:`, err.message || err);
    }
  } else {
    console.log(`SEO trailing skipped (${reason}: нет доступа к SEO-доскам в сеансе)`);
  }

  // Озон: тяжёлый OData-пересчёт. По умолчанию выкл. — иначе Node часто падает (OOM / kill).
  if (boards.ozon && envFlagOn("CACHE_TRAILING_OZON", false)) {
    try {
      await refreshOzonTrailingCache(period);
    } catch (err) {
      console.warn(`Cache trailing Ozon ${reason} failed:`, err.message || err);
    }
  } else if (boards.ozon) {
    console.log("Ozon trailing skipped (default off; set CACHE_TRAILING_OZON=1 to enable)");
  } else {
    console.log(`Ozon trailing skipped (${reason}: нет доступа к Озон-доскам в сеансе)`);
  }

  if (reason === "startup") {
    writeDayOpenMark(todayYmdLocal(), {
      reason: "startup",
      boards: {
        seo: Boolean(boards.seo),
        ozon: Boolean(boards.ozon && envFlagOn("CACHE_TRAILING_OZON", false)),
      },
    });
  }
}

let firstOpenRefreshInflight = null;
/** Доски, которые попросили обновить, пока шёл другой first-open. */
let firstOpenQueued = { seo: false, ozon: false };

function startFirstOpenBoards(todo, login) {
  const today = todayYmdLocal();
  const mark = readDayOpenMark();
  const done = mark?.openDay === today && mark.boards && typeof mark.boards === "object" ? { ...mark.boards } : {};
  if (todo.seo) done.seo = true;
  if (todo.ozon) done.ozon = true;
  writeDayOpenMark(today, {
    reason: "first-open-claimed",
    boards: done,
    by: login || "",
  });
  console.log(
    `First dashboard open today (${today}) by ${login || "?"}: refresh yesterday cache seo=${!!todo.seo} ozon=${!!todo.ozon}...`
  );
  firstOpenRefreshInflight = runAllTrailingCacheRefresh("first-open", { days: 1, boards: todo })
    .catch((err) => console.warn("First-open day cache refresh failed:", err.message || err))
    .finally(() => {
      firstOpenRefreshInflight = null;
      const queued = {
        seo: Boolean(firstOpenQueued.seo),
        ozon: Boolean(firstOpenQueued.ozon),
      };
      firstOpenQueued = { seo: false, ozon: false };
      if (!queued.seo && !queued.ozon) return;
      // Уже отмеченные сегодня доски повторно не берём.
      const markNow = readDayOpenMark();
      const doneNow =
        markNow?.openDay === today && markNow.boards && typeof markNow.boards === "object" ? markNow.boards : {};
      const next = {
        seo: queued.seo && !doneNow.seo,
        ozon: queued.ozon && !doneNow.ozon,
      };
      if (!next.seo && !next.ozon) return;
      startFirstOpenBoards(next, "queue");
    });
}

/**
 * Первый вход за день → дочитать кэш за вчера, но только по доскам текущего пользователя.
 * Уже обновлённые сегодня доски повторно не трогаем (чтобы не-админ без SEO не «закрыл» день для SEO).
 */
function maybeKickFirstOpenDayRefresh(user) {
  if (!envFlagOn("CACHE_FIRST_OPEN_DAY", true)) return;
  const needs = sessionRefreshNeeds(user);
  const today = todayYmdLocal();
  const mark = readDayOpenMark();
  const done = mark?.openDay === today && mark.boards && typeof mark.boards === "object" ? mark.boards : {};
  // Старый формат метки без boards: день уже считался полностью обработанным.
  if (mark?.openDay === today && !mark.boards) return;

  const todo = {
    seo: Boolean(needs.seo && !done.seo),
    ozon: Boolean(needs.ozon && !done.ozon),
  };
  if (!todo.seo && !todo.ozon) return;
  if (firstOpenRefreshInflight) {
    if (todo.seo) firstOpenQueued.seo = true;
    if (todo.ozon) firstOpenQueued.ozon = true;
    return;
  }
  startFirstOpenBoards(todo, user?.login || "");
}

function startSeoRefreshLoop() {
  setInterval(() => {
    runSeoTrailingRefresh("daily");
  }, SEO_REFRESH_MS);
  const hours = Math.round(SEO_REFRESH_MS / 3600000);
  const days = trailingCacheDays();
  console.log(`SEO trailing refresh every ${hours}h (last ${days} days overwrite)`);
}

function publishToIis() {
  if (!IIS_DIR) return;
  try {
    mkdirSync(IIS_DIR, { recursive: true });
    writeFileSync(
      join(IIS_DIR, "index.html"),
      `<!DOCTYPE html><meta charset="utf-8"><meta name="robots" content="noindex, nofollow, noarchive"><title>Дашборд</title><p>Откройте дашборд на порту 8787 и войдите под своей учёткой.</p>`,
      "utf8"
    );
    writeFileSync(join(IIS_DIR, "robots.txt"), "User-agent: *\nDisallow: /\n", "utf8");
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

    if (path === "/robots.txt") {
      const file = join(root, "public", "robots.txt");
      const body = existsSync(file)
        ? readFileSync(file, "utf8")
        : "User-agent: *\nDisallow: /\n";
      return send(res, 200, body, "text/plain; charset=utf-8", {
        "Cache-Control": "public, max-age=3600",
      });
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
      const login = String(body.login || "");
      const ip = clientIp(req);
      const throttle = checkLoginThrottle(ip, login);
      if (!throttle.ok) {
        return json(
          res,
          429,
          { error: throttle.error },
          { "Retry-After": String(throttle.retryAfterSec) }
        );
      }
      const user = checkLogin(login, body.password);
      if (!user) {
        registerLoginFailure(ip, login);
        const again = checkLoginThrottle(ip, login);
        if (!again.ok) {
          return json(
            res,
            429,
            { error: again.error },
            { "Retry-After": String(again.retryAfterSec) }
          );
        }
        return json(res, 401, { error: "Неверный логин или пароль" });
      }
      clearLoginFailures(ip, login);
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

    if (path === "/api/me") {
      if (req.method === "GET") return json(res, 200, publicUser(user));
      if (req.method === "PATCH") {
        const body = await readJson(req);
        if (body.admin != null || body.tabs || body.login != null || body.password) {
          return json(res, 403, { error: "Через этот запрос можно менять только порядок своих вкладок." });
        }
        if (!body.tabOrder) return json(res, 400, { error: "Не указан порядок вкладок" });
        try {
          return json(res, 200, updateOwnTabOrder(user.id, body.tabOrder));
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) });
        }
      }
      return json(res, 405, { error: "Метод не поддерживается" });
    }

    if (path === "/api/admin/cache") {
      if (!user.admin) return json(res, 403, { error: "Нужны права администратора" });
      if (req.method === "GET") {
        let period = null;
        try {
          period = resolveCachePeriod(url.searchParams.get("from"), url.searchParams.get("to"));
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) });
        }
        const defaults = defaultCacheClearPeriod();
        return json(res, 200, {
          boards: listBoardCaches(period),
          period: period || defaults,
          defaults,
        });
      }
      if (req.method === "POST") {
        const body = await readJson(req);
        const board = String(body.board || "").trim();
        if (!board) return json(res, 400, { error: "Не указана доска" });
        try {
          const result = clearBoardCache(board, { from: body.from, to: body.to });
          const listPeriod = result.period || resolveCachePeriod(body.from, body.to);
          return json(res, 200, {
            ...result,
            boards: listBoardCaches(listPeriod),
            period: listPeriod || defaultCacheClearPeriod(),
            defaults: defaultCacheClearPeriod(),
          });
        } catch (err) {
          return json(res, 400, { error: String(err.message || err) });
        }
      }
      return json(res, 405, { error: "Метод не поддерживается" });
    }

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
        // Полный отчёт как в 1С. Ускорение: ?cost=0 и/или ?registers=0. Сброс кэша: ?refresh=1
        const skipCost = url.searchParams.get("cost") === "0";
        const skipRegisters = url.searchParams.get("registers") === "0";
        const refresh = url.searchParams.get("refresh") === "1";
        const data = await loadOzonCost(from, to, { skipCost, skipRegisters, refresh });
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

    if (path === "/api/ozonfbs") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "ozonfbs")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Отгрузки ФБС ozon»." });
      }
      try {
        const daysRaw = Number(url.searchParams.get("days"));
        const data = await loadOzonFbsDashboard({
          days: Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined,
        });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, 502, { error: msg });
      }
    }

    if (path === "/api/ozonfbo") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "ozonfbo") && !userHasTab(user, "ozonfbofilters")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Отгрузки ФБО Озон»." });
      }
      const range = defaultOzonFboRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        const data = await loadOzonFboSupplies(from, to);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /дата/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/ozonfbofilters") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "ozonfbofilters")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Поставки ФБО с фильтрами»." });
      }
      const range = defaultOzonFboFilterRange();
      const from = String(url.searchParams.get("from") || range.from);
      const to = String(url.searchParams.get("to") || range.to);
      try {
        const data = await loadOzonFboSupplies(from, to);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /дата/i.test(msg) ? 400 : 502, { error: msg });
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

    if (path === "/api/wbfbs") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "wbfbs")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Поставки ФБС WB»." });
      }
      try {
        const data = await loadWbFbsSuppliesReport();
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, 502, { error: msg });
      }
    }

    if (path === "/api/wbfbs/qr") {
      if (!userHasTab(user, "wbfbs")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Поставки ФБС WB»." });
      }
      const supplyId = String(url.searchParams.get("id") || "").trim();
      if (!supplyId) return json(res, 400, { error: "Укажите id поставки" });
      try {
        if (req.method === "GET") {
          const data = await getWbFbsSupplyQr(supplyId, "png");
          return json(res, 200, data);
        }
        if (req.method === "POST") {
          // Передача в доставку + QR — явное действие со склада для сдачи ФБС.
          const data = await deliverWbFbsSupplyAndQr(supplyId);
          return json(res, 200, data);
        }
        return json(res, 405, { error: "Метод не поддерживается" });
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        const notDelivered = /не передана в доставку|not.*deliver/i.test(msg);
        return json(res, notDelivered ? 409 : 502, { error: msg, needDeliver: notDelivered });
      }
    }

    if (path === "/api/debtors") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "debtors")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Задолженность клиентов»." });
      }
      try {
        const organization = String(url.searchParams.get("organization") || "").trim();
        const data = await loadDebtors({ organization: organization || undefined, database: "trade" });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, 502, { error: msg });
      }
    }

    if (path === "/api/mbalance") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "mbalance")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Управленческий баланс»." });
      }
      try {
        const dateFrom = String(url.searchParams.get("from") || "").trim();
        const dateTo = String(url.searchParams.get("to") || "").trim();
        const organization = String(url.searchParams.get("organization") || "").trim();
        const data = await loadMBalance({
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          organization: organization || undefined,
          database: "trade",
        });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период|пустой/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/clientpay") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "clientpay")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Реестр оплат клиентов»." });
      }
      try {
        const dateFrom = String(url.searchParams.get("from") || "").trim();
        const dateTo = String(url.searchParams.get("to") || "").trim();
        const year = String(url.searchParams.get("year") || "").trim();
        const month = String(url.searchParams.get("month") || "").trim();
        const client = String(url.searchParams.get("client") || "").trim();
        const data = await loadClientPayments({
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          year: year ? Number(year) : undefined,
          month: month ? Number(month) : undefined,
          client: client || undefined,
          database: "trade",
        });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, 502, { error: msg });
      }
    }

    if (path === "/api/seo" || path === "/api/seoqueries") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      const tabKey = path === "/api/seoqueries" ? "seoqueries" : "seo";
      if (!userHasTab(user, tabKey)) {
        return json(
          res,
          403,
          { error: tabKey === "seoqueries" ? "Нет доступа к вкладке «SEO запросы»." : "Нет доступа к вкладке «Поиск SEO»." }
        );
      }
      try {
        const from = String(url.searchParams.get("from") || "").trim();
        const to = String(url.searchParams.get("to") || "").trim();
        const source = String(url.searchParams.get("source") || "all").trim();
        const site = String(url.searchParams.get("site") || "").trim();
        const limitRaw = String(url.searchParams.get("limit") || "").trim().toLowerCase();
        let queryLimit = tabKey === "seoqueries" ? 0 : 10;
        if (limitRaw === "all" || limitRaw === "0") queryLimit = 0;
        else if (limitRaw) {
          const n = Number(limitRaw);
          if (Number.isFinite(n) && n > 0) queryLimit = Math.floor(n);
        }
        const data = loadSeoReport({
          from: from || undefined,
          to: to || undefined,
          source,
          site: site || undefined,
          queryLimit,
        });
        if (tabKey === "seo") {
          await attachYandexSqi(data, { site: site || undefined });
        }
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /дата|период|продукт/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/seoproducts") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "seoproducts")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Все запросы по продуктам»." });
      }
      try {
        const from = String(url.searchParams.get("from") || "").trim();
        const to = String(url.searchParams.get("to") || "").trim();
        const source = String(url.searchParams.get("source") || "all").trim();
        const site = String(url.searchParams.get("site") || "").trim();
        const product = String(url.searchParams.get("product") || "all").trim();
        const data = await loadSeoProductsReport({
          from: from || undefined,
          to: to || undefined,
          source,
          site: site || undefined,
          product,
        });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /дата|период|продукт/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/seopositions") {
      if (req.method !== "GET") return json(res, 405, { error: "Метод не поддерживается" });
      if (!userHasTab(user, "seopositions")) {
        return json(res, 403, { error: "Нет доступа к вкладке «Позиции в поисковиках»." });
      }
      try {
        const from = String(url.searchParams.get("from") || "").trim();
        const to = String(url.searchParams.get("to") || "").trim();
        const source = String(url.searchParams.get("source") || "all").trim();
        const site = String(url.searchParams.get("site") || "").trim();
        const product = String(url.searchParams.get("product") || "all").trim();
        const force = url.searchParams.get("force") === "1";
        const data = await loadSeoPositionsReport({
          from: from || undefined,
          to: to || undefined,
          source,
          site: site || undefined,
          product,
          force,
        });
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /дата|период|продукт/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/employees" || path === "/api/health") {
      const forceRequested = url.searchParams.get("force") === "1" || url.searchParams.get("refresh") === "1";
      const needs = sessionRefreshNeeds(user);
      // Не-админ без досок часов/активности не дергает 1С за часами в этом сеансе.
      const force = Boolean(forceRequested && needs.hours);
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
      maybeKickFirstOpenDayRefresh(user);
      const needs = sessionRefreshNeeds(user);
      const snap = await refresh(Boolean(needs.hours));
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
      if (IIS_DIR && existsSync(join(IIS_DIR, "index.html"))) {
        console.log(`IIS snapshot http://localhost/employees/`);
      }
      startHoursRefreshLoop();
      startSeoRefreshLoop();
      // Откладываем trailing, чтобы порт уже отвечал, даже если SEO ещё идёт.
      setTimeout(() => {
        runAllTrailingCacheRefresh("startup").catch((err) =>
          console.warn("Startup trailing cache refresh failed:", err.message || err)
        );
      }, 3000);
    });
  });

process.on("uncaughtException", (err) => {
  console.error("uncaughtException (дашборд продолжает работу):", err?.stack || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection (дашборд продолжает работу):", reason);
});