import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { odataConfig } from "./lib/odata.mjs";
import { renderChartParts } from "./lib/render-charts.mjs";
import { loadActiveEmployees } from "./load-employees.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(join(root, "public", "index.html"), "utf8");
const PORT = Number(process.env.PORT || 8787);
const IIS_DIR = process.env.IIS_PUBLISH_DIR || "C:\\inetpub\\wwwroot\\employees";
const CACHE_MS = 10 * 60 * 1000;

let cache = { at: 0, data: null, html: "", error: null, inflight: null };

function renderHtml(data) {
  const payload = JSON.stringify(data).replace(/</g, "\\u003c");
  const parts = renderChartParts(data);
  return template
    .replace("__EMBEDDED_DATA__", payload)
    .replace("__META__", parts.meta)
    .replace("__CHART_STATUS__", parts.status)
    .replace("__CHART_KPIS__", parts.kpis)
    .replace("__CHART_DEV_WORK__", parts.devWork)
    .replace("__CHART_CLIENT_DONE__", parts.clientDone)
    .replace("__CHART_DEV_DONE__", parts.devDone);
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
      html: renderHtml(data),
      error: null,
      inflight: null,
    };
    publishToIis(cache.html);
    return cache;
  })().catch((err) => {
    cache.inflight = null;
    cache.error = String(err.message || err);
    if (!cache.data) throw err;
    return cache;
  });

  return cache.inflight;
}

function publishToIis(html) {
  try {
    mkdirSync(IIS_DIR, { recursive: true });
    writeFileSync(join(IIS_DIR, "index.html"), html, "utf8");
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

function send(res, status, body, type) {
  const buf = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(buf);
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept",
    });
    res.end();
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/employees" || url.pathname === "/api/health") {
      const snap = await refresh();
      if (url.pathname === "/api/health") {
        const { host } = odataConfig();
        return send(
          res,
          200,
          JSON.stringify({
            ok: true,
            host,
            generatedAt: snap.data?.generatedAt,
            employees: snap.data?.totals?.employees,
            iis: snap.published || snap.publishError || null,
          }),
          "application/json; charset=utf-8"
        );
      }
      return send(res, 200, JSON.stringify(snap.data), "application/json; charset=utf-8");
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const snap = await refresh();
      return send(res, 200, snap.html, "text/html; charset=utf-8");
    }

    send(res, 404, "Not found", "text/plain; charset=utf-8");
  } catch (err) {
    send(res, 502, `<!DOCTYPE html><meta charset="utf-8"><title>Ошибка 1С</title><pre>${String(err.message || err).replace(/</g, "&lt;")}</pre>`, "text/html; charset=utf-8");
  }
});

const { host } = odataConfig();
console.log(`Connecting via DNS ${host}`);
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
