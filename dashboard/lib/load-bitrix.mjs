import { bitrixAll, bitrixCall, bitrixConfig, bitrixArchiveDealCategoryIds, bitrixDealFilterWithoutArchive } from "./bitrix.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** @param {"today"|"yesterday"|"week"|"month"|"custom"} preset */
export function resolveBitrixRange(preset, fromRaw, toRaw) {
  const today = startOfLocalDay(new Date());
  let from;
  let to;
  let resolved = preset || "week";

  if (resolved === "today") {
    from = today;
    to = today;
  } else if (resolved === "yesterday") {
    from = new Date(today.getTime() - DAY_MS);
    to = from;
  } else if (resolved === "month") {
    to = today;
    from = new Date(today.getTime() - 29 * DAY_MS);
  } else if (resolved === "custom") {
    from = parseYmd(fromRaw);
    to = parseYmd(toRaw);
    if (!from || !to) throw new Error("Укажите период с и по");
    if (from > to) throw new Error("Дата «с» не может быть позже «по»");
  } else {
    resolved = "week";
    to = today;
    from = new Date(today.getTime() - 6 * DAY_MS);
  }

  return {
    preset: resolved,
    from: ymd(from),
    to: ymd(to),
    fromIso: `${ymd(from)}T00:00:00`,
    toIso: `${ymd(to)}T23:59:59`,
  };
}

export function defaultBitrixRange() {
  return resolveBitrixRange("week");
}

function userDisplayName(user) {
  if (!user) return "";
  const parts = [user.LAST_NAME, user.NAME, user.SECOND_NAME].map((x) => String(x || "").trim()).filter(Boolean);
  return parts.join(" ") || String(user.EMAIL || "").trim() || `ID ${user.ID}`;
}

async function loadUserNames(ids) {
  const needed = new Set(ids.map(String).filter((id) => id && id !== "0"));
  const map = new Map();
  if (!needed.size) return map;

  const active = await bitrixAll("user.get", { filter: { ACTIVE: true } }, { maxPages: 20 });
  for (const u of active) {
    if (!u?.ID) continue;
    const id = String(u.ID);
    if (needed.has(id)) map.set(id, userDisplayName(u));
  }

  const missing = [...needed].filter((id) => !map.has(id));
  for (const id of missing) {
    try {
      const data = await bitrixCall("user.get", { ID: id });
      const list = Array.isArray(data.result) ? data.result : data.result ? [data.result] : [];
      if (list[0]) map.set(id, userDisplayName(list[0]));
    } catch {
      /* оставляем подпись ID */
    }
  }
  return map;
}

async function loadStageSemantics() {
  const statuses = await bitrixAll("crm.status.list", {}, { maxPages: 20 });
  const dealWon = new Set();
  const dealLose = new Set();
  const leadWon = new Set();
  for (const row of statuses) {
    const entity = String(row.ENTITY_ID || "");
    const id = String(row.STATUS_ID || "");
    const sem = String(row.SEMANTICS || "");
    if (entity === "DEAL_STAGE" || entity.startsWith("DEAL_STAGE")) {
      if (sem === "S" || /(?:^|:)WON$/i.test(id)) {
        dealWon.add(id);
        dealWon.add(id.includes(":") ? id.split(":").pop() : id);
      }
      if (sem === "F" || /(?:^|:)(LOSE|LOST|APOLOGY)$/i.test(id)) {
        dealLose.add(id);
        dealLose.add(id.includes(":") ? id.split(":").pop() : id);
      }
    }
    if (entity === "STATUS") {
      if (sem === "S" || id === "CONVERTED") leadWon.add(id);
    }
  }
  if (!dealWon.size) dealWon.add("WON");
  if (!dealLose.size) dealLose.add("LOSE");
  if (!leadWon.size) leadWon.add("CONVERTED");
  return { dealWon, dealLose, leadWon };
}

function stageTail(stageId) {
  const id = String(stageId || "");
  return id.includes(":") ? id.split(":").pop() : id;
}

function isDealWon(stageId, stages) {
  const id = String(stageId || "");
  return stages.dealWon.has(id) || stages.dealWon.has(stageTail(id)) || /(?:^|:)WON$/i.test(id);
}

function isDealLost(stageId, stages) {
  const id = String(stageId || "");
  return stages.dealLose.has(id) || stages.dealLose.has(stageTail(id)) || /(?:^|:)(LOSE|LOST|APOLOGY)$/i.test(id);
}

function isLeadConverted(statusId, stages) {
  const id = String(statusId || "");
  return stages.leadWon.has(id) || id === "CONVERTED";
}

