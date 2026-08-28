import { gscConfigured, gscSearchAnalyticsAll, gscSiteUrls } from "./gsc.mjs";
import {
  maxDailyDate,
  readDailyRows,
  readQueryRows,
  replaceQueryRows,
  upsertDailyRows,
  upsertQueryClasses,
  overwriteQueryClasses,
  readQueryClassMap,
  readQueryDailyRows,
  upsertQueryDailyRows,
  readWordstatMap,
  upsertWordstatRows,
} from "./seo-csv.mjs";
import {
  classifyQuery,
  classifyQueryByRules,
  productLabel,
  SEO_PRODUCTS,
  SEO_PRODUCT_IDS,
} from "./seo-products.mjs";
import {
  yandexConfigured,
  yandexPopularQueries,
  yandexQueryHistory,
  yandexQueryHistoryById,
  yandexResolveHostIds,
} from "./yandex-webmaster.mjs";
import { fetchWordstatFrequency, wordstatConfigured } from "./wordstat.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK = 90;
const POSITIONS_TOP_PER_PRODUCT = 5;
const WORDSTAT_CACHE_DAYS = 7;
/** Сколько последних дней daily всегда перечитываем из API (лаг Вебмастера/GSC 1–3 дня). */
const DAILY_TRAILING_RESYNC_DAYS = 7;

function pad(n) {
  return String(n).padStart(2, "0");
}

