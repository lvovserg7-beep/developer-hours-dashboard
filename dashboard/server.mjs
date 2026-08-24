import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderChartParts } from "./lib/render-charts.mjs";
import { loadActiveEmployees } from "./load-employees.mjs";
import { loadPnl, defaultPnlRange } from "./lib/load-pnl.mjs";
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

let cache = { at: 0, data: null, html: "", error: null, inflight: null };

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
  if (!force && cache.data && now - cache.at < CACHE_MS) return cache;
  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    const data = await loadActiveEmployees();
    cache = {
      at: Date.now(),
      data,
      html: "",
      error: null,
      inflight: null,
    };
    publishToIis();
    return cache;
  })().catch((err) => {
    cache.inflight = null;
    cache.error = String(err.message || err);
    if (!cache.data) throw err;
    return cache;
  });

  return cache.inflight;
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
  const buf = Buffer.from(body);
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
      try {
        const data = await loadPnl(from, to);
        return json(res, 200, data);
      } catch (err) {
        const msg = String(err.message || err);
        console.error(err);
        return json(res, /период/i.test(msg) ? 400 : 502, { error: msg });
      }
    }

    if (path === "/api/employees" || path === "/api/health") {
      const snap = await refresh();
      if (path === "/api/health") {
        return json(res, 200, {
          ok: true,
          generatedAt: snap.data?.generatedAt,
          employees: snap.data?.totals?.employees,
        });
      }
      return json(res, 200, filterDashboardData(snap.data, user));
    }

    if (path === "/" || path === "/index.html") {
      const snap = await refresh();
      return send(res, 200, renderHtml(snap.data, user), "text/html; charset=utf-8");
    }

    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (err) {
    console.error(err);
    const msg = String(err.message || err);
    if (path.startsWith("/api/")) return json(res, 400, { error: msg });
    send(res, 502, `<!DOCTYPE html><meta charset="utf-8"><title>Ошибка</title><p>Не удалось получить данные.</p>`, "text/html; charset=utf-8");
  }
});

ensureAuthReady();
refresh(true)
  .then((snap) => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Dashboard http://localhost:${PORT}/`);
      if (existsSync(join(IIS_DIR, "index.html"))) {
        console.log(`IIS snapshot http://localhost/employees/`);
      }
      if (snap.publishError) console.log(`IIS publish skipped: ${snap.publishError}`);
      console.log(`Employees in work: ${snap.data.totals.employees}, tasks: ${snap.data.totals.tasks}, hours: ${snap.data.kpis?.hoursInWork}, done: ${snap.data.kpis?.hoursCompleted}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
