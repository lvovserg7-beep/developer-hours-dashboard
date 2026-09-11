import { loadSettings, saveSettings, tvSectionsFromQuestions } from "./settings.mjs";
import { DIGEST_PATH, syncClientChats } from "./sync-chats.mjs";
import { runCursorAgent } from "./agent-runner.mjs";
import { filterBoard, resolvedList, writeLastBoard } from "./resolved.mjs";

function ymdInTz(d, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value;
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function startOfIsoWeek(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

export async function postBoard(settings, board) {
  const base = String(settings.cukUrl || "").replace(/\/+$/, "");
  const token = settings.ingestToken || process.env.CLIENT_QUALITY_INGEST_TOKEN || "";
  if (!base) throw new Error("Не задан адрес боевого ЦУК");
  if (!token) throw new Error("Не задан CLIENT_QUALITY_INGEST_TOKEN");
  const tz = settings.timezone || "Europe/Moscow";
  const today = ymdInTz(new Date(), tz);
  const weekFrom = startOfIsoWeek(today);
  const body = {
    replace: true,
    source: "cq-agent",
    period: board.period || { from: today, to: today },
    week: board.week || { from: weekFrom, to: today },
    stats: board.stats || {},
    managers: board.managers || [],
    openPromises: board.openPromises || [],
    negativity: board.negativity || [],
    dueThisWeek: board.dueThisWeek || [],
    ping: board.ping || [],
    faqCandidates: board.faqCandidates || [],
    customAnswers: board.customAnswers || [],
    tvSections: tvSectionsFromQuestions(settings.questions),
    events: Array.isArray(board.events) && board.events.length
      ? board.events
      : [{ type: "board", at: new Date().toISOString() }],
  };
  const res = await fetch(`${base}/api/clientquality/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Client-Quality-Token": token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ЦУК ${res.status}: ${text.slice(0, 280)}`);
  }
  return JSON.parse(text);
}

/**
 * @param {{ force?: boolean, slot?: string }} [opts]
 */
export async function runTick(opts = {}) {
  const settings = loadSettings();
  const started = Date.now();
  const tick = {
    at: new Date().toISOString(),
    ok: false,
    error: "",
    chats: 0,
    messages: 0,
    newMessages: 0,
    ms: 0,
    forced: Boolean(opts.force),
  };
  try {
    const sync = await syncClientChats(settings);
    tick.chats = sync.chats;
    tick.messages = sync.messages;
    tick.newMessages = sync.newMessages;
    const { board } = await runCursorAgent(settings, DIGEST_PATH);
    const filtered = filterBoard(board, resolvedList(settings));
    filtered.tvSections = tvSectionsFromQuestions(settings.questions);
    writeLastBoard(filtered);
    await postBoard(settings, filtered);
    tick.ok = true;
  } catch (err) {
    tick.error = String(err.message || err);
    throw err;
  } finally {
    tick.ms = Date.now() - started;
    const latest = loadSettings();
    latest.lastTick = tick;
    if (tick.ok && opts.slot) latest.lastSlot = opts.slot;
    saveSettings(latest);
  }
  return tick;
}