function bump(map, key, amount = 1) {
  const k = String(key || "0");
  map.set(k, (map.get(k) || 0) + amount);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(v) {
  return Math.round((money(v) + Number.EPSILON) * 100) / 100;
}

function chartRows(countById, nameById) {
  return [...countById.entries()]
    .map(([id, total]) => ({
      id,
      name: nameById.get(id) || (id === "0" ? "Без ответственного" : `ID ${id}`),
      total,
      segments: { Всего: total },
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ru"));
}

function moneyRows(sumById, nameById, segmentLabel = "Сумма") {
  return [...sumById.entries()]
    .map(([id, total]) => ({
      id,
      name: nameById.get(id) || (id === "0" ? "Без ответственного" : `ID ${id}`),
      total: roundMoney(total),
      segments: { [segmentLabel]: roundMoney(total) },
    }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ru"));
}

function stackedRows(wonById, loseById, nameById) {
  const ids = new Set([...wonById.keys(), ...loseById.keys()]);
  return [...ids]
    .map((id) => {
      const won = wonById.get(id) || 0;
      const lose = loseById.get(id) || 0;
      return {
        id,
        name: nameById.get(id) || (id === "0" ? "Без ответственного" : `ID ${id}`),
        total: won + lose,
        segments: { Выигранные: won, Проигранные: lose },
      };
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "ru"));
}

function sumMap(map) {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

function isDealInWork(deal, stages) {
  const semantic = String(deal.STAGE_SEMANTIC_ID || "").toUpperCase();
  if (semantic === "P" || semantic === "PROCESS") return true;
  if (semantic === "S" || semantic === "F") return false;
  if (String(deal.CLOSED || "") === "Y") return false;
  if (isDealWon(deal.STAGE_ID, stages) || isDealLost(deal.STAGE_ID, stages)) return false;
  return true;
}

/**
 * Аналитика CRM Bitrix24 по менеджерам за период.
 * @param {{ preset?: string, from?: string, to?: string }} opts
 */
export async function loadBitrixAnalytics(opts = {}) {
  const range = resolveBitrixRange(opts.preset, opts.from, opts.to);
  const { host } = bitrixConfig();
  const [stages, archiveCategories] = await Promise.all([
    loadStageSemantics(),
    bitrixArchiveDealCategoryIds().catch(() => []),
  ]);
  const noArchive = (filter) => bitrixDealFilterWithoutArchive(filter, archiveCategories);

  const [calls, dealsCreated, leadsCreated, leadsClosed, dealsClosed, dealsOpen] = await Promise.all([
    bitrixAll(
      "voximplant.statistic.get",
      {
        FILTER: {
          ">=CALL_START_DATE": range.fromIso,
          "<=CALL_START_DATE": range.toIso,
        },
        SORT: "CALL_START_DATE",
        ORDER: "ASC",
      },
      { maxPages: 100 }
    ),
    bitrixAll(
      "crm.deal.list",
      {
        filter: noArchive({
          ">=DATE_CREATE": range.fromIso,
          "<=DATE_CREATE": range.toIso,
        }),
        select: ["ID", "ASSIGNED_BY_ID", "DATE_CREATE", "STAGE_ID", "OPPORTUNITY", "CATEGORY_ID"],
        order: { DATE_CREATE: "ASC" },
      },
      { maxPages: 100 }
    ),
    bitrixAll(
      "crm.lead.list",
      {
        filter: {
          ">=DATE_CREATE": range.fromIso,
          "<=DATE_CREATE": range.toIso,
        },
        select: ["ID", "ASSIGNED_BY_ID", "DATE_CREATE", "STATUS_ID"],
        order: { DATE_CREATE: "ASC" },
      },
      { maxPages: 100 }
    ),
    bitrixAll(
      "crm.lead.list",
      {
        filter: {
          ">=DATE_CLOSED": range.from,
          "<=DATE_CLOSED": range.to,
        },
        select: ["ID", "ASSIGNED_BY_ID", "DATE_CLOSED", "STATUS_ID"],
        order: { DATE_CLOSED: "ASC" },
      },
      { maxPages: 50 }
    ),
    bitrixAll(
      "crm.deal.list",
      {
        filter: noArchive({
          ">=CLOSEDATE": range.from,
          "<=CLOSEDATE": range.to,
          CLOSED: "Y",
        }),
        select: ["ID", "ASSIGNED_BY_ID", "CLOSEDATE", "STAGE_ID", "OPPORTUNITY", "CATEGORY_ID"],
        order: { CLOSEDATE: "ASC" },
      },
      { maxPages: 50 }
    ),
    // Снимок воронки: открытые сделки сейчас (не привязаны к периоду отчёта)
    bitrixAll(
      "crm.deal.list",
      {
        filter: noArchive({ CLOSED: "N" }),
        select: ["ID", "ASSIGNED_BY_ID", "STAGE_ID", "STAGE_SEMANTIC_ID", "CLOSED", "OPPORTUNITY", "CURRENCY_ID", "CATEGORY_ID"],
        order: { ID: "DESC" },
      },
      { maxPages: 400 }
    ),
  ]);

  const archiveSet = new Set(archiveCategories.map(String));
  const notArchiveDeal = (row) => !archiveSet.has(String(row.CATEGORY_ID ?? "0"));
  const dealsCreatedLive = dealsCreated.filter(notArchiveDeal);
  const dealsClosedLive = dealsClosed.filter(notArchiveDeal);
  const dealsOpenLive = dealsOpen.filter(notArchiveDeal);

  const callsBy = new Map();
  const dealsBy = new Map();
  const leadsBy = new Map();
  const convertedBy = new Map();
  const wonBy = new Map();
  const loseBy = new Map();
  const openCountBy = new Map();
  const openSumBy = new Map();
  const wonSumBy = new Map();

  for (const row of calls) bump(callsBy, row.PORTAL_USER_ID);
  for (const row of dealsCreatedLive) bump(dealsBy, row.ASSIGNED_BY_ID);
  for (const row of leadsCreated) bump(leadsBy, row.ASSIGNED_BY_ID);
  for (const row of leadsClosed) {
    if (isLeadConverted(row.STATUS_ID, stages)) bump(convertedBy, row.ASSIGNED_BY_ID);
  }
  for (const row of dealsClosedLive) {
    if (isDealWon(row.STAGE_ID, stages)) {
      bump(wonBy, row.ASSIGNED_BY_ID);
      bump(wonSumBy, row.ASSIGNED_BY_ID, money(row.OPPORTUNITY));
    } else if (isDealLost(row.STAGE_ID, stages)) {
      bump(loseBy, row.ASSIGNED_BY_ID);
    }
  }
  for (const row of dealsOpenLive) {
    if (!isDealInWork(row, stages)) continue;
    bump(openCountBy, row.ASSIGNED_BY_ID);
    bump(openSumBy, row.ASSIGNED_BY_ID, money(row.OPPORTUNITY));
  }

  const warnings = [];
  if (dealsOpenLive.length >= 400 * 50) {
    warnings.push("Сделки в работе: достигнут лимит выгрузки REST (~20 000). Сумма может быть неполной.");
  }

  const nameById = await loadUserNames([
    ...callsBy.keys(),
    ...dealsBy.keys(),
    ...leadsBy.keys(),
    ...convertedBy.keys(),
    ...wonBy.keys(),
    ...loseBy.keys(),
    ...openCountBy.keys(),
    ...openSumBy.keys(),
  ]);

  const totals = {
    calls: sumMap(callsBy),
    deals: sumMap(dealsBy),
    leads: sumMap(leadsBy),
    convertedLeads: sumMap(convertedBy),
    wonDeals: sumMap(wonBy),
    lostDeals: sumMap(loseBy),
    openDeals: sumMap(openCountBy),
    openDealsSum: roundMoney(sumMap(openSumBy)),
    wonDealsSum: roundMoney(sumMap(wonSumBy)),
  };

  const gaugeMax = Math.max(50, Math.ceil(Math.max(totals.calls, totals.deals, totals.leads) / 50) * 50);

  return {
    generatedAt: new Date().toISOString(),
    source: "Bitrix24",
    host,
    period: {
      preset: range.preset,
      from: range.from,
      to: range.to,
    },
    kpis: {
      calls: totals.calls,
      deals: totals.deals,
      leads: totals.leads,
      convertedLeads: totals.convertedLeads,
      wonDeals: totals.wonDeals,
      lostDeals: totals.lostDeals,
      openDeals: totals.openDeals,
      openDealsSum: totals.openDealsSum,
      wonDealsSum: totals.wonDealsSum,
      gaugeValue: totals.calls,
      gaugeMax,
    },
    charts: {
      callsByManager: chartRows(callsBy, nameById),
      dealsByManager: chartRows(dealsBy, nameById),
      leadsByManager: chartRows(leadsBy, nameById),
      convertedLeadsByManager: chartRows(convertedBy, nameById),
      closedDealsByManager: stackedRows(wonBy, loseBy, nameById),
      openDealsSumByManager: moneyRows(openSumBy, nameById, "В работе"),
      wonDealsSumByManager: moneyRows(wonSumBy, nameById, "Выиграно"),
    },
    note:
      "Звонки — статистика телефонии за период. Сделки и лиды — по дате создания. " +
      "Выигранные лиды — статус «качественный» / конвертация в сделку по дате закрытия. " +
      "Выигранные и проигранные сделки — по дате закрытия и семантике стадии. " +
      "Сделки в работе (шт и ₽) — текущий снимок открытой воронки, не фильтр периода.",
    warnings,
  };
}
