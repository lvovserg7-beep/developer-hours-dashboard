import test from "node:test";
import assert from "node:assert/strict";
import { reloadBoardCache } from "./reload-board-cache.mjs";

test("перечитывание без дат — ошибка", async () => {
  await assert.rejects(
    () =>
      reloadBoardCache("all", {}, {
        clear() {
          throw new Error("clear не должен вызываться");
        },
        refreshSeo() {
          throw new Error("seo не должен вызываться");
        },
        list() {
          return [];
        },
      }),
    /период|дат/i
  );
});

test("очищает кэш и загружает SEO за указанный период", async () => {
  const calls = [];
  const period = { from: "2026-04-01", to: "2026-04-30" };
  const result = await reloadBoardCache("all", period, {
    clear(board, p) {
      calls.push(["clear", board, p]);
      return { board, removed: 2, rows: 12, period: p, skipped: ["Часы"] };
    },
    async refreshSeo(opts) {
      calls.push(["seo", opts.from, opts.to, opts.force]);
      return {
        from: opts.from,
        to: opts.to,
        seo: { warnings: ["GSC не настроен"], gsc: [], yandex: [{ host: "x" }] },
        pos: { fetched: 4, warnings: [] },
        wordstat: { fetched: 1, warnings: [] },
      };
    },
    list() {
      return [{ id: "seo", hasCache: true }];
    },
  });
  assert.equal(result.reloaded, true);
  assert.equal(result.removed, 2);
  assert.equal(result.rows, 12);
  assert.deepEqual(calls[0], ["clear", "all", period]);
  assert.deepEqual(calls[1], ["seo", "2026-04-01", "2026-04-30", true]);
  assert.equal(result.loaded.seo.yandex, 1);
  assert.equal(result.loaded.seo.positions, 4);
  assert.ok(result.loaded.seo.warnings.includes("GSC не настроен"));
  assert.equal(result.boards[0].id, "seo");
});

test("сначала очистка, затем загрузка — порядок важен", async () => {
  const order = [];
  await reloadBoardCache("seo", { from: "2026-08-01", to: "2026-08-31" }, {
    clear() {
      order.push("clear");
      return { board: "seo", removed: 1, rows: 3, period: { from: "2026-08-01", to: "2026-08-31" } };
    },
    async refreshSeo() {
      order.push("load");
      return { from: "2026-08-01", to: "2026-08-31", seo: { gsc: [], yandex: [], warnings: [] }, pos: {}, wordstat: {} };
    },
    list() {
      return [];
    },
  });
  assert.deepEqual(order, ["clear", "load"]);
});