function ymd(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseYmd(value) {
  const m = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function addDays(date, n) {
  return new Date(date.getTime() + n * DAY_MS);
}

function lookbackDays() {
  const n = Number(process.env.SEO_LOOKBACK_DAYS || DEFAULT_LOOKBACK);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 450) : DEFAULT_LOOKBACK;
}

/**
 * Диапазон суточной догрузки.
 * Всегда включает скользящее окно последних DAILY_TRAILING_RESYNC_DAYS:
 * иначе нулевой placeholder за «вчера» (API ещё молчит) навсегда блокирует день
 * через hasDailyDate / maxDailyDate+1.
 */
function computeDailySyncRange(source, site, yesterday, force) {
  const lookbackFrom = ymd(addDays(startOfLocalDay(), -lookbackDays()));
  const trailingFrom = ymd(addDays(parseYmd(yesterday), -(DAILY_TRAILING_RESYNC_DAYS - 1)));
  if (force) return { from: lookbackFrom, to: yesterday };

  const max = maxDailyDate(source, site);
  if (!max) return { from: lookbackFrom, to: yesterday };

  const afterMax = ymd(addDays(parseYmd(max), 1));
  let from = trailingFrom;
  // дыра после max — тянем с max+1, даже если это раньше trailing window
  if (afterMax <= yesterday && afterMax < from) from = afterMax;
  if (from < lookbackFrom) from = lookbackFrom;
  return { from, to: yesterday };
}

function mapHistoryToDaily(source, site, merged) {
  return merged.map((r) => ({
    source,
    site,
    date: r.date,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

/** Вчера по локальному календарю — целевой день суточной догрузки. */
export function seoYesterday() {
  return ymd(addDays(startOfLocalDay(), -1));
}

function envFlag(name, fallback = true) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function seriesByDate(indicators, key) {
  const list = indicators?.[key] || indicators?.[key.toLowerCase()] || [];
  const map = new Map();
  for (const item of list) {
    const date = String(item.date || "").slice(0, 10);
    if (!date) continue;
    map.set(date, Number(item.value) || 0);
  }
  return map;
}

function mergeYandexHistory(data) {
  const ind = data.indicators || data;
  const shows = seriesByDate(ind, "TOTAL_SHOWS");
  const clicks = seriesByDate(ind, "TOTAL_CLICKS");
  const showPos = seriesByDate(ind, "AVG_SHOW_POSITION");
  const clickPos = seriesByDate(ind, "AVG_CLICK_POSITION");
  const dates = new Set([...shows.keys(), ...clicks.keys(), ...showPos.keys(), ...clickPos.keys()]);
  const rows = [];
  for (const date of [...dates].sort()) {
    const impressions = shows.get(date) || 0;
    const clk = clicks.get(date) || 0;
    const position = showPos.get(date) || clickPos.get(date) || 0;
    rows.push({
      date,
      clicks: clk,
      impressions,
      ctr: impressions > 0 ? clk / impressions : 0,
      position,
    });
  }
  return rows;
}

async function syncGscSite(site, yesterday, opts = {}) {
  const force = Boolean(opts.force);
  const { from, to } =
    opts.rangeFrom && opts.rangeTo
      ? { from: String(opts.rangeFrom).slice(0, 10), to: String(opts.rangeTo).slice(0, 10) }
      : computeDailySyncRange("gsc", site, yesterday, force);
  const haveQueries = readQueryRows().some((r) => r.source === "gsc" && r.site === site);

  if (from > to) {
    // не должно случаться при нормальном yesterday; каталог всё равно обновим при необходимости
    if (!haveQueries) {
      try {
        const qFrom = ymd(addDays(startOfLocalDay(), -lookbackDays()));
        const queryRows = await gscSearchAnalyticsAll(site, {
          startDate: qFrom,
          endDate: yesterday,
          dimensions: ["query"],
          rowLimit: 500,
        });
        const gscQueries = queryRows
          .map((r) => {
            const clicks = Number(r.clicks) || 0;
            const impressions = Number(r.impressions) || 0;
            return {
              source: "gsc",
              site,
              period_from: qFrom,
              period_to: yesterday,
              query: String(r.keys?.[0] || ""),
              clicks,
              impressions,
              ctr: Number(r.ctr) || (impressions > 0 ? clicks / impressions : 0),
              position: Number(r.position) || 0,
            };
          })
          .filter((r) => r.query);
        if (gscQueries.length) {
          replaceQueryRows("gsc", site, gscQueries);
          ensureSeoQueryClasses(gscQueries.map((q) => q.query));
        }
        return { site, skipped: false, from, to, days: 0, queries: gscQueries.length, repaired: true };
      } catch (err) {
        return { site, skipped: true, reason: `период пуст, каталог: ${err.message || err}` };
      }
    }
    return { site, skipped: true, reason: "период пуст" };
  }

  const dateRows = await gscSearchAnalyticsAll(site, {
    startDate: from,
    endDate: to,
    dimensions: ["date"],
  });
  const daily = dateRows.map((r) => {
    const date = String(r.keys?.[0] || "").slice(0, 10);
    const clicks = Number(r.clicks) || 0;
    const impressions = Number(r.impressions) || 0;
    return {
      source: "gsc",
      site,
      date,
      clicks,
      impressions,
      ctr: Number(r.ctr) || (impressions > 0 ? clicks / impressions : 0),
      position: Number(r.position) || 0,
    };
  }).filter((r) => r.date);
  // Placeholder только если API вовсе не отдал вчера — и только внутри trailing-окна,
  // которое на следующих стартах перечитается (не «запечатывает» день навсегда).
  if (!daily.some((r) => r.date === yesterday)) {
    daily.push({
      source: "gsc",
      site,
      date: yesterday,
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    });
  }
  upsertDailyRows(daily);

  const qFrom = ymd(addDays(startOfLocalDay(), -lookbackDays()));
  const qTo = yesterday;
  const queryRows = await gscSearchAnalyticsAll(site, {
    startDate: qFrom,
    endDate: qTo,
    dimensions: ["query"],
    rowLimit: 500,
  });
  const gscQueries = queryRows
    .map((r) => {
      const clicks = Number(r.clicks) || 0;
      const impressions = Number(r.impressions) || 0;
      return {
        source: "gsc",
        site,
        period_from: qFrom,
        period_to: qTo,
        query: String(r.keys?.[0] || ""),
        clicks,
        impressions,
        ctr: Number(r.ctr) || (impressions > 0 ? clicks / impressions : 0),
        position: Number(r.position) || 0,
      };
    })
    .filter((r) => r.query);
  if (gscQueries.length) {
    replaceQueryRows("gsc", site, gscQueries);
    ensureSeoQueryClasses(gscQueries.map((q) => q.query));
  }

  return { site, skipped: false, from, to, days: daily.length, queries: gscQueries.length };
}

async function refreshYandexQueryCatalog(hostId, yesterday) {
  const qFrom = ymd(addDays(startOfLocalDay(), -lookbackDays()));
  const qTo = yesterday;
  const popular = await yandexPopularQueries(hostId, qFrom, qTo, { limit: 500 });
  const list = popular.queries || popular.popular_queries || popular.items || [];
  const queries = list
    .map((q) => {
      const ind = q.indicators || {};
      const clicks = Number(q.clicks ?? q.TOTAL_CLICKS ?? ind.TOTAL_CLICKS) || 0;
      const impressions = Number(q.impressions ?? q.TOTAL_SHOWS ?? ind.TOTAL_SHOWS) || 0;
      const position =
        Number(q.position ?? q.AVG_SHOW_POSITION ?? ind.AVG_SHOW_POSITION) || 0;
      const text = String(q.query_text || q.query || q.text || "").trim();
      return {
        source: "yandex",
        site: hostId,
        period_from: String(popular.date_from || qFrom).slice(0, 10),
        period_to: String(popular.date_to || qTo).slice(0, 10),
        query: text,
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position,
      };
    })
    .filter((r) => r.query);
  if (queries.length) {
    replaceQueryRows("yandex", hostId, queries);
    ensureSeoQueryClasses(queries.map((q) => q.query));
  }
  return queries.length;
}

async function syncYandexHost(hostId, yesterday, opts = {}) {
  const force = Boolean(opts.force);
  const haveQueries = readQueryRows().some((r) => r.source === "yandex" && r.site === hostId);
  const { from, to } =
    opts.rangeFrom && opts.rangeTo
      ? { from: String(opts.rangeFrom).slice(0, 10), to: String(opts.rangeTo).slice(0, 10) }
      : computeDailySyncRange("yandex", hostId, yesterday, force);

  if (from > to) {
    if (!haveQueries) {
      try {
        const n = await refreshYandexQueryCatalog(hostId, yesterday);
        return { site: hostId, skipped: false, from, to, days: 0, queries: n, repaired: true };
      } catch (err) {
        return { site: hostId, skipped: true, reason: `период пуст, каталог: ${err.message || err}` };
      }
    }
    return { site: hostId, skipped: true, reason: "период пуст" };
  }

  const history = await yandexQueryHistory(hostId, from, to);
  const merged = mergeYandexHistory(history).filter((r) => r.date >= from && r.date <= to);
  const daily = mapHistoryToDaily("yandex", hostId, merged);
  // Нулевой placeholder за вчера — только временный: trailing-окно перечитает день,
  // когда Вебмастер отдаст показы (раньше hasDailyDate навсегда пропускал sync).
  if (!daily.some((r) => r.date === yesterday)) {
    daily.push({
      source: "yandex",
      site: hostId,
      date: yesterday,
      clicks: 0,
      impressions: 0,
      ctr: 0,
      position: 0,
    });
  }
  upsertDailyRows(daily);

  let queries = 0;
  try {
    queries = await refreshYandexQueryCatalog(hostId, yesterday);
  } catch (err) {
    console.warn(`SEO Yandex queries ${hostId}:`, err.message || err);
  }

  return { site: hostId, skipped: false, from, to, days: daily.length, queries };
}

let syncInflight = null;
let trailingInflight = null;

function trailingWindow(yesterday, days = DAILY_TRAILING_RESYNC_DAYS) {
  const to = yesterday || seoYesterday();
  const n = Math.max(1, Math.floor(Number(days) || DAILY_TRAILING_RESYNC_DAYS));
  const from = ymd(addDays(parseYmd(to), -(n - 1)));
  return { from, to };
}

function applySeoQueryClasses() {
  const cls = ensureSeoQueryClasses(readQueryRows().map((r) => r.query));
  const brand = reclassifyBrandSeoQueries();
  const boxes = reclassifyBoxesSeoQueries();
  return { cls, brand, boxes };
}

/**
 * Перечитать и перезаписать кэш за скользящее окно (по умолчанию 7 дней):
 * суточные CSV сайта, позиции топ-ключей и частоты Wordstat.
 * @param {{ yesterday?: string, days?: number, force?: boolean, allWordstat?: boolean }} [opts]
 */
export async function refreshSeoTrailingCache(opts = {}) {
  if (trailingInflight) return trailingInflight;
  trailingInflight = (async () => {
    const days = Math.max(1, Math.floor(Number(opts.days) || DAILY_TRAILING_RESYNC_DAYS));
    const { from, to } = trailingWindow(opts.yesterday, days);
    const seo = await syncSeoCsv({
      yesterday: to,
      force: Boolean(opts.force),
      rangeFrom: from,
      rangeTo: to,
    });
    let classes = { cls: { total: 0, added: 0 }, brand: { updated: 0, added: 0, total: 0 }, boxes: { updated: 0, added: 0, total: 0 } };
    try {
      classes = applySeoQueryClasses();
    } catch (err) {
      const msg = `классификация: ${err.message || err}`;
      seo.warnings = [...(seo.warnings || []), msg];
      console.warn("SEO product classes:", err.message || err);
    }
    const pos = await ensureSeoQueryPositions({ from, to, force: true });
    const picked = pickTopQueriesByProduct({ from, to });
    const wordstatList = opts.allWordstat
      ? [...new Set(readQueryRows().map((r) => r.query))]
      : picked.flat.map((q) => q.query);
    const wordstat = await ensureWordstatFrequencies(wordstatList, { force: true });
    return { from, to, seo, pos, wordstat, classes };
  })().finally(() => {
    trailingInflight = null;
  });
  return trailingInflight;
}

/**
 * Суточная догрузка CSV.
 * Последние DAILY_TRAILING_RESYNC_DAYS всегда перечитываются из API
 * (лаг Вебмастера/GSC), чтобы нулевые placeholder’ы не «запечатывали» дни.
 */
export async function syncSeoCsv(opts = {}) {
  if (syncInflight) return syncInflight;
  syncInflight = (async () => {
    const yesterday = opts.yesterday || seoYesterday();
    const result = {
      at: new Date().toISOString(),
      yesterday,
      gsc: [],
      yandex: [],
      warnings: [],
    };

    if (envFlag("SEO_GSC_ENABLED", true) && gscConfigured()) {
      for (const site of gscSiteUrls()) {
        try {
          result.gsc.push(
            await syncGscSite(site, yesterday, {
              force: Boolean(opts.force),
              rangeFrom: opts.rangeFrom,
              rangeTo: opts.rangeTo,
            })
          );
        } catch (err) {
          const msg = `GSC ${site}: ${err.message || err}`;
          result.warnings.push(msg);
          console.warn("SEO sync:", msg);
        }
      }
    } else if (envFlag("SEO_GSC_ENABLED", true)) {
      result.warnings.push("GSC не настроен (GSC_CREDENTIALS_PATH + GSC_SITE_URL)");
    }

    if (envFlag("SEO_YANDEX_ENABLED", true) && yandexConfigured()) {
      try {
        const hosts = await yandexResolveHostIds();
        if (!hosts.length) result.warnings.push("Яндекс.Вебмастер: нет host_id");
        for (const hostId of hosts) {
          try {
            result.yandex.push(
              await syncYandexHost(hostId, yesterday, {
                force: Boolean(opts.force),
                rangeFrom: opts.rangeFrom,
                rangeTo: opts.rangeTo,
              })
            );
          } catch (err) {
            const msg = `Яндекс ${hostId}: ${err.message || err}`;
            result.warnings.push(msg);
            console.warn("SEO sync:", msg);
          }
        }
      } catch (err) {
        const msg = `Яндекс.Вебмастер: ${err.message || err}`;
        result.warnings.push(msg);
        console.warn("SEO sync:", msg);
      }
    } else if (envFlag("SEO_YANDEX_ENABLED", true)) {
      result.warnings.push("Яндекс.Вебмастер не настроен (YANDEX_WEBMASTER_TOKEN)");
    }

    return result;
  })().finally(() => {
    syncInflight = null;
  });
  return syncInflight;
}

export function defaultSeoRange() {
  const to = seoYesterday();
  const from = ymd(addDays(parseYmd(to) || startOfLocalDay(), -6));
  return { from, to };
}

/**
 * Отчёт для вкладки из CSV (без обращения к API).
 * @param {{ from?: string, to?: string, source?: string, site?: string, queryLimit?: number|null }} opts
 * queryLimit: 10 по умолчанию; 0 / null / Infinity — полный список.
 */
export function loadSeoReport({ from, to, source = "all", site = "", queryLimit = 10 } = {}) {
  const range = defaultSeoRange();
  const dateFrom = parseYmd(from) ? String(from).slice(0, 10) : range.from;
  const dateTo = parseYmd(to) ? String(to).slice(0, 10) : range.to;
  if (dateFrom > dateTo) throw new Error("Дата «с» не может быть позже «по»");

  const srcFilter = String(source || "all").toLowerCase();
  const siteFilter = String(site || "").trim();
  const limitRaw = queryLimit == null ? 0 : Number(queryLimit);
  const limit = !Number.isFinite(limitRaw) || limitRaw <= 0 ? 0 : Math.floor(limitRaw);

  const daily = readDailyRows().filter((r) => {
    if (r.date < dateFrom || r.date > dateTo) return false;
    if (srcFilter !== "all" && r.source !== srcFilter) return false;
    if (siteFilter && r.site !== siteFilter) return false;
    return true;
  });

  const byDate = new Map();
  const bySource = { gsc: { clicks: 0, impressions: 0 }, yandex: { clicks: 0, impressions: 0 } };
  const sites = new Set();
  for (const row of daily) {
    sites.add(`${row.source}|${row.site}`);
    const bucket = byDate.get(row.date) || {
      date: row.date,
      clicks: 0,
      impressions: 0,
      gscClicks: 0,
      gscImpressions: 0,
      yandexClicks: 0,
      yandexImpressions: 0,
    };
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    if (row.source === "gsc") {
      bucket.gscClicks += row.clicks;
      bucket.gscImpressions += row.impressions;
      bySource.gsc.clicks += row.clicks;
      bySource.gsc.impressions += row.impressions;
    } else if (row.source === "yandex") {
      bucket.yandexClicks += row.clicks;
      bucket.yandexImpressions += row.impressions;
      bySource.yandex.clicks += row.clicks;
      bySource.yandex.impressions += row.impressions;
    }
    byDate.set(row.date, bucket);
  }

  const series = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const totals = {
    clicks: series.reduce((s, r) => s + r.clicks, 0),
    impressions: series.reduce((s, r) => s + r.impressions, 0),
  };
  totals.ctr = totals.impressions > 0 ? totals.clicks / totals.impressions : 0;

  let queries = readQueryRows()
    .filter((r) => {
      if (srcFilter !== "all" && r.source !== srcFilter) return false;
      if (siteFilter && r.site !== siteFilter) return false;
      // снимок топа за период синка — показываем если пересекается с выбранным окном
      if (r.period_to < dateFrom || r.period_from > dateTo) return false;
      return true;
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  if (limit > 0) queries = queries.slice(0, limit);

  const siteOptions = [...new Set(readDailyRows().map((r) => r.site))].sort();
  const maxDates = {};
  for (const key of sites) {
    const [source, siteKey] = key.split("|");
    maxDates[key] = maxDailyDate(source, siteKey);
  }

  return {
    generatedAt: new Date().toISOString(),
    period: { from: dateFrom, to: dateTo },
    yesterday: seoYesterday(),
    totals,
    bySource,
    series,
    queries,
    queryLimit: limit,
    sites: siteOptions,
    coverage: maxDates,
    note:
      "Данные из CSV (data/seo-daily.csv, data/seo-queries.csv). " +
      "Сервер догружает пропуск при старте, если за вчера ещё нет строк. " +
      "У поисковиков возможна задержка 1–3 дня.",
  };
}

/**
 * Дописать классы для новых запросов (уже известные в CSV не трогаем).
 * Первичный прогон (пустой CSV классов): правила продуктов.
 * Дальше новые запросы → «Прочее» (ручная переклассификация позже).
 */
export function ensureSeoQueryClasses(queries) {
  const list = Array.isArray(queries) ? queries : [];
  const exact = readQueryClassMap();
  const bootstrap = exact.size === 0;
  const incoming = [];
  const seen = new Set();
  for (const raw of list) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key) || exact.has(key)) continue;
    seen.add(key);
    incoming.push({
      query,
      product: bootstrap ? classifyQuery(query) : "other",
    });
  }
  if (!incoming.length) return { total: exact.size, added: 0, bootstrap };
  const result = upsertQueryClasses(incoming);
  return { ...result, bootstrap };
}

/**
 * Перепроставить в CSV классы по актуальным правилам для уже известных запросов
 * (например, новый продукт «Запросы по бренду»).
 * Меняет только те строки, где правило даёт другой product.
 */
export function reclassifySeoQueryClassesByRules(queries) {
  const list = Array.isArray(queries) && queries.length
    ? queries
    : readQueryRows().map((r) => r.query);
  const incoming = [];
  const seen = new Set();
  for (const raw of list) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    incoming.push({ query, product: classifyQueryByRules(query) });
  }
  return overwriteQueryClasses(incoming);
}

/** Разовая/периодическая переклассификация брендовых запросов (правило brand). */
export function reclassifyBrandSeoQueries(queries) {
  return reclassifySeoQueriesForProduct("brand", queries);
}

/** Переклассификация запросов продукта «1С-коробки». */
export function reclassifyBoxesSeoQueries(queries) {
  return reclassifySeoQueriesForProduct("boxes", queries);
}

function reclassifySeoQueriesForProduct(productId, queries) {
  const list = Array.isArray(queries) && queries.length
    ? queries
    : readQueryRows().map((r) => r.query);
  const incoming = [];
  const seen = new Set();
  for (const raw of list) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (classifyQueryByRules(query) === productId) {
      incoming.push({ query, product: productId });
    }
  }
  return overwriteQueryClasses(incoming);
}

function periodQueryKey(source, site, query) {
  return `${source}\t${site}\t${String(query || "").toLowerCase()}`;
}

function yandexPopularMetrics(q) {
  const ind = q.indicators && !Array.isArray(q.indicators) ? q.indicators : {};
  const fromArr = (name) => {
    if (!Array.isArray(q.indicators)) return null;
    const hit = q.indicators.find((x) => (x.name || x.indicator || x.query_indicator) === name);
    return hit == null ? null : hit.value ?? hit.count;
  };
  const clicks = Number(q.clicks ?? q.TOTAL_CLICKS ?? ind.TOTAL_CLICKS ?? fromArr("TOTAL_CLICKS")) || 0;
  const impressions = Number(q.impressions ?? q.TOTAL_SHOWS ?? ind.TOTAL_SHOWS ?? fromArr("TOTAL_SHOWS")) || 0;
  const position =
    Number(q.position ?? q.AVG_SHOW_POSITION ?? ind.AVG_SHOW_POSITION ?? fromArr("AVG_SHOW_POSITION")) || 0;
  return { clicks, impressions, position };
}

function queryDailyPeriodMap(from, to, srcFilter, siteFilter) {
  const map = new Map();
  for (const r of readQueryDailyRows()) {
    if (r.date < from || r.date > to) continue;
    if (srcFilter !== "all" && r.source !== srcFilter) continue;
    if (siteFilter && r.site !== siteFilter) continue;
    const key = periodQueryKey(r.source, r.site, r.query);
    const prev = map.get(key) || {
      query: r.query,
      source: r.source,
      site: r.site,
      clicks: 0,
      impressions: 0,
      positionSum: 0,
      days: 0,
    };
    prev.clicks += r.clicks;
    prev.impressions += r.impressions;
    if (r.position > 0) {
      prev.positionSum += r.position;
      prev.days += 1;
    }
    map.set(key, prev);
  }
  for (const [key, v] of map) {
    map.set(key, {
      query: v.query,
      source: v.source,
      site: v.site,
      clicks: v.clicks,
      impressions: v.impressions,
      position: v.days > 0 ? v.positionSum / v.days : 0,
    });
  }
  return map;
}

/**
 * Показы/клики по ключам за выбранный период из Вебмастера и GSC.
 */
async function fetchPeriodQueryStats({ from, to, source = "all", site = "" }) {
  const srcFilter = String(source || "all").toLowerCase();
  const siteFilter = String(site || "").trim();
  const map = queryDailyPeriodMap(from, to, srcFilter, siteFilter);
  const warnings = [];
  const tasks = [];

  const put = (sourceName, siteId, query, metrics) => {
    const text = String(query || "").trim();
    if (!text) return;
    map.set(periodQueryKey(sourceName, siteId, text), {
      clicks: metrics.clicks,
      impressions: metrics.impressions,
      position: metrics.position,
      query: text,
      source: sourceName,
      site: siteId,
    });
  };

  if ((srcFilter === "all" || srcFilter === "yandex") && envFlag("SEO_YANDEX_ENABLED", true) && yandexConfigured()) {
    tasks.push(
      (async () => {
        try {
          const hosts = await yandexResolveHostIds();
          const list = siteFilter ? hosts.filter((h) => h === siteFilter) : hosts;
          if (siteFilter && !list.length) return;
          for (const hostId of list) {
            const popular = await yandexPopularQueries(hostId, from, to, { limit: 500 });
            const rows = popular.queries || popular.popular_queries || popular.items || [];
            for (const q of rows) {
              const text = String(q.query_text || q.query || q.text || "").trim();
              put("yandex", hostId, text, yandexPopularMetrics(q));
            }
          }
        } catch (err) {
          warnings.push(`Яндекс.Вебмастер за период: ${err.message || err}`);
        }
      })()
    );
  }

  if ((srcFilter === "all" || srcFilter === "gsc") && envFlag("SEO_GSC_ENABLED", true) && gscConfigured()) {
    tasks.push(
      (async () => {
        try {
          const sites = siteFilter ? gscSiteUrls().filter((s) => s === siteFilter) : gscSiteUrls();
          if (siteFilter && !sites.length) return;
          for (const siteUrl of sites) {
            const rows = await gscSearchAnalyticsAll(siteUrl, {
              startDate: from,
              endDate: to,
              dimensions: ["query"],
              rowLimit: 500,
            });
            for (const r of rows) {
              const text = String(r.keys?.[0] || "").trim();
              const clicks = Number(r.clicks) || 0;
              const impressions = Number(r.impressions) || 0;
              put("gsc", siteUrl, text, {
                clicks,
                impressions,
                position: Number(r.position) || 0,
              });
            }
          }
        } catch (err) {
          warnings.push(`GSC за период: ${err.message || err}`);
        }
      })()
    );
  }

  if (tasks.length) await Promise.all(tasks);
  return { map, warnings };
}

/**
 * Отчёт «Все запросы по продуктам»: классификация + дневная статистика
 * (дневные итоги сайта распределяются по доле кликов/показов запросов продукта).
 * По каждому ключу — показы/клики Вебмастера и GSC за выбранный период.
 */
export async function loadSeoProductsReport({
  from,
  to,
  source = "all",
  site = "",
  product = "all",
  forceWordstat = false,
} = {}) {
  const range = defaultSeoRange();
  const dateFrom = parseYmd(from) ? String(from).slice(0, 10) : range.from;
  const dateTo = parseYmd(to) ? String(to).slice(0, 10) : range.to;
  if (dateFrom > dateTo) throw new Error("Дата «с» не может быть позже «по»");

  const srcFilter = String(source || "all").toLowerCase();
  const siteFilter = String(site || "").trim();
  const productFilter = String(product || "all").trim().toLowerCase();
  if (productFilter !== "all" && !SEO_PRODUCT_IDS.includes(productFilter)) {
    throw new Error("Неизвестный продукт");
  }

  const periodStats = await fetchPeriodQueryStats({
    from: dateFrom,
    to: dateTo,
    source: srcFilter,
    site: siteFilter,
  });

  // подтянуть классы для всех известных запросов
  ensureSeoQueryClasses(readQueryRows().map((r) => r.query));
  const exact = readQueryClassMap();

  const seenKeys = new Set();
  const queryRows = [];
  for (const r of readQueryRows()) {
    if (srcFilter !== "all" && r.source !== srcFilter) continue;
    if (siteFilter && r.site !== siteFilter) continue;
    if (r.period_to < dateFrom || r.period_from > dateTo) continue;
    const productId = classifyQuery(r.query, exact);
    const key = periodQueryKey(r.source, r.site, r.query);
    seenKeys.add(key);
    const wm = periodStats.map.get(key);
    queryRows.push({
      ...r,
      product: productId,
      productLabel: productLabel(productId),
      webmasterImpressions: wm ? wm.impressions : null,
      webmasterClicks: wm ? wm.clicks : null,
      webmasterPosition: wm && wm.position > 0 ? wm.position : null,
    });
  }
  for (const [key, wm] of periodStats.map) {
    if (seenKeys.has(key)) continue;
    if (!wm?.query) continue;
    const productId = classifyQuery(wm.query, exact);
    queryRows.push({
      source: wm.source,
      site: wm.site,
      period_from: dateFrom,
      period_to: dateTo,
      query: wm.query,
      clicks: wm.clicks,
      impressions: wm.impressions,
      ctr: wm.impressions > 0 ? wm.clicks / wm.impressions : 0,
      position: wm.position,
      product: productId,
      productLabel: productLabel(productId),
      webmasterImpressions: wm.impressions,
      webmasterClicks: wm.clicks,
      webmasterPosition: wm.position > 0 ? wm.position : null,
    });
  }

  const wordstat = await ensureWordstatFrequencies(
    [...queryRows]
      .sort((a, b) => (b.webmasterImpressions || 0) - (a.webmasterImpressions || 0))
      .map((q) => q.query),
    { force: Boolean(forceWordstat), limit: forceWordstat ? 0 : 25 }
  );
  const freqMap = readWordstatMap();
  for (const q of queryRows) {
    const ws = freqMap.get(q.query.toLowerCase());
    q.frequency = ws && Number.isFinite(Number(ws.frequency)) ? Number(ws.frequency) : null;
  }

  const weightClicks = Object.fromEntries(SEO_PRODUCT_IDS.map((id) => [id, 0]));
  const weightImp = Object.fromEntries(SEO_PRODUCT_IDS.map((id) => [id, 0]));
  const weightWmImp = Object.fromEntries(SEO_PRODUCT_IDS.map((id) => [id, 0]));
  const weightWmClicks = Object.fromEntries(SEO_PRODUCT_IDS.map((id) => [id, 0]));
  for (const q of queryRows) {
    if (q.webmasterImpressions != null) {
      weightWmImp[q.product] += q.webmasterImpressions;
      weightImp[q.product] += q.webmasterImpressions;
    }
    if (q.webmasterClicks != null) {
      weightWmClicks[q.product] += q.webmasterClicks;
      weightClicks[q.product] += q.webmasterClicks;
    }
  }
  const sumClicks = SEO_PRODUCT_IDS.reduce((s, id) => s + weightClicks[id], 0) || 1;
  const sumImp = SEO_PRODUCT_IDS.reduce((s, id) => s + weightImp[id], 0) || 1;
  const shareClicks = Object.fromEntries(SEO_PRODUCT_IDS.map((id) => [id, weightClicks[id] / sumClicks]));
  const shareImp = Object.fromEntries(SEO_PRODUCT_IDS.map((id) => [id, weightImp[id] / sumImp]));

  const daily = readDailyRows().filter((r) => {
    if (r.date < dateFrom || r.date > dateTo) return false;
    if (srcFilter !== "all" && r.source !== srcFilter) return false;
    if (siteFilter && r.site !== siteFilter) return false;
    return true;
  });

  const seriesMap = new Map();
  for (const row of daily) {
    const bucket =
      seriesMap.get(row.date) ||
      Object.fromEntries([
        ["date", row.date],
        ...SEO_PRODUCT_IDS.flatMap((id) => [
          [`${id}Clicks`, 0],
          [`${id}Impressions`, 0],
        ]),
        ["clicks", 0],
        ["impressions", 0],
      ]);
    for (const id of SEO_PRODUCT_IDS) {
      bucket[`${id}Clicks`] += row.clicks * shareClicks[id];
      bucket[`${id}Impressions`] += row.impressions * shareImp[id];
    }
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    seriesMap.set(row.date, bucket);
  }

  let series = [...seriesMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (productFilter !== "all") {
    series = series.map((row) => ({
      date: row.date,
      clicks: row[`${productFilter}Clicks`] || 0,
      impressions: row[`${productFilter}Impressions`] || 0,
      productClicks: row[`${productFilter}Clicks`] || 0,
      productImpressions: row[`${productFilter}Impressions`] || 0,
    }));
  }

  const filteredQueries = queryRows
    .filter((q) => productFilter === "all" || q.product === productFilter)
    .sort(
      (a, b) =>
        (b.webmasterImpressions || 0) - (a.webmasterImpressions || 0) ||
        (b.frequency || 0) - (a.frequency || 0) ||
        b.clicks - a.clicks
    );

  const productTotals = SEO_PRODUCTS.map((p) => {
    const clicks = weightWmClicks[p.id] || 0;
    const impressions = weightWmImp[p.id] || 0;
    return {
      id: p.id,
      label: p.label,
      clicks,
      impressions,
      webmasterImpressions: impressions,
      webmasterClicks: clicks,
      ctr: impressions > 0 ? clicks / impressions : 0,
      queries: queryRows.filter((q) => q.product === p.id).length,
    };
  });

  const sections = SEO_PRODUCTS.filter((p) => productFilter === "all" || p.id === productFilter).map((p) => {
    const queries = filteredQueries.filter((q) => q.product === p.id);
    const tot = productTotals.find((x) => x.id === p.id) || {};
    return {
      id: p.id,
      label: p.label,
      queries,
      clicks: tot.clicks || 0,
      impressions: tot.impressions || 0,
      webmasterImpressions: tot.webmasterImpressions || 0,
      webmasterClicks: tot.webmasterClicks || 0,
      queriesCount: queries.length,
    };
  });

  const selected =
    productFilter === "all"
      ? {
          clicks: productTotals.reduce((s, p) => s + p.clicks, 0),
          impressions: productTotals.reduce((s, p) => s + p.impressions, 0),
          webmasterImpressions: productTotals.reduce((s, p) => s + (p.webmasterImpressions || 0), 0),
          webmasterClicks: productTotals.reduce((s, p) => s + (p.webmasterClicks || 0), 0),
          queries: queryRows.length,
        }
      : productTotals.find((p) => p.id === productFilter) || {
          clicks: 0,
          impressions: 0,
          webmasterImpressions: 0,
          webmasterClicks: 0,
          queries: 0,
        };
  selected.ctr = selected.impressions > 0 ? selected.clicks / selected.impressions : 0;

  return {
    generatedAt: new Date().toISOString(),
    period: { from: dateFrom, to: dateTo },
    product: productFilter,
    products: SEO_PRODUCTS,
    productTotals,
    sections,
    totals: selected,
    series,
    queries: filteredQueries,
    sites: [...new Set(readDailyRows().map((r) => r.site))].sort(),
    warnings: [...(periodStats.warnings || []), ...(wordstat.warnings || [])].slice(0, 8),
    note:
      "«Запросов» — Wordstat, точная фраза в кавычках (~30 дней по России). " +
      "«Показы» и «Клики» — сколько раз сайт показался / кликнули в Яндекс.Вебмастере или GSC за выбранный период (не за 90 дней каталога). " +
      "Wordstat может быть меньше показов, если период длиннее месяца: это разные окна. " +
      "Дневная статистика — доля продукта в дневных показах сайта по весам ключей за период.",
  };
}

/** Топ-N запросов по кликам внутри каждого продукта. */
export function pickTopQueriesByProduct({
  perProduct = POSITIONS_TOP_PER_PRODUCT,
  source = "all",
  site = "",
  from,
  to,
} = {}) {
  const range = defaultSeoRange();
  const dateFrom = parseYmd(from) ? String(from).slice(0, 10) : range.from;
  const dateTo = parseYmd(to) ? String(to).slice(0, 10) : range.to;
  const srcFilter = String(source || "all").toLowerCase();
  const siteFilter = String(site || "").trim();
  ensureSeoQueryClasses(readQueryRows().map((r) => r.query));
  const exact = readQueryClassMap();

  /** @type {Map<string, { query: string, source: string, site: string, clicks: number, impressions: number, position: number, product: string }>} */
  const byKey = new Map();
  for (const r of readQueryRows()) {
    if (srcFilter !== "all" && r.source !== srcFilter) continue;
    if (siteFilter && r.site !== siteFilter) continue;
    if (r.period_to < dateFrom || r.period_from > dateTo) continue;
    const product = classifyQuery(r.query, exact);
    const key = `${r.source}\t${r.site}\t${r.query.toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        query: r.query,
        source: r.source,
        site: r.site,
        clicks: r.clicks,
        impressions: r.impressions,
        position: r.position,
        product,
      });
    } else {
      prev.clicks += r.clicks;
      prev.impressions += r.impressions;
    }
  }

  const groups = SEO_PRODUCT_IDS.map((id) => {
    const queries = [...byKey.values()]
      .filter((q) => q.product === id)
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, Math.max(1, Math.min(Number(perProduct) || POSITIONS_TOP_PER_PRODUCT, 20)));
    return {
      id,
      label: productLabel(id),
      queries,
    };
  }).filter((g) => g.queries.length);

  return { from: dateFrom, to: dateTo, groups, flat: groups.flatMap((g) => g.queries) };
}

function queryDailyCoverageOk(source, site, query, from, to) {
  const key = query.toLowerCase();
  const rows = readQueryDailyRows().filter(
    (r) => r.source === source && r.site === site && r.query.toLowerCase() === key && r.date >= from && r.date <= to
  );
  if (!rows.length) return false;
  const dates = new Set(rows.map((r) => r.date));
  // достаточно хотя бы половины дней или 3 точек — иначе догружаем
  let days = 0;
  for (let d = parseYmd(from); d && ymd(d) <= to; d = addDays(d, 1)) days += 1;
  const densityOk = dates.size >= Math.min(3, days) || dates.size >= Math.ceil(days * 0.4);
  if (!densityOk) return false;

  // Свежие дни: Вебмастер/GSC обычно отстают на 1–2 суток, но если в CSV нет
  // даже «вчера−1», старые точки не должны блокировать догрузку (иначе 24–25 пустые навсегда).
  const yesterday = seoYesterday();
  const targetTo = to < yesterday ? to : yesterday;
  const maxHave = [...dates].sort().at(-1) || "";
  const lagFloor = ymd(addDays(parseYmd(targetTo), -2));
  if (!maxHave || (lagFloor && maxHave < lagFloor)) return false;
  return true;
}

async function fetchGscQueryDaily(site, query, from, to) {
  const rows = await gscSearchAnalyticsAll(site, {
    startDate: from,
    endDate: to,
    dimensions: ["date"],
    dimensionFilterGroups: [
      {
        filters: [{ dimension: "query", operator: "equals", expression: query }],
      },
    ],
    rowLimit: 500,
  });
  return rows.map((r) => {
    const date = String(r.keys?.[0] || "").slice(0, 10);
    const clicks = Number(r.clicks) || 0;
    const impressions = Number(r.impressions) || 0;
    return {
      source: "gsc",
      site,
      date,
      query,
      clicks,
      impressions,
      ctr: Number(r.ctr) || (impressions > 0 ? clicks / impressions : 0),
      position: Number(r.position) || 0,
    };
  }).filter((r) => r.date);
}

async function fetchYandexQueryDaily(hostId, queryId, queryText, from, to) {
  const history = await yandexQueryHistoryById(hostId, queryId, from, to);
  const merged = mergeYandexHistory(history).filter((r) => r.date >= from && r.date <= to);
  return merged.map((r) => ({
    source: "yandex",
    site: hostId,
    date: r.date,
    query: queryText,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
}

async function yandexQueryIdMap(hostId, from, to) {
  const map = new Map();
  for (const orderBy of ["TOTAL_CLICKS", "TOTAL_SHOWS"]) {
    try {
      const popular = await yandexPopularQueries(hostId, from, to, { limit: 500, orderBy });
      const list = popular.queries || popular.popular_queries || popular.items || [];
      for (const q of list) {
        const text = String(q.query_text || q.query || q.text || "").trim();
        const id = String(q.query_id || q.queryId || "").trim();
        if (text && id && !map.has(text.toLowerCase())) map.set(text.toLowerCase(), id);
      }
    } catch {
      /* ignore one order */
    }
  }
  return map;
}

/**
 * Догрузить дневные позиции для топ-ключей продуктов в CSV.
 */
export async function ensureSeoQueryPositions(opts = {}) {
  const perProduct = Number(opts.perProduct) || POSITIONS_TOP_PER_PRODUCT;
  const picked = pickTopQueriesByProduct({
    perProduct,
    source: opts.source || "all",
    site: opts.site || "",
    from: opts.from,
    to: opts.to,
  });
  const force = Boolean(opts.force);
  const need = picked.flat.filter(
    (q) => force || !queryDailyCoverageOk(q.source, q.site, q.query, picked.from, picked.to)
  );
  if (!need.length) {
    return { from: picked.from, to: picked.to, fetched: 0, skipped: picked.flat.length, warnings: [] };
  }

  const warnings = [];
  const incoming = [];
  /** @type {Map<string, Map<string, string>>} */
  const yandexIdsByHost = new Map();

  for (const q of need) {
    try {
      if (q.source === "gsc") {
        if (!gscConfigured()) {
          warnings.push("GSC не настроен");
          continue;
        }
        const rows = await fetchGscQueryDaily(q.site, q.query, picked.from, picked.to);
        incoming.push(...rows);
      } else if (q.source === "yandex") {
        if (!yandexConfigured()) {
          warnings.push("Яндекс.Вебмастер не настроен");
          continue;
        }
        let idMap = yandexIdsByHost.get(q.site);
        if (!idMap) {
          idMap = await yandexQueryIdMap(q.site, picked.from, picked.to);
          yandexIdsByHost.set(q.site, idMap);
        }
        const queryId = idMap.get(q.query.toLowerCase());
        if (!queryId) {
          warnings.push(`Яндекс: нет query_id для «${q.query}»`);
          continue;
        }
        const rows = await fetchYandexQueryDaily(q.site, queryId, q.query, picked.from, picked.to);
        incoming.push(...rows);
      }
    } catch (err) {
      warnings.push(`${q.source} «${q.query}»: ${err.message || err}`);
    }
  }

  if (incoming.length) upsertQueryDailyRows(incoming);
  return {
    from: picked.from,
    to: picked.to,
    fetched: need.length,
    rows: incoming.length,
    skipped: picked.flat.length - need.length,
    warnings: [...new Set(warnings)],
  };
}

/**
 * Догрузить частоты Wordstat для списка запросов (кэш data/seo-wordstat.csv, TTL ~7 дней).
 */
export async function ensureWordstatFrequencies(queries, opts = {}) {
  const list = Array.isArray(queries) ? queries : [];
  const force = Boolean(opts.force);
  if (!list.length) return { fetched: 0, skipped: 0, warnings: [], configured: wordstatConfigured() };
  if (!wordstatConfigured()) {
    return {
      fetched: 0,
      skipped: list.length,
      warnings: [
        "Wordstat не настроен: укажите YANDEX_WORDSTAT_API_KEY (или YANDEX_SEARCH_API_KEY) и YANDEX_FOLDER_ID в dashboard/.env",
      ],
      configured: false,
    };
  }

  const ttlMs = (Number(process.env.WORDSTAT_CACHE_DAYS) || WORDSTAT_CACHE_DAYS) * DAY_MS;
  const now = Date.now();
  const map = readWordstatMap();
  const need = [];
  const seen = new Set();
  for (const raw of list) {
    const query = String(raw || "").trim();
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cached = map.get(key);
    const age = cached?.fetched_at ? now - Date.parse(cached.fetched_at) : Infinity;
    if (!force && cached && Number.isFinite(age) && age >= 0 && age < ttlMs) continue;
    need.push(query);
  }

  const limitRaw = Number(opts.limit);
  const fetchLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : need.length;
  const toFetch = need.slice(0, fetchLimit);

  const warnings = [];
  const incoming = [];
  for (const query of toFetch) {
    try {
      const { frequency, backend } = await fetchWordstatFrequency(query);
      incoming.push({
        query,
        frequency,
        fetched_at: new Date().toISOString(),
        backend,
      });
      await new Promise((r) => setTimeout(r, 120));
    } catch (err) {
      const msg = String(err.message || err);
      if (/429|quota|rate/i.test(msg)) {
        warnings.push(
          `Wordstat: лимит API (100 запросов в час). Частоты подтянутся с кэша и следующих прогонов. Осталось без кэша: ${need.length - incoming.length}`
        );
        break;
      }
      warnings.push(`Wordstat «${query}»: ${msg}`);
    }
  }
  if (incoming.length) upsertWordstatRows(incoming);
  return {
    fetched: incoming.length,
    skipped: seen.size - need.length,
    warnings: [...new Set(warnings)],
    configured: true,
  };
}

/**
 * Отчёт «Позиции в поисковиках»: топ-5 ключей по продукту + позиции по дням.
 */
export async function loadSeoPositionsReport({
  from,
  to,
  source = "all",
  site = "",
  product = "all",
  force = false,
} = {}) {
  const range = defaultSeoRange();
  const dateFrom = parseYmd(from) ? String(from).slice(0, 10) : range.from;
  const dateTo = parseYmd(to) ? String(to).slice(0, 10) : range.to;
  if (dateFrom > dateTo) throw new Error("Дата «с» не может быть позже «по»");

  const srcFilter = String(source || "all").toLowerCase();
  const siteFilter = String(site || "").trim();
  const productFilter = String(product || "all").trim().toLowerCase();
  if (productFilter !== "all" && !SEO_PRODUCT_IDS.includes(productFilter)) {
    throw new Error("Неизвестный продукт");
  }

  const sync = await ensureSeoQueryPositions({
    from: dateFrom,
    to: dateTo,
    source: srcFilter,
    site: siteFilter,
    force,
  });

  const picked = pickTopQueriesByProduct({
    perProduct: POSITIONS_TOP_PER_PRODUCT,
    source: srcFilter,
    site: siteFilter,
    from: dateFrom,
    to: dateTo,
  });

  const wordstat = await ensureWordstatFrequencies(
    picked.flat.map((q) => q.query),
    { force }
  );
  const freqMap = readWordstatMap();

  const dailyAll = readQueryDailyRows().filter((r) => {
    if (r.date < dateFrom || r.date > dateTo) return false;
    if (srcFilter !== "all" && r.source !== srcFilter) return false;
    if (siteFilter && r.site !== siteFilter) return false;
    return true;
  });

  const dates = [];
  for (let d = parseYmd(dateFrom); d && ymd(d) <= dateTo; d = addDays(d, 1)) {
    dates.push(ymd(d));
  }
  const datesDesc = [...dates].reverse();

  const productIds =
    productFilter === "all" ? SEO_PRODUCT_IDS : SEO_PRODUCT_IDS.filter((id) => id === productFilter);

  const sections = productIds
    .map((id) => {
      const group = picked.groups.find((g) => g.id === id) || { id, label: productLabel(id), queries: [] };
      const queries = group.queries.map((q) => {
        const seriesMap = new Map();
        for (const row of dailyAll) {
          if (row.source !== q.source || row.site !== q.site) continue;
          if (row.query.toLowerCase() !== q.query.toLowerCase()) continue;
          seriesMap.set(row.date, row);
        }
        const positions = datesDesc.map((date, idx) => {
          const cur = seriesMap.get(date);
          const pos = cur && cur.position > 0 ? cur.position : null;
          const olderDate = datesDesc[idx + 1];
          const prev = olderDate ? seriesMap.get(olderDate) : null;
          const prevPos = prev && prev.position > 0 ? prev.position : null;
          let delta = null;
          if (pos != null && prevPos != null) delta = prevPos - pos;
          return {
            date,
            position: pos,
            clicks: cur?.clicks || 0,
            impressions: cur?.impressions || 0,
            delta,
          };
        });
        const ws = freqMap.get(q.query.toLowerCase());
        return {
          query: q.query,
          source: q.source,
          site: q.site,
          clicks: q.clicks,
          impressions: q.impressions,
          avgPosition: q.position,
          frequency: ws ? ws.frequency : null,
          positions,
        };
      });
      return {
        id,
        label: group.label,
        queries,
      };
    })
    .filter((s) => s.queries.length);

  const warnings = [...(sync.warnings || []), ...(wordstat.warnings || [])];
  return {
    generatedAt: new Date().toISOString(),
    period: { from: dateFrom, to: dateTo },
    product: productFilter,
    products: SEO_PRODUCTS,
    dates: datesDesc,
    sections,
    sync: { ...sync, wordstat },
    sites: [...new Set(readDailyRows().map((r) => r.site))].sort(),
    wordstatConfigured: wordstat.configured,
    note:
      "Топ-5 запросов по кликам в каждом продукте. Ячейки — позиция / показы по дням " +
      "(GSC / Яндекс.Вебмастер). Колонка «Частота» — Wordstat (точная фраза в кавычках, ~30 дней), кэш data/seo-wordstat.csv. " +
      (wordstat.configured
        ? ""
        : "Wordstat не настроен: добавьте YANDEX_WORDSTAT_API_KEY и YANDEX_FOLDER_ID. ") +
      "Цвет: 1–3, 4–10, 11–30, 31+. Стрелка — изменение к предыдущему дню.",
    warnings,
  };
}
