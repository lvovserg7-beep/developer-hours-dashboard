import { odataGet } from "./odata.mjs";
import { ozonSellerConfigured, ozonSellerPost } from "./ozon-seller.mjs";

const DB = "ecotidy";
const PAGE = 100;
const EMPTY = "00000000-0000-0000-0000-000000000000";
const OZON_GET_LIMIT = 50;

const STATUS_1C_RU = {
  ВПути: "В пути",
  ПриемкаНаСкладе: "Приёмка на складе",
  СогласованиеАктов: "Согласование актов",
  Завершено: "Завершено",
  Отменено: "Отменено",
  Черновик: "Черновик",
};

const OZON_STATE_RU = {
  IN_TRANSIT: "В пути",
  ACCEPTANCE_AT_STORAGE_WAREHOUSE: "Приёмка на складе хранения",
  REPORTS_CONFIRMATION_AWAITING: "Ожидает подтверждения отчётов",
  COMPLETED: "Завершено",
  CANCELLED: "Отменено",
  CANCELED: "Отменено",
  DATA_FILLING: "Заполнение данных",
  READY_TO_SUPPLY: "Готова к поставке",
  ACCEPTED_AT_SUPPLY_WAREHOUSE: "Принята на складе приёмки",
  UNLOAD: "Разгрузка",
};

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function defaultOzonFboRange() {
  const now = new Date();
  const day = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  return { from: day, to: day };
}

/** Период по умолчанию для вкладки «Поставки ФБО с фильтрами»: последний месяц. */
export function defaultOzonFboFilterRange() {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const from = new Date(to.getFullYear(), to.getMonth() - 1, to.getDate());
  return { from: ymd(from), to: ymd(to) };
}

