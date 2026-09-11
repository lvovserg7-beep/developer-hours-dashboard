import { bitrixAll, bitrixCall, bitrixConfig, bitrixArchiveDealCategoryIds, bitrixDealFilterWithoutArchive } from "./bitrix.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const INACTIVE_DAYS = 3;
const MISSED_CALLS_THRESHOLD = 3;
const MISSED_CALL_LOOKBACK_DAYS = 60;
const CALL_TYPE_OUTGOING = "1";

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseBitrixDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nonemptyId(v) {
  const s = String(v ?? "").trim();
  return s && s !== "0" ? s : "";
}

function userDisplayName(user) {
  if (!user) return "";
  const parts = [user.LAST_NAME, user.NAME, user.SECOND_NAME].map((x) => String(x || "").trim()).filter(Boolean);
  return parts.join(" ") || String(user.EMAIL || "").trim() || `ID ${user.ID}`;
}

async function loadUserNames(ids) {
  const needed = new Set([...ids].map(String).filter((id) => id && id !== "0"));
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
      /* ID в подписи */
    }
  }
  return map;
}

async function bitrixTasksAll(filter, select, opts = {}) {
  const maxPages = opts.maxPages ?? 40;
  const rows = [];
  let start = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await bitrixCall("tasks.task.list", {
      filter,
      select,
      order: { DEADLINE: "ASC" },
      start,
    });
    const chunk = data.result?.tasks || [];
    rows.push(...chunk);
    if (data.next == null || !chunk.length) break;
    start = data.next;
  }
  return rows;
}

function bump(map, key, amount = 1) {
  const k = String(key || "0");
  map.set(k, (map.get(k) || 0) + amount);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, label = "Bitrix") {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || err);
      if (!/Too many requests|QUERY_LIMIT/i.test(msg) || attempt === 5) throw err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function loadEntitiesByIds(method, ids, select) {
  const map = new Map();
  const list = [...new Set([...ids].map(String).filter((id) => id && id !== "0"))];
  for (let i = 0; i < list.length; i += 50) {
    const part = list.slice(i, i + 50);
    const rows = await withRetry(
      () => bitrixAll(method, { filter: { ID: part }, select }, { maxPages: 3 }),
      method
    );
    for (const row of rows) {
      if (row?.ID) map.set(String(row.ID), row);
    }
    if (i + 50 < list.length) await sleep(200);
  }
  return map;
}

function hasPhoneValue(entity) {
  if (!entity) return false;
  if (String(entity.HAS_PHONE || "").toUpperCase() === "Y") return true;
  const phone = entity.PHONE;
  if (Array.isArray(phone) && phone.some((p) => String(p?.VALUE || "").trim())) return true;
  return false;
}

function isMissedOutgoingCall(call) {
  if (String(call.CALL_TYPE) !== CALL_TYPE_OUTGOING) return false;
  const code = String(call.CALL_FAILED_CODE || "");
  if (code && code !== "200") return true;
  return Number(call.CALL_DURATION) === 0;
}

function isTaskCompleted(task) {
  const status = Number(task.status ?? task.STATUS);
  return status === 5 || status === 4;
}

function isTaskOverdue(task, now) {
  if (isTaskCompleted(task)) return false;
  const deadline = parseBitrixDate(task.deadline || task.DEADLINE);
  if (!deadline) return false;
  return deadline.getTime() < now.getTime();
}

function crmDealIdFromTodo(activity) {
  if (String(activity?.OWNER_TYPE_ID) !== "2") return "";
  return nonemptyId(activity?.OWNER_ID);
}

function emptyManager() {
  return {
    dealsOpen: 0,
    dealsFilledOk: 0,
    leadsInactive3d: 0,
    leadsMissedCalls3: 0,
    dealsWithoutTask: 0,
    tasksOverdue: 0,
  };
}

/**
 * «Чистота ведения Битрикс» — снимок качества CRM по менеджерам.
 * ННН = ИНН в реквизитах компании/контакта сделки.
 */
