import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, loadSettings, publicSettings, saveSettings, tvSectionsFromQuestions } from "./lib/settings.mjs";
import { postBoard, runTick } from "./lib/run-tick.mjs";
import {
  filterBoard,
  flattenBoard,
  markResolved,
  readLastBoard,
  reopenResolved,
  resolvedList,
  writeLastBoard,
} from "./lib/resolved.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(root, "public");
const HOST = "127.0.0.1";
const PORT = Number(process.env.CQ_AGENT_PORT || 8791);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let ticking = false;
let timer = null;

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function serveStatic(req, res) {
  let rel = req.url.split("?")[0];
  if (rel === "/") rel = "/index.html";
  if (rel === "/resolved") rel = "/resolved.html";
  const file = join(PUBLIC, rel.replace(/\.\./g, ""));
  if (!file.startsWith(PUBLIC) || !existsSync(file) || statSync(file).isDirectory()) {
    return send(res, 404, "Not found");
  }
  return send(res, 200, readFileSync(file), TYPES[extname(file)] || "application/octet-stream");
}

const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function currentSlot(settings) {
  const tz = settings.timezone || "Europe/Moscow";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const isoDow = WD[parts.weekday];
  if (!settings.days?.includes(isoDow)) return null;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const [fromH, fromM] = String(settings.timeFrom || "09:00").split(":").map(Number);
  const [toH, toM] = String(settings.timeTo || "18:00").split(":").map(Number);
  const nowMin = hour * 60 + minute;
  const fromMin = fromH * 60 + (fromM || 0);
  const toMin = toH * 60 + (toM || 0);
  if (nowMin < fromMin || nowMin >= toMin) return null;
  const interval = Math.max(1, Number(settings.intervalHours) || 2) * 60;
  const slotMin = fromMin + Math.floor((nowMin - fromMin) / interval) * interval;
  const sh = String(Math.floor(slotMin / 60)).padStart(2, "0");
  const sm = String(slotMin % 60).padStart(2, "0");
  const ymd = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  return `${ymd}T${sh}:${sm}`;
}

function missingConfig(settings) {
  const miss = [];
  if (!String(settings.cukUrl || "").trim()) miss.push("ЦУК");
  if (!(settings.ingestToken || process.env.CLIENT_QUALITY_INGEST_TOKEN)) miss.push("токен");
  if (!(settings.cursorApiKey || process.env.CURSOR_API_KEY)) miss.push("ключ Cursor");
  return miss;
}

function isConfigured(settings) {
  return missingConfig(settings).length === 0;
}

function recentFailedTick(settings, ms) {
  const t = settings.lastTick;
  if (!t || t.ok) return false;
  const at = Date.parse(t.at || "");
  return Number.isFinite(at) && Date.now() - at < ms;
}

async function maybeScheduledTick() {
  if (ticking) return;
  const settings = loadSettings();
  if (!isConfigured(settings)) return;
  if (recentFailedTick(settings, 5 * 60 * 1000)) return;
  const slot = currentSlot(settings);
  if (!slot || slot === settings.lastSlot) return;
  ticking = true;
  console.log("cq-agent scheduled tick", slot);
  try {
    await runTick({ slot });
    console.log("cq-agent tick ok", slot);
  } catch (err) {
    console.error("cq-agent tick failed:", err.message || err);
  } finally {
    ticking = false;
  }
}

function armTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    maybeScheduledTick().catch((err) => console.error(err));
  }, 30_000);
}

const server = createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (url === "/api/settings" && req.method === "GET") {
      return json(res, 200, publicSettings(loadSettings()));
    }
    if (url === "/api/settings" && req.method === "PUT") {
      const patch = await readJson(req);
      const next = saveSettings(applyPatch(loadSettings(), patch));
      const board = readLastBoard();
      if (board && next.cukUrl && (next.ingestToken || process.env.CLIENT_QUALITY_INGEST_TOKEN)) {
        board.tvSections = tvSectionsFromQuestions(next.questions);
        writeLastBoard(board);
        try {
          await postBoard(next, board);
        } catch (err) {
          console.warn("cq-agent post after settings failed:", err.message || err);
        }
      }
      return json(res, 200, publicSettings(next));
    }
    if (url === "/api/status" && req.method === "GET") {
      const s = loadSettings();
      return json(res, 200, {
        listening: `http://${HOST}:${PORT}/`,
        configured: isConfigured(s),
        missing: missingConfig(s),
        slot: currentSlot(s),
        lastSlot: s.lastSlot,
        lastTick: s.lastTick,
        ticking,
      });
    }
    if (url === "/api/tick" && req.method === "POST") {
      if (ticking) return json(res, 409, { error: "Уже выполняется тик" });
      ticking = true;
      try {
        const slot = currentSlot(loadSettings()) || undefined;
        const tick = await runTick({ force: true, slot });
        return json(res, 200, tick);
      } catch (err) {
        const s = loadSettings();
        return json(res, 500, { error: String(err.message || err), lastTick: s.lastTick });
      } finally {
        ticking = false;
      }
    }
    if (url === "/api/board" && req.method === "GET") {
      const s = loadSettings();
      const resolved = resolvedList(s);
      const board = readLastBoard();
      const open = flattenBoard(board).filter(
        (row) => !resolved.some((r) => r.fingerprint === row.fingerprint || (row.id && r.id === row.id && r.section === row.section))
      );
      return json(res, 200, {
        generatedAt: board?.generatedAt || board?.period || null,
        open,
        resolved,
      });
    }
    if (url === "/api/resolved" && req.method === "POST") {
      const patch = await readJson(req);
      const action = String(patch.action || "resolve");
      const s = loadSettings();
      let resolved;
      if (action === "reopen") {
        resolved = reopenResolved(s, patch.fingerprints || patch.ids || []);
      } else {
        resolved = markResolved(s, patch.items || []);
      }
      const board = readLastBoard();
      let posted = false;
      if (board) {
        const filtered = filterBoard(board, resolved);
        writeLastBoard(filtered);
        if (s.cukUrl && (s.ingestToken || process.env.CLIENT_QUALITY_INGEST_TOKEN)) {
          try {
            await postBoard(s, filtered);
            posted = true;
          } catch (err) {
            console.warn("cq-agent post after resolve failed:", err.message || err);
          }
        }
      }
      return json(res, 200, { resolved, posted, open: flattenBoard(readLastBoard()) });
    }
    if (req.method === "GET") return serveStatic(req, res);
    return json(res, 405, { error: "Метод не поддерживается" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Сбор чатов: http://${HOST}:${PORT}/`);
  armTimer();
  maybeScheduledTick().catch((err) => console.error(err));
});
