import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR, loadSettings, saveSettings } from "./settings.mjs";
import { join } from "node:path";

export const FINDING_SECTIONS = [
  ["openPromises", "Обещания"],
  ["negativity", "Негатив"],
  ["dueThisWeek", "Срок на неделе"],
  ["ping", "Пинг"],
  ["faqCandidates", "FAQ"],
  ["customAnswers", "Прочие выводы"],
];

export const BOARD_PATH = join(DATA_DIR, "cq-agent-board.json");

function compact(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function itemText(item) {
  return String(item?.excerpt || item?.query || item?.question || item?.answer || item?.title || "").trim();
}

export function fingerprint(section, item) {
  const client = compact(item?.client || (Array.isArray(item?.clients) ? item.clients[0] : "") || "");
  const text = compact(itemText(item));
  return `${section}|${client}|${text}`;
}

export function normalizeResolved(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const section = String(raw?.section || "").trim();
    if (!FINDING_SECTIONS.some(([k]) => k === section)) continue;
    const item = {
      id: String(raw?.id || "").trim(),
      section,
      client: String(raw?.client || "").trim(),
      title: String(raw?.title || raw?.excerpt || "").trim().slice(0, 240),
      fingerprint: String(raw?.fingerprint || fingerprint(section, raw)).trim(),
      resolvedAt: String(raw?.resolvedAt || new Date().toISOString()),
      item: raw?.item && typeof raw.item === "object" ? raw.item : null,
    };
    const key = item.fingerprint || `${section}|${item.id}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function isResolvedItem(section, item, resolved) {
  const id = String(item?.id || "").trim();
  const fp = fingerprint(section, item);
  return (resolved || []).some(
    (r) =>
      r.section === section &&
      ((id && r.id && r.id === id) || (fp && r.fingerprint && r.fingerprint === fp))
  );
}

export function filterBoard(board, resolved) {
  if (!board || typeof board !== "object") return board;
  const next = { ...board };
  for (const [section] of FINDING_SECTIONS) {
    const rows = Array.isArray(board[section]) ? board[section] : [];
    next[section] = rows.filter((item) => !isResolvedItem(section, item, resolved));
  }
  return next;
}

export function flattenBoard(board) {
  const rows = [];
  if (!board || typeof board !== "object") return rows;
  for (const [section, label] of FINDING_SECTIONS) {
    for (const item of Array.isArray(board[section]) ? board[section] : []) {
      rows.push({
        id: String(item?.id || "").trim(),
        section,
        sectionLabel: label,
        client: String(item?.client || (Array.isArray(item?.clients) ? item.clients.join(", ") : "") || "").trim(),
        title: itemText(item).slice(0, 240),
        fingerprint: fingerprint(section, item),
        item,
      });
    }
  }
  return rows;
}

export function readLastBoard() {
  if (!existsSync(BOARD_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BOARD_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeLastBoard(board) {
  writeFileSync(BOARD_PATH, JSON.stringify(board, null, 2), "utf8");
}

export function resolvedList(settings) {
  return normalizeResolved(settings?.resolvedItems);
}

export function markResolved(settings, items) {
  const current = resolvedList(settings);
  const extra = normalizeResolved(
    (items || []).map((it) => ({
      ...it,
      item: it.item || it,
      resolvedAt: new Date().toISOString(),
    }))
  );
  const next = normalizeResolved([...current, ...extra]);
  const saved = saveSettings({ ...loadSettings(), resolvedItems: next });
  return resolvedList(saved);
}

export function reopenResolved(settings, fingerprints) {
  const drop = new Set((fingerprints || []).map((x) => String(x)));
  const current = resolvedList(settings);
  const restoring = current.filter((r) => drop.has(r.fingerprint) || drop.has(r.id));
  const next = current.filter((r) => !drop.has(r.fingerprint) && !drop.has(r.id));
  const saved = saveSettings({ ...loadSettings(), resolvedItems: next });
  const board = readLastBoard() || {};
  for (const r of restoring) {
    if (!r.section) continue;
    const row = r.item && typeof r.item === "object" ? r.item : { id: r.id, client: r.client, excerpt: r.title };
    const list = Array.isArray(board[r.section]) ? board[r.section] : [];
    const fp = fingerprint(r.section, row);
    if (!list.some((x) => fingerprint(r.section, x) === fp || (row.id && x.id === row.id))) {
      board[r.section] = [...list, row];
    }
  }
  if (restoring.length) writeLastBoard(board);
  return resolvedList(saved);
}

export function resolvedPromptBlock(resolved) {
  if (!resolved?.length) return "Закрытых пунктов нет.";
  return resolved
    .map(
      (r, i) =>
        `${i + 1}. [${r.section}] ${r.client || "—"} — ${r.title || r.fingerprint}${r.id ? ` (id: ${r.id})` : ""}`
    )
    .join("\n");
}
