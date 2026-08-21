import { odataAllPages } from "./lib/odata.mjs";

export const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

/** В работе: Порядок >= 1 и < 7. Выполненные: Порядок >= 7. Ноль — не доска. */
export const IN_WORK_ORDER_MIN = 1;
export const IN_WORK_ORDER_MAX = 7;

export function isInWorkOrder(order) {
  const n = Number(order);
  return Number.isFinite(n) && n >= IN_WORK_ORDER_MIN && n < IN_WORK_ORDER_MAX;
}

export function isCompletedOrder(order) {
  const n = Number(order);
  return Number.isFinite(n) && n >= IN_WORK_ORDER_MAX;
}

const TOP_CLIENTS = 10;
const TOP_ROWS = 12;
const CHUNK = 8;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function hours(task) {
  return num(task.Часы);
}

function hoursDevelopment(task) {
  return num(task.ЧасыРазработки);
}

function hoursDev(task) {
  return num(task.ЧасыРазработки) + num(task.ЧасыВнедрения);
}

function hoursAnalysis(task) {
  return Math.max(0, hours(task) - hoursDev(task));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function shortNumber(value) {
  return String(value || "").replace(/^0+/, "") || "0";
}

function statusLabel(meta) {
  if (!meta) return "Без статуса";
  return `${meta.order} ${meta.name}`;
}

async function fetchByStatus(statusId, extraFilter = "") {
  const parts = [`Статус_Key eq guid'${statusId}'`, "DeletionMark eq false"];
  if (extraFilter) parts.push(extraFilter);
  const filter = encodeURIComponent(parts.join(" and "));
  return odataAllPages(`Document_ЗадачаРазработчика?$format=json&$filter=${filter}&$top=200`);
}

async function resolveNames(ids, entity, select = "Ref_Key,Description") {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && id !== EMPTY_GUID))];
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const rows = await odataAllPages(`${entity}?$format=json&$filter=${filter}&$select=${select}&$top=50`);
    for (const row of rows) map.set(row.Ref_Key, String(row.Description || "").trim() || "Без имени");
  }
  return map;
}

function otherBucket(entries, limit) {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= limit) return Object.fromEntries(sorted);
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((s, [, v]) => s + v, 0);
  if (rest > 0) head.push(["Прочие", rest]);
  return Object.fromEntries(head);
}

function stackedRows(groups, order, top = TOP_ROWS) {
  const rows = [...groups.entries()].map(([name, segs]) => {
    const segments = {};
    let total = 0;
    for (const [k, v] of segs.entries()) {
      if (v <= 0) continue;
      segments[k] = round1(v);
      total += v;
    }
    return { name, total: round1(total), segments };
  }).filter((r) => r.total > 0);

  const orderNum = (name) => {
    const m = String(name || "").match(/^(\d+)/);
    return m ? Number(m[1]) : null;
  };
  if (rows.every((r) => orderNum(r.name) != null)) {
    rows.sort((a, b) => orderNum(a.name) - orderNum(b.name) || a.name.localeCompare(b.name, "ru"));
    return rows;
  }
  if (order) {
    const idx = new Map(order.map((n, i) => [n, i]));
    rows.sort((a, b) => (idx.get(a.name) ?? 99) - (idx.get(b.name) ?? 99) || b.total - a.total);
    return rows;
  }
  rows.sort((a, b) => b.total - a.total);
  return rows.slice(0, top);
}

function addSeg(map, row, seg, value) {
  if (value <= 0) return;
  if (!map.has(row)) map.set(row, new Map());
  const segs = map.get(row);
  segs.set(seg, (segs.get(seg) || 0) + value);
}

