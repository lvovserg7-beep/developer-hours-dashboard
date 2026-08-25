import { odataAllPages } from "./odata.mjs";
import { EMPTY_GUID } from "../load-employees.mjs";

const STAGES = [
  { id: "pay", title: "Согласование оплаты", minOrder: 2 },
  { id: "pause", title: "Пауза", minOrder: 3 },
  { id: "sprint", title: "Спринт", minOrder: 4 },
  { id: "impl", title: "Внедрение", minOrder: 5 },
  { id: "done", title: "Сделано", minOrder: 6 },
];

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round1(value) {
  return Math.round(num(value) * 10) / 10;
}

function roundMoney(value) {
  return Math.round(num(value) * 100) / 100;
}

function roundPct(value) {
  return Math.round(num(value));
}

function isoDay(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDay(text) {
  const m = String(text || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function odataDate(d, endOfDay = false) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return endOfDay ? `${y}-${m}-${day}T23:59:59` : `${y}-${m}-${day}T00:00:00`;
}

export function defaultPlanRange() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { from: isoDay(from), to: isoDay(to) };
}

function isEmptyGuid(id) {
  return !id || id === EMPTY_GUID;
}

function extractKey(value) {
  if (!value) return "";
  if (typeof value === "object") return String(value.Ref_Key || value.Key || "").trim();
  const text = String(value);
  const guid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return guid ? guid[0] : text.trim();
}

async function fetchAll(path, orderby = "") {
  const pageSize = 200;
  const maxPages = 80;
  const base = String(path).replace(/&\$top=\d+/g, "").replace(/\?\$top=\d+&/g, "?").replace(/\?\$top=\d+$/g, "");
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const sep = base.includes("?") ? "&" : "?";
    const order = orderby ? `$orderby=${orderby}&` : "";
    const pagePath = `${base}${sep}${order}$top=${pageSize}&$skip=${page * pageSize}`;
    try {
      const chunk = await odataAllPages(pagePath, 2);
      rows.push(...chunk);
      if (chunk.length < pageSize) break;
    } catch (err) {
      return { rows, error: String(err.message || err) };
    }
  }
  return { rows, error: "" };
}

async function resolveByKeys(entity, ids, select) {
  const map = new Map();
  const list = [...new Set(ids.filter((id) => id && !isEmptyGuid(id)))];
  for (let i = 0; i < list.length; i += 8) {
    const part = list.slice(i, i + 8);
    const filter = encodeURIComponent(part.map((id) => `Ref_Key eq guid'${id}'`).join(" or "));
    const data = await fetchAll(`${entity}?$format=json&$filter=${filter}&$select=${select}`);
    for (const row of data.rows) map.set(row.Ref_Key, row);
  }
  return map;
}

function emptyMetrics() {
  const out = { planHours: 0, planAmount: 0 };
  for (const stage of STAGES) out[stage.id] = { hours: 0, cost: 0, marketing: 0 };
  return out;
}

function addMetrics(target, extra) {
  target.planHours += extra.planHours || 0;
  target.planAmount += extra.planAmount || 0;
  for (const stage of STAGES) {
    target[stage.id].hours += extra[stage.id]?.hours || 0;
    target[stage.id].cost += extra[stage.id]?.cost || 0;
    target[stage.id].marketing += extra[stage.id]?.marketing || 0;
  }
}

function finishMetrics(raw, totalPlanHours) {
  const planAmount = raw.planAmount;
  const stages = {};
  for (const stage of STAGES) {
    stages[stage.id] = {
      hours: round1(raw[stage.id].hours),
      cost: roundMoney(raw[stage.id].cost),
      marketing: round1(raw[stage.id].marketing),
      percent: planAmount ? roundPct((raw[stage.id].cost / planAmount) * 100) : 0,
    };
  }
  return {
    planHours: round1(raw.planHours),
    planAmount: roundMoney(planAmount),
    planShare: totalPlanHours ? roundPct((raw.planHours / totalPlanHours) * 100) : 0,
    stages,
  };
}

