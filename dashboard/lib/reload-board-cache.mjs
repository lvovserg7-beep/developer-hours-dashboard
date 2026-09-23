import { clearBoardCache, listBoardCaches, resolveCachePeriod } from "./board-cache.mjs";
import { refreshSeoCacheForPeriod } from "./load-seo.mjs";

const SEO_BOARDS = new Set(["all", "seo", "seoqueries", "seopositions"]);
const HOURS_BOARDS = new Set(["hours", "activity"]);

function summarizeSeo(result) {
  if (!result) return null;
  return {
    from: result.from,
    to: result.to,
    gsc: (result.seo?.gsc || []).length,
    yandex: (result.seo?.yandex || []).length,
    positions: result.pos?.fetched || 0,
    wordstat: result.wordstat?.fetched || 0,
    warnings: [
      ...(result.seo?.warnings || []),
      ...(result.pos?.warnings || []),
      ...(result.wordstat?.warnings || []),
    ].filter(Boolean),
  };
}

/**
 * Сбросить кэш доски за период и сразу загрузить данные заново.
 * Для «все» — как «Очистить все за период» (часы не трогаем), затем SEO за эти даты.
 * @param {string} board
 * @param {{ from?: string, to?: string } | null} periodOpts
 * @param {{
 *   clear?: typeof clearBoardCache,
 *   refreshSeo?: typeof refreshSeoCacheForPeriod,
 *   refreshHours?: () => Promise<unknown>,
 *   list?: typeof listBoardCaches,
 * }} [hooks]
 */
export async function reloadBoardCache(board, periodOpts = null, hooks = {}) {
  const key = String(board || "").trim();
  if (!key) throw new Error("Не указана доска");
  const period = resolveCachePeriod(periodOpts?.from, periodOpts?.to);
  if (!period) throw new Error("Укажите период (с и по)");

  const clear = hooks.clear || clearBoardCache;
  const refreshSeo = hooks.refreshSeo || refreshSeoCacheForPeriod;
  const list = hooks.list || listBoardCaches;

  const cleared = clear(key, period);
  const loaded = { seo: null, hours: null };

  if (HOURS_BOARDS.has(key)) {
    if (typeof hooks.refreshHours !== "function") {
      throw new Error("Снимок часов перечитывается только с сервера ЦУК");
    }
    await hooks.refreshHours();
    loaded.hours = { ok: true };
  } else if (SEO_BOARDS.has(key)) {
    loaded.seo = summarizeSeo(
      await refreshSeo({ from: period.from, to: period.to, force: true })
    );
  } else {
    throw new Error("Для этой доски нет загрузки кэша за период");
  }

  return {
    ...cleared,
    reloaded: true,
    loaded,
    boards: list(period),
    period: cleared.period || period,
  };
}

export { SEO_BOARDS, HOURS_BOARDS };
