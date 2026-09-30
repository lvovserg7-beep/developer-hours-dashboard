#!/usr/bin/env node
/**
 * Как приходят звонки сотрудника в Bitrix24 (телефония vs дела CRM).
 * Секрет webhook не печатает. Телефоны маскирует.
 *
 *   node dashboard/scripts/bitrix-inspect-calls.mjs Шалагинов
 */
import { bitrixAll, bitrixCall, bitrixHealth } from "../lib/bitrix.mjs";
import { nonemptyUserId, managerIdFromVoxRow, resolveBitrixRange } from "../lib/load-bitrix.mjs";

const LAST = String(process.argv[2] || "Шалагинов").trim();
const DAYS = Number(process.argv[3] || 30);

function maskPhone(value) {
  const s = String(value || "").replace(/\s+/g, "");
  if (s.length < 5) return "****";
  return `${s.slice(0, 2)}***${s.slice(-4)}`;
}

function userLabel(u) {
  if (!u) return "";
  return [u.LAST_NAME, u.NAME, u.SECOND_NAME].map((x) => String(x || "").trim()).filter(Boolean).join(" ")
    || String(u.EMAIL || "")
    || `ID ${u.ID}`;
}

function isoDaysAgo(days) {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { from: ymd(from), to: ymd(to) };
}

async function findUsers(lastName) {
  const found = new Map();
  const queries = [
    { FILTER: { LAST_NAME: lastName }, ADMIN_MODE: true },
    { FILTER: { NAME: lastName }, ADMIN_MODE: true },
    { FILTER: { EMAIL: "sml@alsn.ru" }, ADMIN_MODE: true },
    { NAME_SEARCH: lastName, ADMIN_MODE: true },
  ];
  for (const params of queries) {
    try {
      const rows = await bitrixAll("user.get", params, { maxPages: 3 });
      for (const u of rows) {
        if (u?.ID) found.set(String(u.ID), u);
      }
    } catch {
      /* следующий вариант поиска */
    }
  }
  return [...found.values()];
}

async function telephonyUser(id) {
  try {
    const data = await bitrixCall("voximplant.user.get", { USER_ID: id });
    return data.result ?? data;
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  }
}

function summarizeVox(rows, userId, activityById) {
  const mineDirect = [];
  const emptyUser = [];
  const attributed = [];
  const extraOwners = new Map();
  for (const row of rows) {
    const portal = nonemptyUserId(row.PORTAL_USER_ID) || "0";
    extraOwners.set(portal, (extraOwners.get(portal) || 0) + 1);
    if (portal === String(userId)) mineDirect.push(row);
    if (portal === "0") {
      emptyUser.push(row);
      const viaCrm = managerIdFromVoxRow(row, activityById);
      if (viaCrm === String(userId)) attributed.push(row);
    }
  }
  return { mineDirect, emptyUser, attributed, extraOwners };
}

const health = await bitrixHealth();
const range = isoDaysAgo(DAYS);
const iso = resolveBitrixRange("custom", range.from, range.to);
console.log(`Портал: ${health.portal} (webhook user ${health.userId} ${health.name || ""})`);
console.log(`Поиск: ${LAST}; период ${iso.from}…${iso.to}`);

const users = await findUsers(LAST);
if (!users.length) {
  console.log("Сотрудник в user.get не найден (в т.ч. по sml@alsn.ru).");
  process.exit(2);
}

for (const u of users) {
  const id = String(u.ID);
  console.log(`\n--- ${userLabel(u)} | ID ${id} | ACTIVE=${u.ACTIVE} | EMAIL=${u.EMAIL || ""} | UF_PHONE_INNER=${u.UF_PHONE_INNER || u.UF_INNER_PHONE || ""} ---`);
  const tel = await telephonyUser(id);
  console.log("voximplant.user.get:", JSON.stringify(tel)?.slice(0, 500));

  const [vox, activities] = await Promise.all([
    bitrixAll(
      "voximplant.statistic.get",
      {
        FILTER: {
          ">=CALL_START_DATE": iso.fromIso,
          "<=CALL_START_DATE": iso.toIso,
        },
        SORT: "CALL_START_DATE",
        ORDER: "DESC",
      },
      { maxPages: 80 }
    ),
    bitrixAll(
      "crm.activity.list",
      {
        filter: {
          TYPE_ID: 2,
          RESPONSIBLE_ID: id,
          ">=START_TIME": iso.fromIso,
          "<=START_TIME": iso.toIso,
        },
        select: ["ID", "RESPONSIBLE_ID", "START_TIME", "TYPE_ID", "PROVIDER_ID", "COMPLETED", "DIRECTION"],
        order: { START_TIME: "DESC" },
      },
      { maxPages: 40 }
    ).catch((err) => {
      console.log("crm.activity.list:", String(err.message || err).slice(0, 180));
      return [];
    }),
  ]);

  const activityById = new Map();
  for (const a of activities) {
    if (a?.ID) activityById.set(String(a.ID), a);
  }

  const { mineDirect, emptyUser, attributed, extraOwners } = summarizeVox(vox, id, activityById);
  const topOwners = [...extraOwners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  console.log(`voximplant.statistic.get за период: всего ${vox.length}`);
  console.log(`  с PORTAL_USER_ID=${id}: ${mineDirect.length}`);
  console.log(`  с пустым PORTAL_USER_ID: ${emptyUser.length}, из них его по делу CRM: ${attributed.length}`);
  console.log(`  топ PORTAL_USER_ID в выборке: ${topOwners.map(([k, n]) => `${k}:${n}`).join(", ")}`);
  console.log(`дел CRM TYPE_ID=2 (звонок) с RESPONSIBLE_ID=${id}: ${activities.length}`);
  const byProvider = new Map();
  for (const a of activities) {
    const p = String(a.PROVIDER_ID || "—");
    byProvider.set(p, (byProvider.get(p) || 0) + 1);
  }
  console.log(`  провайдеры дел: ${[...byProvider.entries()].map(([k, n]) => `${k}:${n}`).join(", ") || "нет"}`);

  const samples = [...mineDirect, ...attributed].slice(0, 5);
  if (samples.length) {
    console.log("примеры звонков телефонии:");
    for (const row of samples) {
      console.log(
        `  ${row.CALL_START_DATE} type=${row.CALL_TYPE} portal=${row.PORTAL_USER_ID || 0} ` +
          `act=${row.CRM_ACTIVITY_ID || 0} code=${row.CALL_FAILED_CODE || ""} ` +
          `app=${row.REST_APP_NAME || row.REST_APP_ID || "—"} phone=${maskPhone(row.PHONE_NUMBER)}`
      );
    }
  }
  if (activities[0]) {
    console.log("пример дела CRM:", {
      ID: activities[0].ID,
      START_TIME: activities[0].START_TIME,
      PROVIDER_ID: activities[0].PROVIDER_ID,
      COMPLETED: activities[0].COMPLETED,
      DIRECTION: activities[0].DIRECTION,
    });
  }
}