function resolveRange(fromRaw, toRaw) {
  const fallback = defaultOzonFboRange();
  const from = parseYmd(fromRaw) || parseYmd(fallback.from);
  const to = parseYmd(toRaw) || parseYmd(fallback.to);
  if (from > to) throw new Error("Дата «с» не может быть позже «по»");
  const next = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  return {
    from: ymd(from),
    to: ymd(to),
    fromIso: `${ymd(from)}T00:00:00`,
    toIsoExclusive: `${ymd(next)}T00:00:00`,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ozonStateLabel(state) {
  const key = String(state || "").trim();
  if (!key) return "";
  return OZON_STATE_RU[key] || key;
}

function cargoPlaceCount(places) {
  if (!Array.isArray(places) || !places.length) return 0;
  const ids = new Set();
  for (const row of places) {
    const id = row?.Cargo_id;
    if (id != null && String(id) !== "" && String(id) !== "0") ids.add(String(id));
  }
  return ids.size || places.length;
}

function goodsCount(doc) {
  const lines = Array.isArray(doc.СписокТоваров) ? doc.СписокТоваров : [];
  if (lines.length) {
    return lines.reduce((sum, row) => sum + num(row.КоличествоТовара ?? row.Количество), 0);
  }
  const fromCargo = Array.isArray(doc.Грузоместа) ? doc.Грузоместа : [];
  if (fromCargo.length) {
    return fromCargo.reduce((sum, row) => sum + num(row.Количество), 0);
  }
  return num(doc.КоличествоТоваровВЗаявке);
}

function warehouseName(doc) {
  const header = String(doc.НазваниеСкладаХранения || "").trim();
  if (header) return header;
  const info = Array.isArray(doc.ИнформацияОПоставках) ? doc.ИнформацияОПоставках : [];
  for (const row of info) {
    const name = String(row?.НазваниеСкладаХранения || "").trim();
    if (name) return name;
  }
  return "";
}

function driverName(doc) {
  const drv = doc.Водитель;
  if (drv && typeof drv === "object") {
    return String(drv.ФИО || drv.Description || "").trim();
  }
  return "";
}

async function fetchSupplies(fromIso, toIsoExclusive) {
  const filter = encodeURIComponent(
    `DeletionMark eq false and ПланируемаяДатаОтгрузки ge datetime'${fromIso}' and ПланируемаяДатаОтгрузки lt datetime'${toIsoExclusive}'`
  );
  const rows = [];
  for (let page = 0; page < 50; page += 1) {
    const data = await odataGet(
      `Document_Alsn_ПоставкаOzon?$format=json&$filter=${filter}&$expand=Водитель&$top=${PAGE}&$skip=${page * PAGE}`,
      DB
    );
    const chunk = data.value || [];
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return rows;
}

async function fetchOzonStates(orderIds) {
  const map = new Map();
  if (!ozonSellerConfigured() || !orderIds.length) return map;
  const unique = [...new Set(orderIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  for (let i = 0; i < unique.length; i += OZON_GET_LIMIT) {
    const chunk = unique.slice(i, i + OZON_GET_LIMIT);
    const data = await ozonSellerPost("/v3/supply-order/get", { order_ids: chunk });
    for (const order of data.orders || []) {
      const id = Number(order.order_id);
      const number = String(order.order_number || "");
      const state = String(order.state || order.supplies?.[0]?.state || "");
      const supplyIds = (order.supplies || [])
        .map((s) => Number(s.supply_id))
        .filter((sid) => Number.isFinite(sid) && sid > 0);
      const dropOff = order.drop_off_warehouse;
      const row = {
        state,
        stateLabel: ozonStateLabel(state),
        orderNumber: number,
        supplyIds,
        cargoPlaces: null,
        storageWarehouse: "",
        dropOffPoint: dropOff && typeof dropOff === "object" ? String(dropOff.name || "").trim() : "",
        crossDock: false,
        specialConditions: false,
        specialConditionLabels: [],
        macrolocalClusterIds: [],
      };
      for (const supply of order.supplies || []) {
        const wh = supply.storage_warehouse;
        if (!row.storageWarehouse && wh && typeof wh === "object") {
          row.storageWarehouse = String(wh.name || wh.warehouse_name || "").trim();
        }
        if (supply.is_crossdock === true) row.crossDock = true;
        const tags = supply.supply_tags || {};
        if (isSpecialFromTags(tags)) row.specialConditions = true;
        row.specialConditionLabels.push(...labelsFromSupplyTags(tags));
        const clusterId = supply.macrolocal_cluster_id;
        if (clusterId != null && String(clusterId) !== "") {
          row.macrolocalClusterIds.push(String(clusterId));
        }
      }
      row.specialConditionLabels = uniqueSorted(row.specialConditionLabels);
      if (Number.isFinite(id) && id > 0) map.set(id, row);
      if (number) map.set(number, row);
    }
  }
  return map;
}

function countOzonCargoes(entry) {
  const list = entry?.cargoes_without_transport_cargoes;
  if (!Array.isArray(list)) return 0;
  const ids = new Set();
  for (const cargo of list) {
    const id = cargo?.cargo_id;
    if (id != null && String(id) !== "" && String(id) !== "0") ids.add(String(id));
  }
  return ids.size || list.length;
}

async function fetchOzonCargoCounts(ozonMap) {
  if (!ozonSellerConfigured() || !ozonMap.size) return;
  const supplyIds = [];
  const bySupply = new Map();
  for (const row of ozonMap.values()) {
    for (const sid of row.supplyIds || []) {
      if (!bySupply.has(sid)) {
        bySupply.set(sid, row);
        supplyIds.push(sid);
      }
    }
  }
  const unique = [...new Set(supplyIds)];
  for (let i = 0; i < unique.length; i += OZON_GET_LIMIT) {
    const chunk = unique.slice(i, i + OZON_GET_LIMIT);
    const data = await ozonSellerPost("/v1/cargoes/supplies/get", { supply_ids: chunk });
    for (const entry of data.supplies_cargoes || []) {
      const sid = Number(entry.supply_id);
      const row = bySupply.get(sid);
      if (!row) continue;
      const count = countOzonCargoes(entry);
      row.cargoPlaces = (Number(row.cargoPlaces) || 0) + count;
    }
  }
}

function pickClusterWarehouse(cluster, clusterName) {
  const warehouses = [];
  for (const lc of cluster?.logistic_clusters || []) {
    for (const w of lc.warehouses || []) warehouses.push(w);
  }
  const ffs = warehouses.filter((w) => w.type === "FULL_FILLMENT");
  if (!ffs.length) return "";
  const needle = String(clusterName || cluster?.name || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (needle) {
    const byName = ffs.find((w) => String(w.name || "").toUpperCase().includes(needle));
    if (byName?.name) return String(byName.name).trim();
  }
  const plain = ffs.find((w) => /_РФЦ$/i.test(String(w.name || "")) && !/НЕГАБАРИТ|АПТЕКА/i.test(String(w.name || "")));
  return String((plain || ffs[0]).name || "").trim();
}

async function fillOzonStorageWarehouses(ozonMap, docs) {
  if (!ozonSellerConfigured() || !ozonMap.size) return;
  const needCluster = new Set();
  const docsById = new Map();
  for (const doc of docs) {
    const id = num(doc.ИдентификаторЗаявкиНаПоставку);
    const number = String(doc.НомерЗаявкиНаПоставку || "").trim();
    if (id) docsById.set(id, doc);
    if (number) docsById.set(number, doc);
  }
  for (const [key, row] of ozonMap) {
    if (row.storageWarehouse) continue;
    const doc = docsById.get(key);
    if (warehouseName(doc)) continue;
    for (const cid of row.macrolocalClusterIds || []) needCluster.add(String(cid));
  }
  if (!needCluster.size) return;
  const data = await ozonSellerPost("/v1/cluster/list", { cluster_type: "CLUSTER_TYPE_OZON" });
  const byMacro = new Map();
  const byName = new Map();
  for (const cluster of data.clusters || []) {
    const macro = String(cluster.macrolocal_cluster_id ?? "");
    if (macro) byMacro.set(macro, cluster);
    const name = String(cluster.name || "").trim().toLowerCase();
    if (name) byName.set(name, cluster);
  }
  for (const [key, row] of ozonMap) {
    if (row.storageWarehouse) continue;
    const doc = docsById.get(key);
    const clusterName = String(doc?.НазваниеКластера || "").trim();
    let cluster = null;
    for (const cid of row.macrolocalClusterIds || []) {
      cluster = byMacro.get(String(cid));
      if (cluster) break;
    }
    if (!cluster && clusterName) cluster = byName.get(clusterName.toLowerCase()) || null;
    if (!cluster) continue;
    row.storageWarehouse = pickClusterWarehouse(cluster, clusterName || cluster.name);
  }
}

function resolveCargoPlaces(doc, ozon) {
  const from1c = cargoPlaceCount(doc.Грузоместа);
  if (from1c > 0) return from1c;
  const fromOzon = Number(ozon?.cargoPlaces);
  return Number.isFinite(fromOzon) && fromOzon > 0 ? fromOzon : 0;
}

function resolveStorageWarehouse(doc, ozon) {
  const from1c = warehouseName(doc);
  if (from1c) return from1c;
  return String(ozon?.storageWarehouse || "").trim();
}

function labelsFromSupplyTags(tags) {
  const out = [];
  if (!tags || typeof tags !== "object") return out;
  if (tags.is_marking_required) out.push("Маркировка обязательна");
  if (tags.is_marking_possible && !tags.is_marking_required) out.push("Маркировка возможна");
  if (tags.freeze_stock_for_marking) out.push("Заморозка остатков под маркировку");
  if (tags.is_ettn_required) out.push("ЭТрН");
  if (tags.is_evsd_required) out.push("Меркурий (ВСД)");
  if (tags.is_jewelry) out.push("Ювелирные товары");
  if (tags.is_utd) out.push("УПД до поставки");
  return out;
}

function isSpecialFromTags(tags) {
  if (!tags || typeof tags !== "object") return false;
  return !!(
    tags.is_marking_required ||
    tags.is_ettn_required ||
    tags.is_evsd_required ||
    tags.is_jewelry ||
    tags.freeze_stock_for_marking
  );
}

function parseJsonSafe(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function uniqueLabels(list) {
  return uniqueSorted(list);
}

/** Кросс-докинг и перечень «особых условий» — из ТЧ 1С / JSON / ответа Seller API. */
function flagsFromDoc(doc, ozon) {
  let crossDock = false;
  const labels = [];
  if (String(doc.ТипПоставки || "").toUpperCase() === "CROSSDOCK") crossDock = true;
  const info = Array.isArray(doc.ИнформацияОПоставках) ? doc.ИнформацияОПоставках : [];
  for (const row of info) {
    if (row?.ПоставкаКроссДокинг === true) crossDock = true;
    if (row?.ЕстьТоварыДляКоторыхМаркировкаОбязательна === true) labels.push("Маркировка обязательна");
    else if (row?.ЕстьТоварыДляКоторыхВозможнаМаркировка === true) labels.push("Маркировка возможна");
    if (row?.НужнаЭлектроннаяТТН === true) labels.push("ЭТрН");
    if (row?.ЕстьТоварыССертификациейВСистемеМеркурий === true) labels.push("Меркурий (ВСД)");
    if (row?.ЕстьЮвелирныеТовары === true) labels.push("Ювелирные товары");
    if (row?.НужноПередатьУПД === true) labels.push("УПД до поставки");
  }
  const json = parseJsonSafe(doc.JSONИнформацияОЗаявкеНаПоставку);
  if (json && typeof json === "object") {
    for (const supply of json.supplies || []) {
      if (supply?.is_crossdock === true) crossDock = true;
      labels.push(...labelsFromSupplyTags(supply?.supply_tags));
    }
  }
  if (ozon?.crossDock === true) crossDock = true;
  if (Array.isArray(ozon?.specialConditionLabels)) labels.push(...ozon.specialConditionLabels);
  const specialConditionLabels = uniqueLabels(labels);
  const specialConditions =
    specialConditionLabels.some((l) =>
      /маркировка обязательна|этрн|меркурий|ювелир|заморозка/i.test(l)
    ) || ozon?.specialConditions === true;
  return { crossDock, specialConditions, specialConditionLabels };
}

function uniqueSorted(values) {
  return [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "ru")
  );
}

function mapSupply(doc, ozonMap) {
  const orderId = num(doc.ИдентификаторЗаявкиНаПоставку);
  const orderNumber = String(doc.НомерЗаявкиНаПоставку || "").trim();
  const ozon = ozonMap.get(orderId) || ozonMap.get(orderNumber) || null;
  const emptyDriver = !doc.Водитель_Key || doc.Водитель_Key === EMPTY;
  const flags = flagsFromDoc(doc, ozon);
  const dropOff =
    String(doc.НазваниеПунктаОтгрузки || "").trim() || String(ozon?.dropOffPoint || "").trim();
  return {
    ref: doc.Ref_Key,
    number: doc.Number || "",
    account: doc.Аккаунт || "",
    orderNumber,
    orderId: orderId || null,
    status1c: String(doc.Статус || "").trim(),
    status1cLabel: STATUS_1C_RU[String(doc.Статус || "").trim()] || String(doc.Статус || "").trim(),
    statusOzon: ozon?.state || "",
    statusOzonLabel: ozon?.stateLabel || (ozon ? ozon.state : ""),
    cargoPlaces: resolveCargoPlaces(doc, ozon),
    cargoPlacesSource: cargoPlaceCount(doc.Грузоместа) > 0 ? "1c" : ozon?.cargoPlaces > 0 ? "ozon" : "",
    createdAt: doc.ДатаСозданияЗаявкиНаПоставку || doc.Date || "",
    shipmentDate: doc.ПланируемаяДатаОтгрузки || "",
    dropOffPoint: dropOff,
    storageWarehouse: resolveStorageWarehouse(doc, ozon),
    cluster: String(doc.НазваниеКластера || "").trim(),
    driver: emptyDriver ? "" : driverName(doc),
    goodsCount: goodsCount(doc),
    crossDock: flags.crossDock,
    specialConditions: flags.specialConditions,
    specialConditionLabels: flags.specialConditionLabels,
  };
}

export async function loadOzonFboSupplies(fromRaw, toRaw) {
  const range = resolveRange(fromRaw, toRaw);
  const docs = await fetchSupplies(range.fromIso, range.toIsoExclusive);
  const ids = docs.map((d) => d.ИдентификаторЗаявкиНаПоставку).filter(Boolean);
  let ozonMap = new Map();
  let ozonError = "";
  try {
    ozonMap = await fetchOzonStates(ids);
  } catch (err) {
    ozonError = String(err.message || err);
  }
  if (ozonMap.size) {
    try {
      await fetchOzonCargoCounts(ozonMap);
    } catch (err) {
      const msg = String(err.message || err);
      ozonError = ozonError ? `${ozonError}; грузоместа: ${msg}` : `Грузоместа ЛК: ${msg}`;
    }
    try {
      await fillOzonStorageWarehouses(ozonMap, docs);
    } catch (err) {
      const msg = String(err.message || err);
      ozonError = ozonError ? `${ozonError}; склад: ${msg}` : `Склад ЛК: ${msg}`;
    }
  }
  const supplies = docs.map((doc) => mapSupply(doc, ozonMap)).sort((a, b) => {
    const da = a.shipmentDate || "";
    const db = b.shipmentDate || "";
    return da.localeCompare(db) || String(a.orderNumber).localeCompare(String(b.orderNumber), "ru");
  });
  const withOzon = supplies.filter((s) => s.statusOzon).length;
  const cargoPlaces = supplies.reduce((sum, s) => sum + (Number(s.cargoPlaces) || 0), 0);
  const statuses1c = uniqueSorted(supplies.map((s) => s.status1cLabel || s.status1c));
  const statusesOzon = uniqueSorted(supplies.map((s) => s.statusOzonLabel || s.statusOzon));
  const clusters = uniqueSorted(supplies.map((s) => s.cluster));
  const dropOffPoints = uniqueSorted(supplies.map((s) => s.dropOffPoint));
  const storageWarehouses = uniqueSorted(supplies.map((s) => s.storageWarehouse));
  return {
    generatedAt: new Date().toISOString(),
    period: { from: range.from, to: range.to },
    totals: {
      supplies: supplies.length,
      withOzonStatus: withOzon,
      cargoPlaces,
      crossDock: supplies.filter((s) => s.crossDock).length,
      specialConditions: supplies.filter((s) => s.specialConditions).length,
    },
    filters: {
      statuses1c,
      statusesOzon,
      clusters,
      dropOffPoints,
      storageWarehouses,
    },
    ozonConfigured: ozonSellerConfigured(),
    ozonError,
    supplies,
    note:
      "Поставки из документа 1С Alsn_ПоставкаOzon, база Первый интегратор (ecotidy). " +
      "Фильтр — реквизит ПланируемаяДатаОтгрузки. " +
      "Грузоместа: сначала табличная часть 1С, если пусто — /v1/cargoes/supplies/get из ЛК Ozon. " +
      "Особые условия — маркировка / ЭТрН / Меркурий / ювелирка (1С и supply_tags Ozon).",
  };
}