function hasNumbers(metrics) {
  if (metrics.planHours || metrics.planAmount) return true;
  return STAGES.some((s) => metrics.stages[s.id].hours || metrics.stages[s.id].cost || metrics.stages[s.id].marketing);
}

function sortRu(a, b) {
  return String(a || "").localeCompare(String(b || ""), "ru");
}

function statusOrder(row, orderByStatusId, orderByStatusKey) {
  const byCode = orderByStatusId.get(String(row.СтатусИД || "").trim());
  if (byCode != null) return byCode;
  const byKey = orderByStatusKey.get(extractKey(row.СтатусЗадачи_Key) || extractKey(row.СтатусЗадачи));
  if (byKey != null) return byKey;
  return num(row.Порядок);
}

export async function loadPlan(fromText, toText) {
  const from = parseDay(fromText);
  const to = parseDay(toText);
  if (!from || !to || from > to) throw new Error("Некорректный период");
  const warnings = [];

  const [statusesData, tasksData, planData, counterpartiesData] = await Promise.all([
    fetchAll("Catalog_СтатусыЗадач?$format=json&$select=Ref_Key,Code,Description,Порядок", "Ref_Key"),
    fetchAll(
      "InformationRegister_ЗадачиВТрелло_RecordType?$format=json&$select=Контрагент_Key,ЗадачаИД,Задача,Часы,Маркетинг,Стикер,Попадос,Отложено,СтатусИД,Порядок,Аналитик_Key,СтатусЗадачи_Key",
      "ЗадачаИД"
    ),
    fetchAll(
      `InformationRegister_ПланПродаж_RecordType?$format=json&$filter=${encodeURIComponent(
        `Месяц ge datetime'${odataDate(from)}' and Месяц le datetime'${odataDate(to, true)}'`
      )}&$select=Партнер_Key,Месяц,Ответственный_Key,План,Active`,
      "Партнер_Key,Месяц,Ответственный_Key"
    ),
    fetchAll(
      "Catalog_Контрагенты?$format=json&$select=Ref_Key,Description,Партнер_Key,ЦенаЧаса,СтавкаПоддержка,ЧасовПоддержкиЕжемесячно",
      "Ref_Key"
    ),
  ]);

  for (const [name, pack] of [
    ["Статусы задач", statusesData],
    ["ЗадачиВТрелло", tasksData],
    ["План продаж", planData],
    ["Контрагенты", counterpartiesData],
  ]) {
    if (pack.error) warnings.push(`${name}: ${pack.error.slice(0, 180)}`);
  }

  const orderByStatusId = new Map();
  const orderByStatusKey = new Map();
  for (const row of statusesData.rows) {
    const order = num(row.Порядок);
    if (row.Code) orderByStatusId.set(String(row.Code).trim(), order);
    orderByStatusKey.set(row.Ref_Key, order);
  }

  const counterparties = new Map();
  const maxPriceByPartner = new Map();
  const partnerKeys = [];
  const userKeys = [];
  for (const row of counterpartiesData.rows) {
    const partnerKey = extractKey(row.Партнер_Key) || extractKey(row.Партнер);
    counterparties.set(row.Ref_Key, {
      name: String(row.Description || "").trim() || "Без клиента",
      partnerKey,
      hourPrice: num(row.ЦенаЧаса),
      supportRate: num(row.СтавкаПоддержка),
      supportHours: num(row.ЧасовПоддержкиЕжемесячно),
    });
    if (!isEmptyGuid(partnerKey)) {
      partnerKeys.push(partnerKey);
      const prev = maxPriceByPartner.get(partnerKey) || 0;
      if (num(row.ЦенаЧаса) > prev) maxPriceByPartner.set(partnerKey, num(row.ЦенаЧаса));
    }
  }

  for (const row of planData.rows) {
    partnerKeys.push(extractKey(row.Партнер_Key) || extractKey(row.Партнер));
    userKeys.push(extractKey(row.Ответственный_Key) || extractKey(row.Ответственный));
  }
  for (const row of tasksData.rows) {
    userKeys.push(extractKey(row.Аналитик_Key) || extractKey(row.Аналитик));
  }

  const [partnerRows, userRows] = await Promise.all([
    resolveByKeys("Catalog_Партнеры", partnerKeys, "Ref_Key,Description"),
    resolveByKeys("Catalog_Пользователи", userKeys, "Ref_Key,Description"),
  ]);

  const partnerName = (key) => {
    if (isEmptyGuid(key)) return "Без партнёра";
    return String(partnerRows.get(key)?.Description || "").trim() || "Без партнёра";
  };
  const userName = (key) => {
    if (isEmptyGuid(key)) return "Без РП";
    return String(userRows.get(key)?.Description || "").trim() || "Без РП";
  };

  const byRpPartner = new Map();
  const byPartner = new Map();
  const ensure = (map, key, label) => {
    if (!map.has(key)) map.set(key, { key, ...label, metrics: emptyMetrics() });
    return map.get(key);
  };

  for (const row of planData.rows) {
    if (row.Active === false) continue;
    const partnerKey = extractKey(row.Партнер_Key) || extractKey(row.Партнер);
    const rpKey = extractKey(row.Ответственный_Key) || extractKey(row.Ответственный);
    const hours = num(row.План);
    const extra = emptyMetrics();
    extra.planHours = hours;
    extra.planAmount = hours * (maxPriceByPartner.get(partnerKey) || 0);
    const rp = userName(rpKey);
    const partner = partnerName(partnerKey);
    addMetrics(ensure(byRpPartner, `${rp}\t${partner}`, { rp, partner }).metrics, extra);
    addMetrics(ensure(byPartner, partner, { partner }).metrics, extra);
  }

  for (const row of tasksData.rows) {
    if (row.Попадос || row.Отложено || row.Стикер) continue;
    const order = statusOrder(row, orderByStatusId, orderByStatusKey);
    if (!(order > 2)) continue;
    const hours = num(row.Часы);
    const marketing = num(row.Маркетинг);
    const client = counterparties.get(extractKey(row.Контрагент_Key) || extractKey(row.Контрагент));
    const cost = (client?.hourPrice || 0) * hours;
    const extra = emptyMetrics();
    for (const stage of STAGES) {
      if (order > stage.minOrder) {
        extra[stage.id].hours = hours;
        extra[stage.id].cost = cost;
        extra[stage.id].marketing = marketing;
      }
    }
    const rp = userName(extractKey(row.Аналитик_Key) || extractKey(row.Аналитик));
    const partner = partnerName(client?.partnerKey);
    addMetrics(ensure(byRpPartner, `${rp}\t${partner}`, { rp, partner }).metrics, extra);
    addMetrics(ensure(byPartner, partner, { partner }).metrics, extra);
  }

  const totalRpRaw = emptyMetrics();
  for (const row of byRpPartner.values()) addMetrics(totalRpRaw, row.metrics);
  const totalPartnerRaw = emptyMetrics();
  for (const row of byPartner.values()) addMetrics(totalPartnerRaw, row.metrics);

  function groupedByRp(totalPlanHours) {
    const groups = new Map();
    for (const row of byRpPartner.values()) {
      if (!groups.has(row.rp)) groups.set(row.rp, { name: row.rp, metrics: emptyMetrics(), children: [] });
      const group = groups.get(row.rp);
      addMetrics(group.metrics, row.metrics);
      group.children.push({ name: row.partner, metrics: finishMetrics(row.metrics, totalPlanHours) });
    }
    return [...groups.values()]
      .map((group) => ({
        name: group.name,
        metrics: finishMetrics(group.metrics, totalPlanHours),
        children: group.children.filter((c) => hasNumbers(c.metrics)).sort((a, b) => sortRu(a.name, b.name)),
      }))
      .filter((group) => hasNumbers(group.metrics))
      .sort((a, b) => sortRu(a.name, b.name));
  }

  const partnerGroups = [...byPartner.values()]
    .map((row) => ({ name: row.partner, metrics: finishMetrics(row.metrics, totalPartnerRaw.planHours), children: [] }))
    .filter((row) => hasNumbers(row.metrics))
    .sort((a, b) => sortRu(a.name, b.name));

  const supportFact = new Map();
  for (const task of tasksData.rows) {
    if (!task.Стикер || task.Попадос) continue;
    if (statusOrder(task, orderByStatusId, orderByStatusKey) !== 9) continue;
    const clientKey = extractKey(task.Контрагент_Key) || extractKey(task.Контрагент);
    if (isEmptyGuid(clientKey)) continue;
    supportFact.set(clientKey, (supportFact.get(clientKey) || 0) + num(task.Часы));
  }

  const support = [];
  for (const [key, client] of counterparties.entries()) {
    if (!client.supportHours) continue;
    const factHours = supportFact.get(key) || 0;
    const overrun = Math.max(0, factHours - client.supportHours);
    const covered = factHours - overrun;
    const planAmount = client.supportHours * client.supportRate;
    const factAmount = covered * client.supportRate + overrun * client.hourPrice;
    support.push({
      client: client.name,
      supportRate: roundMoney(client.supportRate),
      extraRate: roundMoney(client.hourPrice),
      planHours: round1(client.supportHours),
      planAmount: roundMoney(planAmount),
      factHours: factHours ? round1(factHours) : 0,
      overrun: round1(overrun),
      factAmount: roundMoney(factAmount),
      percent: planAmount ? roundPct((factAmount / planAmount) * 100) : 0,
    });
  }
  support.sort((a, b) => sortRu(a.client, b.client));

  const supportTotalRaw = support.reduce(
    (acc, row) => {
      acc.planHours += row.planHours;
      acc.planAmount += row.planAmount;
      acc.factHours += row.factHours;
      acc.overrun += row.overrun;
      acc.factAmount += row.factAmount;
      return acc;
    },
    { planHours: 0, planAmount: 0, factHours: 0, overrun: 0, factAmount: 0 }
  );
  const supportTotal = {
    planHours: round1(supportTotalRaw.planHours),
    planAmount: roundMoney(supportTotalRaw.planAmount),
    factHours: round1(supportTotalRaw.factHours),
    overrun: round1(supportTotalRaw.overrun),
    factAmount: roundMoney(supportTotalRaw.factAmount),
    percent: supportTotalRaw.planAmount ? roundPct((supportTotalRaw.factAmount / supportTotalRaw.planAmount) * 100) : 0,
  };

  return {
    from: fromText,
    to: toText,
    generatedAt: new Date().toISOString(),
    stages: STAGES.map((s) => ({ id: s.id, title: s.title })),
    variants: {
      rp: {
        title: "Разработка",
        groups: groupedByRp(totalRpRaw.planHours),
        total: finishMetrics(totalRpRaw, totalRpRaw.planHours),
      },
      partner: {
        title: "Разработка",
        groups: partnerGroups,
        total: finishMetrics(totalPartnerRaw, totalPartnerRaw.planHours),
      },
    },
    support: { title: "Поддержка", rows: support, total: supportTotal },
    warnings: [...new Set(warnings.filter(Boolean))],
    note: "Как отчёт 1С «Исполнение плана»: план — регистр «План продаж» за выбранные месяцы, цена часа — максимум по партнёру. Факт — «Задачи в Трелло» без стикера, попадоса и отложенных, порядок статуса больше 2; колонки факта накопительные. Поддержка — контрагенты с часами поддержки, факт стикеров со статусом 9.",
  };
}