export async function loadActiveEmployees() {
  const statusRows = await odataAllPages("Catalog_СтатусыЗадач?$format=json&$top=200");
  const statusById = new Map();
  const inWorkStatuses = [];
  const completedStatuses = [];
  for (const row of statusRows) {
    if (row.DeletionMark) continue;
    const meta = {
      id: row.Ref_Key,
      name: String(row.Description || "").trim(),
      order: num(row.Порядок),
    };
    statusById.set(row.Ref_Key, meta);
    if (isInWorkOrder(meta.order)) inWorkStatuses.push(meta);
    if (isCompletedOrder(meta.order)) completedStatuses.push(meta);
  }
  inWorkStatuses.sort((a, b) => a.order - b.order);
  completedStatuses.sort((a, b) => a.order - b.order);

  const inWork = [];
  for (const status of inWorkStatuses) {
    const chunk = await fetchByStatus(status.id);
    for (const task of chunk) {
      if (task.Архив || task.Отложено) continue;
      const meta = statusById.get(task.Статус_Key);
      if (!meta || !isInWorkOrder(meta.order)) continue;
      inWork.push(task);
    }
  }

  const completed = [];
  for (const status of completedStatuses) {
    const chunk = await fetchByStatus(status.id);
    for (const task of chunk) {
      const meta = statusById.get(task.Статус_Key);
      if (!meta || !isCompletedOrder(meta.order)) continue;
      completed.push(task);
    }
  }

  const postponed = [];
  const postponedRows = await odataAllPages(
    `Document_ЗадачаРазработчика?$format=json&$filter=${encodeURIComponent("Отложено eq true and DeletionMark eq false")}&$top=200`
  );
  for (const task of postponedRows) {
    if (task.Архив) continue;
    postponed.push(task);
  }

  const all = [...inWork, ...completed, ...postponed];
  const users = await resolveNames(all.map((t) => t.Разработчик_Key), "Catalog_Пользователи");
  const clients = await resolveNames(all.map((t) => t.Контрагент_Key), "Catalog_Контрагенты");

  const clientName = (task) => clients.get(task.Контрагент_Key) || "Без клиента";
  const devName = (task) => {
    const id = task.Разработчик_Key;
    if (!id || id === EMPTY_GUID) return "Без исполнителя";
    return users.get(id) || "Без имени";
  };
  const taskStatus = (task) => statusLabel(statusById.get(task.Статус_Key));

  const hoursInWork = round1(inWork.reduce((s, t) => s + hours(t), 0));
  const hoursPostponed = round1(postponed.reduce((s, t) => s + hours(t), 0));
  const hoursCompleted = round1(completed.reduce((s, t) => s + hours(t), 0));

  const byStatusClient = new Map();
  const clientHours = new Map();
  for (const task of inWork) {
    const status = taskStatus(task);
    const client = clientName(task);
    const h = hours(task);
    addSeg(byStatusClient, status, client, h);
    clientHours.set(client, (clientHours.get(client) || 0) + h);
  }
  const keepClients = new Set(Object.keys(otherBucket(clientHours, TOP_CLIENTS)));
  const byStatusClientTrim = new Map();
  for (const [status, segs] of byStatusClient) {
    const trimmed = new Map();
    for (const [client, h] of segs) {
      const key = keepClients.has(client) ? client : "Прочие";
      trimmed.set(key, (trimmed.get(key) || 0) + h);
    }
    byStatusClientTrim.set(status, trimmed);
  }

  const byDevStatus = new Map();
  for (const task of inWork) {
    addSeg(byDevStatus, devName(task), taskStatus(task), hoursDevelopment(task));
  }

  const byClientSupport = new Map();
  for (const task of completed) {
    addSeg(byClientSupport, clientName(task), task.Поддержка ? "Поддержка" : "Проект", hours(task));
  }

  const byDevType = new Map();
  for (const task of completed) {
    const name = devName(task);
    addSeg(byDevType, name, "Анализ", hoursAnalysis(task));
    addSeg(byDevType, name, "Разработка", hoursDev(task));
  }

  const byEmployee = new Map();
  let unassignedCount = 0;
  for (const task of inWork) {
    const statusName = taskStatus(task);
    const empId = task.Разработчик_Key && task.Разработчик_Key !== EMPTY_GUID ? task.Разработчик_Key : "unassigned";
    const name = empId === "unassigned" ? "Без исполнителя" : users.get(empId) || empId;
    if (empId === "unassigned") unassignedCount += 1;
    if (!byEmployee.has(empId)) {
      byEmployee.set(empId, {
        id: empId,
        name,
        unassigned: empId === "unassigned",
        taskCount: 0,
        hours: 0,
        byStatus: {},
        tasks: [],
      });
    }
    const emp = byEmployee.get(empId);
    emp.taskCount += 1;
    emp.hours = round1(emp.hours + hoursDevelopment(task));
    emp.byStatus[statusName] = (emp.byStatus[statusName] || 0) + 1;
    emp.tasks.push({
      number: shortNumber(task.Number),
      title: task.Задача || "Без названия",
      status: statusName,
      client: clients.get(task.Контрагент_Key) || "",
      hours: hoursDevelopment(task),
      date: task.Date,
      deadline: task.Дедлайн || "",
    });
  }

  const employees = [...byEmployee.values()].sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;
    return b.hours - a.hours || b.taskCount - a.taskCount || a.name.localeCompare(b.name, "ru");
  });
  for (const emp of employees) {
    emp.tasks.sort((a, b) => b.hours - a.hours || Number(a.number) - Number(b.number));
  }

  const inWorkLabels = inWorkStatuses.map(statusLabel);
  const completedLabels = completedStatuses.map(statusLabel);
  const statusTotals = {};
  for (const label of inWorkLabels) statusTotals[label] = 0;
  for (const task of inWork) {
    const label = taskStatus(task);
    statusTotals[label] = (statusTotals[label] || 0) + 1;
  }

  const gaugeMax = Math.max(500, Math.ceil(hoursCompleted / 500) * 500);

  return {
    generatedAt: new Date().toISOString(),
    source: "1C OData · trade.alsn.ru · Аллсан Интеграция",
    organization: "Аллсан Интеграция",
    activeStatuses: inWorkLabels,
    completedStatuses: completedLabels,
    excludedStatuses: completedLabels,
    kpis: {
      hoursInWork,
      hoursPostponed,
      hoursCompleted,
      gaugeMax,
    },
    charts: {
      hoursByStatus: stackedRows(byStatusClientTrim, inWorkLabels),
      hoursByDeveloper: stackedRows(byDevStatus, null),
      completedByClient: stackedRows(byClientSupport, null),
      completedByDeveloper: stackedRows(byDevType, null),
    },
    totals: {
      employees: employees.filter((e) => !e.unassigned).length,
      tasks: inWork.length,
      unassigned: unassignedCount,
    },
    statusTotals,
    employees,
  };
}

if (process.argv[1]?.endsWith("load-employees.mjs")) {
  const data = await loadActiveEmployees();
  console.log(JSON.stringify({
    kpis: data.kpis,
    totals: data.totals,
    activeStatuses: data.activeStatuses,
    completedStatuses: data.completedStatuses,
    charts: {
      hoursByStatus: data.charts.hoursByStatus.map((r) => ({ name: r.name, total: r.total })),
      hoursByDeveloper: data.charts.hoursByDeveloper.slice(0, 6).map((r) => ({ name: r.name, total: r.total })),
      completedByClient: data.charts.completedByClient.slice(0, 6).map((r) => ({ name: r.name, total: r.total })),
    },
  }, null, 2));
}
