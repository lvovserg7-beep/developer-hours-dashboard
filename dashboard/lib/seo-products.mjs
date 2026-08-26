/**
 * Классификация SEO-запросов по продуктам.
 * Правила — по подстрокам (без регистра). Порядок важен: первое совпадение побеждает.
 * Точные переопределения — в data/seo-query-class.csv (query,product).
 * Новые запросы без правила → other (Прочее).
 */

export const SEO_PRODUCTS = [
  { id: "brand", label: "Запросы по бренду" },
  { id: "marketplaces", label: "Маркетплейсы" },
  { id: "suppliers", label: "Интеграции с поставщиками" },
  { id: "boxes", label: "1С-коробки" },
  { id: "development", label: "Разработка" },
  { id: "support", label: "Поддержка" },
  { id: "other", label: "Прочее" },
];

export const SEO_PRODUCT_IDS = SEO_PRODUCTS.map((p) => p.id);

/** @type {{ id: string, patterns: RegExp[] }[]} */
const RULES = [
  {
    id: "brand",
    patterns: [
      /алл\s*сан/i,
      /алсан/i,
      /аслан\s*интеграц/i,
      /\balsn\b/i,
      /\balsan\b/i,
      /\balsun\b/i,
      /alsn\.ru/i,
      /@alsn\.ru/i,
      /ооо\s*[«"]?\s*алл?\s*сан/i,
      /модуль\s+от\s+компании\s+[«"]?алл?\s*сан/i,
      /1217700218999/,
      /алл?\s*сан.*(?:телефон|тел\.|звон|адрес|отзыв)/i,
      /(?:телефон|тел\.|адрес).*(?:алл?\s*сан)/i,
    ],
  },
  {
    id: "marketplaces",
    patterns: [
      /маркетплейс/i,
      /\bozon\b/i,
      /озон/i,
      /wildberries/i,
      /\bwb\b/i,
      /перевыставлен/i,
      /последней\s*мили/i,
      /селлер/i,
      /услуг\s*мили/i,
    ],
  },
  {
    id: "suppliers",
    patterns: [
      /merlion/i,
      /мерлион/i,
      /\bocs\b/i,
      /\bvtt\b/i,
      /втт/i,
      /treolan/i,
      /треолан/i,
      /аувикс/i,
      /\bэтм\b/i,
      /ресурс\s*медиа/i,
      /русский\s*свет/i,
      /\bb2b\b/i,
      /б2б/i,
      /в2в/i,
      /и2и/i,
    ],
  },
  // Услуги разработки — раньше коробок, чтобы «внедрение УТ/ERP» не уезжало в коробки.
  {
    id: "development",
    patterns: [
      /внедрен/i,
      /внедрить/i,
      /битрикс/i,
      /bitrix/i,
      /интеграция\s*сайта/i,
      /чат[-\s]?бот/i,
      /телеграм/i,
      /whatsapp|ватсап|вотсап/i,
      /переход\s*с\s*(?:ут|упп|унф|1с)/i,
      /переход\s*из\s*(?:ут|упп|унф|1с)/i,
      /перенос\s*(?:данных|документов|справочников)/i,
      /синхронизация/i,
      /интегратор\s*1с/i,
      /разработк/i,
      /доработка/i,
      /rfid/i,
      /модуль\s*обмена/i,
    ],
  },
  // Сопровождение / обслуживание — не КП (КП в коробках).
  {
    id: "support",
    patterns: [
      /обслуживание\s*1с/i,
      /сопровождение/i,
      /техподдержка/i,
      /поддержка\s*1с/i,
      /1с\s*поддержка/i,
      /\bсппр\b/i,
    ],
  },
  // Целевые запросы на продукты 1С: КП, УТ, УПП, ERP, лицензии, поставки.
  {
    id: "boxes",
    patterns: [
      /комплект\s*поддержки/i,
      /1с\s*кп\b/i,
      /1\s*с\s*кп\b/i,
      /1с:кп/i,
      /1с:\s*кп/i,
      /\bкп\b.*(?:базов|проф|упп|гу|месяц|льгот|отраслев|схем)/i,
      /(?:базов|проф|упп|гу).*кп/i,
      /кпбаз/i,
      /кп\s*(?:базов|проф|упп|гу)/i,
      /купить\s*(?:кп|итс)/i,
      /\bитс\b/i,
      /управление\s*торговл/i,
      /\but\s*1[01]/i,
      /\b1с\s*ут\b/i,
      /\bупп\b/i,
      /\bунф\b/i,
      /\bзуп\b/i,
      /зарплат[а-яё]*\s*и\s*кадр/i,
      /комплексн[а-яё]*\s*автоматизац/i,
      /\b1с\s*ка\b/i,
      /1с\s*ка\s/i,
      /\berp\b/i,
      /ерп/i,
      /1с\s*бухгалтери/i,
      /бухгалтери[а-яё]*\s*(?:8|предприя|нко|птице|строител)/i,
      /лицензи[яию].*1с|1с.*лицензи[яию]/i,
      /электронн[а-яё]*\s*поставк/i,
      /короб[а-яё]*\s*поставк/i,
      /купить\s*1с|1с.*купить/i,
      /артикул\s*:?\s*290000|290000\d{5,}/i,
      /1с:предприятие|1с\s*предприятие/i,
      /клиентск[а-яё]*\s*лицензи/i,
      /сервер\s*мини/i,
      /1с\s*эдо|1с-эдо|1с-эпд|1с\s*эпд/i,
      /1с\s*аналитик/i,
      /1с:аналитик/i,
      /1с\s*медицин/i,
      /1с\s*общепит|1с\s*розниц|1с\s*документ/i,
      /upgrade\s*290000/i,
      /цена\s*лицензи/i,
    ],
  },
];

export function productLabel(id) {
  return SEO_PRODUCTS.find((p) => p.id === id)?.label || id;
}

/**
 * @param {string} query
 * @param {Map<string, string>} [exactMap] lowercase query → product id
 */
export function classifyQuery(query, exactMap) {
  const text = String(query || "").trim();
  if (!text) return "other";
  const key = text.toLowerCase();
  if (exactMap?.has(key)) {
    const id = exactMap.get(key);
    if (SEO_PRODUCT_IDS.includes(id)) return id;
  }
  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) return rule.id;
  }
  return "other";
}

/** Классификация только по правилам (без CSV). */
export function classifyQueryByRules(query) {
  return classifyQuery(query, null);
}
