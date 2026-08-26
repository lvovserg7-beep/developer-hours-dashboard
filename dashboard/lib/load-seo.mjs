import { gscConfigured, gscSearchAnalyticsAll, gscSiteUrls } from "./gsc.mjs";
import {
  hasDailyDate,
  maxDailyDate,
  readDailyRows,
  readQueryRows,
  replaceQueryRows,
  upsertDailyRows,
} from "./seo-csv.mjs";
import {
  yandexConfigured,
  yandexPopularQueries,
  yandexQueryHistory,
  yandexResolveHostIds,
} from "./yandex-webmaster.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK = 90;

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
  if (!force && hasDailyDate("gsc", site, yesterday)) {
    return { site, skipped: true, reason: `есть данные за ${yesterday}` };
  }
  const max = force ? null : maxDailyDate("gsc", site);
  const from = max
    ? ymd(addDays(parseYmd(max), 1))
    : ymd(addDays(startOfLocalDay(), -lookbackDays()));
  const to = yesterday;
  if (from > to) {
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
  });
  // Если API молчит по дням — всё равно фиксируем вчера нулями, чтобы не крутить sync каждый старт
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

  const queryRows = await gscSearchAnalyticsAll(site, {
    startDate: from,
    endDate: to,
    dimensions: ["query"],
    rowLimit: 500,
  });
  replaceQueryRows(
    "gsc",
    site,
    queryRows.map((r) => {
      const clicks = Number(r.clicks) || 0;
      const impressions = Number(r.impressions) || 0;
      return {
        source: "gsc",
        site,
        period_from: from,
        period_to: to,
        query: String(r.keys?.[0] || ""),
        clicks,
        impressions,
        ctr: Number(r.ctr) || (impressions > 0 ? clicks / impressions : 0),
        position: Number(r.position) || 0,
      };
    })
  );

  return { site, skipped: false, from, to, days: daily.length, queries: queryRows.length };
}

async function syncYandexHost(hostId, yesterday, opts = {}) {
  const force = Boolean(opts.force);
  if (!force && hasDailyDate("yandex", hostId, yesterday)) {
    return { site: hostId, skipped: true, reason: `есть данные за ${yesterday}` };
  }
  const max = force ? null : maxDailyDate("yandex", hostId);
  const from = max
    ? ymd(addDays(parseYmd(max), 1))
    : ymd(addDays(startOfLocalDay(), -lookbackDays()));
  const to = yesterday;
  if (from > to) {
    return { site: hostId, skipped: true, reason: "период пуст" };
  }

  const history = await yandexQueryHistory(hostId, from, to);
  const merged = mergeYandexHistory(history).filter((r) => r.date >= from && r.date <= to);
  const daily = merged.map((r) => ({
    source: "yandex",
    site: hostId,
    date: r.date,
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: r.ctr,
    position: r.position,
  }));
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

  let queries = [];
  try {
    const popular = await yandexPopularQueries(hostId, from, to, { limit: 500 });
    const list = popular.queries || popular.popular_queries || popular.items || [];
    queries = list.map((q) => {
      const ind = q.indicators || {};
      const clicks = Number(q.clicks ?? q.TOTAL_CLICKS ?? ind.TOTAL_CLICKS) || 0;
      const impressions = Number(q.impressions ?? q.TOTAL_SHOWS ?? ind.TOTAL_SHOWS) || 0;
      const position =
        Number(q.position ?? q.AVG_SHOW_POSITION ?? ind.AVG_SHOW_POSITION) || 0;
      const text = String(q.query_text || q.query || q.text || "").trim();
      return {
        source: "yandex",
        site: hostId,
        period_from: String(popular.date_from || from).slice(0, 10),
        period_to: String(popular.date_to || to).slice(0, 10),
        query: text,
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position,
      };
    }).filter((r) => r.query);
    replaceQueryRows("yandex", hostId, queries);
  } catch (err) {
    console.warn(`SEO Yandex queries ${hostId}:`, err.message || err);
  }

  return { site: hostId, skipped: false, from, to, days: daily.length, queries: queries.length };
}

let syncInflight = null;

/**
 * Суточная догрузка CSV: если за вчера уже есть строки — пропуск;
 * иначе тянем весь пропуск с max(date)+1 (или lookback) по вчера.
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
          result.gsc.push(await syncGscSite(site, yesterday, { force: Boolean(opts.force) }));
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
            result.yandex.push(await syncYandexHost(hostId, yesterday, { force: Boolean(opts.force) }));
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