export async function loadBitrixFrequency() {
  const { host } = bitrixConfig();
  const now = new Date();
  const inactiveBefore = new Date(now.getTime() - INACTIVE_DAYS * DAY_MS);
  const callsFrom = startOfLocalDay(new Date(now.getTime() - MISSED_CALL_LOOKBACK_DAYS * DAY_MS));
  const warnings = [];

  const archiveCategories = await bitrixArchiveDealCategoryIds().catch(() => []);
  const noArchive = (filter) => bitrixDealFilterWithoutArchive(filter, archiveCategories);

  const [dealsOpen, leadsOpen] = await Promise.all([
    bitrixAll(
      "crm.deal.list",
      {
        filter: noArchive({ CLOSED: "N" }),
        select: ["ID", "TITLE", "ASSIGNED_BY_ID", "OPPORTUNITY", "COMPANY_ID", "CONTACT_ID", "CATEGORY_ID"],
        order: { ID: "DESC" },
      },
      { maxPages: 200 }
    ),
    bitrixAll(
      "crm.lead.list",
      {
        filter: { STATUS_SEMANTIC_ID: "P" },
        select: ["ID", "TITLE", "ASSIGNED_BY_ID", "DATE_CREATE", "DATE_MODIFY", "LAST_ACTIVITY_TIME"],
        order: { ID: "DESC" },
      },
      { maxPages: 40 }
    ),
  ]);

  const archiveSet = new Set(archiveCategories.map(String));
  const dealsOpenLive = dealsOpen.filter((d) => !archiveSet.has(String(d.CATEGORY_ID ?? "0")));

  const contactIds = new Set();
  const companyIds = new Set();
  for (const deal of dealsOpenLive) {
    const c = nonemptyId(deal.CONTACT_ID);
    const co = nonemptyId(deal.COMPANY_ID);
    if (c) contactIds.add(c);
    if (co) companyIds.add(co);
  }

  const [requisites, calls, tasksOpen, crmTodosOpen] = await Promise.all([
    withRetry(
      () =>
        bitrixAll(
          "crm.requisite.list",
          {
            filter: { "!RQ_INN": "" },
            select: ["ENTITY_TYPE_ID", "ENTITY_ID", "RQ_INN"],
            order: { ID: "DESC" },
          },
          { maxPages: 40 }
        ),
      "requisite"
    ).catch((err) => {
      warnings.push(`Реквизиты ИНН: ${String(err.message || err).slice(0, 160)}`);
      return [];
    }),
    withRetry(
      () =>
        bitrixAll(
          "voximplant.statistic.get",
          {
            FILTER: {
              ">=CALL_START_DATE": `${ymd(callsFrom)}T00:00:00`,
              CALL_TYPE: CALL_TYPE_OUTGOING,
            },
            SORT: "CALL_START_DATE",
            ORDER: "ASC",
          },
          { maxPages: 60 }
        ),
      "calls"
    ).catch((err) => {
      warnings.push(`Звонки: ${String(err.message || err).slice(0, 160)}`);
      return [];
    }),
    withRetry(
      () =>
        bitrixTasksAll(
          { REAL_STATUS: [1, 2, 3, 6] },
          ["ID", "RESPONSIBLE_ID", "DEADLINE", "STATUS"],
          { maxPages: 40 }
        ),
      "tasks"
    ).catch((err) => {
      warnings.push(`Задачи: ${String(err.message || err).slice(0, 160)}`);
      return [];
    }),
    withRetry(
      () =>
        bitrixAll(
          "crm.activity.list",
          {
            filter: {
              PROVIDER_ID: "CRM_TODO",
              COMPLETED: "N",
              OWNER_TYPE_ID: 2,
            },
            select: ["ID", "OWNER_TYPE_ID", "OWNER_ID", "COMPLETED", "PROVIDER_ID"],
            order: { ID: "DESC" },
          },
          { maxPages: 80 }
        ),
      "crm-todo"
    ).catch((err) => {
      warnings.push(`Задачи CRM: ${String(err.message || err).slice(0, 160)}`);
      return [];
    }),
  ]);

  await sleep(400);
  const contacts = await loadEntitiesByIds("crm.contact.list", contactIds, ["ID", "HAS_PHONE"]).catch((err) => {
    warnings.push(`Контакты: ${String(err.message || err).slice(0, 160)}`);
    return new Map();
  });
  await sleep(400);
  const companies = await loadEntitiesByIds("crm.company.list", companyIds, ["ID", "HAS_PHONE"]).catch((err) => {
    warnings.push(`Компании: ${String(err.message || err).slice(0, 160)}`);
    return new Map();
  });

  const innContacts = new Set();
  const innCompanies = new Set();
  for (const row of requisites) {
    const inn = String(row.RQ_INN || "").replace(/\D/g, "");
    if (inn.length < 10) continue;
    const ent = String(row.ENTITY_TYPE_ID);
    const id = nonemptyId(row.ENTITY_ID);
    if (!id) continue;
    if (ent === "3") innContacts.add(id);
    if (ent === "4") innCompanies.add(id);
  }

  const openLeadIds = new Set(leadsOpen.map((l) => String(l.ID)));
  const missedByLead = new Map();
  for (const call of calls) {
    if (String(call.CRM_ENTITY_TYPE || "").toUpperCase() !== "LEAD") continue;
    if (!isMissedOutgoingCall(call)) continue;
    const leadId = nonemptyId(call.CRM_ENTITY_ID);
    if (!leadId || !openLeadIds.has(leadId)) continue;
    bump(missedByLead, leadId, 1);
  }

  const dealsWithOpenCrmTodo = new Set();
  for (const activity of crmTodosOpen) {
    const dealId = crmDealIdFromTodo(activity);
    if (dealId) dealsWithOpenCrmTodo.add(dealId);
  }

  const byManager = new Map();
  const ensure = (id) => {
    const key = String(id || "0");
    if (!byManager.has(key)) byManager.set(key, emptyManager());
    return byManager.get(key);
  };

  for (const deal of dealsOpenLive) {
    const mgr = ensure(deal.ASSIGNED_BY_ID);
    mgr.dealsOpen += 1;

    const contactId = nonemptyId(deal.CONTACT_ID);
    const companyId = nonemptyId(deal.COMPANY_ID);
    const hasCounterparty = Boolean(contactId || companyId);
    const hasSum = money(deal.OPPORTUNITY) > 0;
    const hasInn =
      (contactId && innContacts.has(contactId)) || (companyId && innCompanies.has(companyId));
    const hasPhone =
      (contactId && hasPhoneValue(contacts.get(contactId))) ||
      (companyId && hasPhoneValue(companies.get(companyId)));

    if (hasCounterparty && hasPhone && hasInn && hasSum) {
      mgr.dealsFilledOk += 1;
    }

    if (!dealsWithOpenCrmTodo.has(String(deal.ID))) {
      mgr.dealsWithoutTask += 1;
    }
  }

  for (const lead of leadsOpen) {
    const mgr = ensure(lead.ASSIGNED_BY_ID);
    const activityAt =
      parseBitrixDate(lead.LAST_ACTIVITY_TIME) ||
      parseBitrixDate(lead.DATE_MODIFY) ||
      parseBitrixDate(lead.DATE_CREATE);
    if (!activityAt || activityAt.getTime() < inactiveBefore.getTime()) {
      mgr.leadsInactive3d += 1;
    }
    if ((missedByLead.get(String(lead.ID)) || 0) > MISSED_CALLS_THRESHOLD) {
      mgr.leadsMissedCalls3 += 1;
    }
  }

  for (const task of tasksOpen) {
    if (!isTaskOverdue(task, now)) continue;
    const mgr = ensure(task.responsibleId || task.RESPONSIBLE_ID);
    mgr.tasksOverdue += 1;
  }

  const nameById = await loadUserNames(byManager.keys());
  const managers = [...byManager.entries()]
    .map(([id, row]) => ({
      id,
      name: nameById.get(id) || (id === "0" ? "Без ответственного" : `ID ${id}`),
      ...row,
    }))
    .filter(
      (r) =>
        r.dealsOpen ||
        r.dealsFilledOk ||
        r.leadsInactive3d ||
        r.leadsMissedCalls3 ||
        r.dealsWithoutTask ||
        r.tasksOverdue
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const totals = managers.reduce(
    (acc, row) => {
      acc.dealsOpen += row.dealsOpen;
      acc.dealsFilledOk += row.dealsFilledOk;
      acc.leadsInactive3d += row.leadsInactive3d;
      acc.leadsMissedCalls3 += row.leadsMissedCalls3;
      acc.dealsWithoutTask += row.dealsWithoutTask;
      acc.tasksOverdue += row.tasksOverdue;
      return acc;
    },
    emptyManager()
  );

  return {
    generatedAt: new Date().toISOString(),
    host,
    snapshot: true,
    rules: {
      filledDeal: "Открытая сделка: контрагент (компания или контакт), телефон, ИНН в реквизитах, сумма > 0",
      inactiveLead: `Открытый лид без активности ${INACTIVE_DAYS}+ дн. (LAST_ACTIVITY_TIME / DATE_MODIFY)`,
      missedCalls: `Открытый лид с более чем ${MISSED_CALLS_THRESHOLD} исходящими недозвонами за ${MISSED_CALL_LOOKBACK_DAYS} дн. (код ≠ 200 или длительность 0)`,
      dealWithoutTask: "Открытая сделка без незакрытой задачи CRM (дело в карточке сделки, не задача модуля Задачи)",
      overdueTask: "Незавершённая задача с дедлайном раньше текущего момента",
    },
    totals: {
      ...totals,
      leadsOpen: leadsOpen.length,
      managers: managers.length,
    },
    managers,
    warnings: [...new Set(warnings.filter(Boolean))],
    note:
      "Снимок на сейчас: открытые сделки и лиды, просроченные задачи модуля Задачи, недозвоны по лидам. " +
      "«Сделки без задачи» — нет незакрытого дела CRM в карточке сделки. «ННН» = ИНН в реквизитах контакта/компании, привязанных к сделке.",
  };
}
