/**
 * Справочники доски «Расчёт поставки ВБ» (ТЗ от 26.11.2026).
 * Кластеры WB, срок доставки и приёмки, привязка федерального округа и склада WB к кластеру.
 */

export const CLUSTER_CENTER = "Центр";

/** Порядок кластеров и срок доставки и приёмки по умолчанию, дней. */
export const CLUSTERS = [
  { name: "Центр", days: 3 },
  { name: "Северо-Запад", days: 5 },
  { name: "Приволжье", days: 5 },
  { name: "Урал", days: 7 },
  { name: "Юг и Северный Кавказ", days: 7 },
  { name: "Сибирь и Дальний Восток", days: 12 },
];

export const DEFAULT_TRANSIT_DAYS = Object.fromEntries(CLUSTERS.map((c) => [c.name, c.days]));

/** Федеральный округ покупателя (oblastOkrugName) → кластер. Пусто → «Центр». */
const OKRUG_TO_CLUSTER = new Map([
  ["центральный федеральный округ", "Центр"],
  ["северо-западный федеральный округ", "Северо-Запад"],
  ["приволжский федеральный округ", "Приволжье"],
  ["уральский федеральный округ", "Урал"],
  ["южный федеральный округ", "Юг и Северный Кавказ"],
  ["северо-кавказский федеральный округ", "Юг и Северный Кавказ"],
  ["сибирский федеральный округ", "Сибирь и Дальний Восток"],
  ["дальневосточный федеральный округ", "Сибирь и Дальний Восток"],
]);

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @returns {{ cluster: string, known: boolean }}
 */
export function clusterByOkrug(okrug) {
  const key = norm(okrug);
  if (!key) return { cluster: CLUSTER_CENTER, known: true };
  const hit = OKRUG_TO_CLUSTER.get(key);
  if (hit) return { cluster: hit, known: true };
  return { cluster: CLUSTER_CENTER, known: false };
}

/** Ключевые слова названия склада WB → кластер. Склады СНГ в расчёт не входят. */
const WAREHOUSE_RULES = [
  { cluster: "Центр", words: ["электросталь", "коледино", "тула", "котовск", "склад wb рф", "подольск", "рязань", "владимир"] },
  { cluster: "Северо-Запад", words: ["спб шушары", "шушары", "красный бор"] },
  { cluster: "Приволжье", words: ["сарапул", "самара", "новосемейкино", "казань"] },
  { cluster: "Урал", words: ["екатеринбург"] },
  { cluster: "Юг и Северный Кавказ", words: ["краснодар", "волгоград", "невинномысск"] },
  { cluster: "Сибирь и Дальний Восток", words: ["новосибирск", "хабаровск"] },
];
const CIS_WORDS = ["ереван", "великий камень", "ташкент", "актобе"];

/** Служебные строки отчёта warehouse_remains (не склады). */
export const REMAINS_TRANSIT_CUSTOMERS = "В пути до получателей";
export const REMAINS_TRANSIT_RETURNS = "В пути возвраты на склад WB";
export const REMAINS_TOTAL = "Всего находится на складах";

export function isRemainsServiceRow(name) {
  const key = norm(name);
  return (
    key === norm(REMAINS_TRANSIT_CUSTOMERS) ||
    key === norm(REMAINS_TRANSIT_RETURNS) ||
    key === norm(REMAINS_TOTAL)
  );
}

/**
 * @returns {{ cluster: string | null, kind: "cluster" | "cis" | "unknown" }}
 */
export function clusterByWarehouse(name) {
  const key = norm(name);
  if (!key) return { cluster: null, kind: "unknown" };
  for (const w of CIS_WORDS) {
    if (key.includes(w)) return { cluster: null, kind: "cis" };
  }
  for (const rule of WAREHOUSE_RULES) {
    for (const w of rule.words) {
      if (key.includes(w)) return { cluster: rule.cluster, kind: "cluster" };
    }
  }
  return { cluster: null, kind: "unknown" };
}
