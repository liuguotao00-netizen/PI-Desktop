"use strict";

/**
 * The request log: one page of rows plus the provider / model roll-ups, over the
 * same window the cards use.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const { queryLog, LOG_PAGE_SIZE, LOG_MAX_PAGE_SIZE } = require("../src/lib/aggregate.js");
const { makeRecord } = require("./helpers.js");

const NOW = new Date(2026, 9, 22, 15, 30, 0, 0).getTime();
const at = (daysAgo, hour, minute = 0) => {
  const date = new Date(NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
};

const records = [
  makeRecord(at(0, 9), {
    entryId: "newest",
    model: "m1",
    durationMs: 2000,
    ttftMs: 1234,
    status: "complete",
    outputTokens: 100,
  }),
  makeRecord(at(0, 8), { entryId: "second", model: "m1", provider: "acme", durationMs: null, status: "complete" }),
  makeRecord(at(1, 12), {
    entryId: "third",
    model: "m2",
    provider: "other",
    durationMs: 4000,
    status: "error",
    outputTokens: 200,
    costUsd: 0.002,
  }),
  makeRecord(at(2, 12), { entryId: "fourth", model: "m2", provider: "other", status: "aborted", durationMs: 1000 }),
  makeRecord(at(9, 12), { entryId: "old", model: "m3", provider: "acme", status: "complete" }),
];

test("the log pages newest first over the requested window", () => {
  const first = queryLog(records, { range: "7d", nowMs: NOW, page: 1, pageSize: 2 });
  assert.deepEqual(
    first.rows.map((row) => row.id.split(":").pop()),
    ["newest", "second"],
    "the newest two requests of the window",
  );
  assert.equal(first.total, 4, "today twice, yesterday and two days ago");
  assert.equal(first.pageCount, 2);
  assert.equal(first.pageSize, 2);

  const second = queryLog(records, { range: "7d", nowMs: NOW, page: 2, pageSize: 2 });
  assert.deepEqual(
    second.rows.map((row) => row.id.split(":").pop()),
    ["third", "fourth"],
    "the second page holds the rest of the window",
  );

  const all = queryLog(records, { range: "all", nowMs: NOW, page: 1, pageSize: 20 });
  assert.equal(all.total, 5, "the all-range reaches the nine-day-old request");
  assert.deepEqual(
    all.rows.map((row) => row.id.split(":").pop()),
    ["newest", "second", "third", "fourth", "old"],
    "rows are ordered by timestamp, newest first",
  );
  assert.equal(all.rows[0].ttftMs, 1234, "a first call keeps its first-token gap");
  assert.equal(all.rows[1].ttftMs, null, "a call without one stays empty");
});

test("a page out of range is clamped to a page that exists", () => {
  const beyond = queryLog(records, { range: "7d", nowMs: NOW, page: 99, pageSize: 2 });
  assert.equal(beyond.page, 2);
  assert.equal(beyond.rows.length, 2);

  const below = queryLog(records, { range: "7d", nowMs: NOW, page: 0, pageSize: 2 });
  assert.equal(below.page, 1);

  const huge = queryLog(records, { range: "7d", nowMs: NOW, pageSize: 9999 });
  assert.equal(huge.pageSize, LOG_MAX_PAGE_SIZE, "the payload stays bounded");
  assert.equal(queryLog(records, { range: "7d", nowMs: NOW }).pageSize, LOG_PAGE_SIZE);
});

test("the status filter narrows the rows but not the counts behind the menu", () => {
  const all = queryLog(records, { range: "7d", nowMs: NOW, pageSize: 20 });
  assert.deepEqual(all.counts, { all: 4, complete: 2, error: 1, aborted: 1, unknown: 0 });

  const errors = queryLog(records, { range: "7d", nowMs: NOW, status: "error", pageSize: 20 });
  assert.equal(errors.total, 1);
  assert.equal(errors.rows[0].status, "error");
  assert.deepEqual(errors.counts, all.counts, "the menu still counts every ending");

  const aborted = queryLog(records, { range: "today", nowMs: NOW, status: "aborted", pageSize: 20 });
  assert.equal(aborted.total, 0, "nothing was aborted today");
  assert.equal(aborted.pageCount, 1, "an empty log still answers with one page");

  const nonsense = queryLog(records, { range: "7d", nowMs: NOW, status: "teapot", pageSize: 20 });
  assert.equal(nonsense.total, 4, "an unknown status means no filter");
});

test("providers and models roll up requests, tokens, cost and speed", () => {
  const result = queryLog(records, { range: "7d", nowMs: NOW, pageSize: 20 });

  const acme = result.providers.find((group) => group.key === "acme");
  assert.ok(acme);
  assert.equal(acme.requests, 2);
  assert.equal(acme.tokens, 310, "200 + 110 tokens over the two records");
  assert.equal(acme.complete, 2);
  assert.equal(acme.error, 0);
  assert.equal(acme.timedRequests, 1, "only the record with a duration counts");
  assert.equal(acme.timedMs, 2000);
  assert.equal(acme.timedOutput, 100);
  assert.equal(acme.costComplete, true);

  const other = result.providers.find((group) => group.key === "other");
  assert.equal(other.error, 1);
  assert.equal(other.aborted, 1);
  assert.equal(other.timedMs, 5000, "the aborted row reports its own duration");
  assert.equal(result.providerCount, result.providers.length);

  // The same model from two sources stays two rows: a roll-up that merged them
  // could not be priced per source.
  const m1 = result.models.filter((group) => group.model === "m1");
  assert.equal(m1.length, 1);
  assert.equal(m1[0].source, "cli");
  assert.equal(m1[0].requests, 2);

  const m2 = result.models.filter((group) => group.model === "m2");
  assert.equal(m2.length, 1, "one source ran m2 in this window");
  assert.equal(m2[0].provider, "other");
});

test("the log honours the source filter and reports the record's own numbers", () => {
  const desktop = makeRecord(at(0, 7), {
    entryId: "desk",
    source: "desktop",
    model: "m1",
    provider: "Liubai",
    durationMs: 1500,
    status: "complete",
  });
  const both = [...records, desktop];

  const onlyDesktop = queryLog(both, { range: "7d", nowMs: NOW, sources: ["desktop"], pageSize: 20 });
  assert.equal(onlyDesktop.total, 1);
  assert.equal(onlyDesktop.rows[0].model, "m1");
  assert.equal(onlyDesktop.rows[0].provider, "Liubai");
  assert.equal(onlyDesktop.rows[0].durationMs, 1500);
  assert.equal(onlyDesktop.rows[0].cost, 0.001);
  assert.equal(onlyDesktop.rows[0].status, "complete");

  const cliOnly = queryLog(both, { range: "7d", nowMs: NOW, sources: ["cli"], pageSize: 20 });
  assert.equal(cliOnly.total, 4);
  assert.ok(cliOnly.rows.every((row) => row.source === "cli"));

  const all = queryLog(both, { range: "7d", nowMs: NOW, pageSize: 20 });
  const sameModel = all.models.filter((group) => group.model === "m1");
  assert.equal(sameModel.length, 2, "the same model under two sources is two roll-up rows");
});

test("the code filter matches the HTTP status the host recorded", () => {
  const coded = [
    makeRecord(at(0, 11), { entryId: "ok", status: "complete" }),
    makeRecord(at(0, 10), { entryId: "rate", status: "error", statusCode: 429, errorCode: "PROVIDER_RATE_LIMITED" }),
    makeRecord(at(0, 9), { entryId: "big", status: "error", statusCode: 413, errorCode: "CONTEXT_TOO_LARGE" }),
    makeRecord(at(0, 8), { entryId: "offline", status: "error" }),
  ];

  const all = queryLog(coded, { range: "today", nowMs: NOW, pageSize: 20 });
  assert.deepEqual(
    all.codes,
    [
      { code: 200, count: 1 },
      { code: 413, count: 1 },
      { code: 429, count: 1 },
    ],
    "a finished turn is a 200; a connection failure has no code at all",
  );
  const rate = all.rows.find((row) => row.id.endsWith("rate"));
  assert.equal(rate.statusCode, 429);
  assert.equal(rate.errorCode, "PROVIDER_RATE_LIMITED");
  assert.equal(all.rows.find((row) => row.id.endsWith("offline")).statusCode, null);

  const limited = queryLog(coded, { range: "today", nowMs: NOW, code: 429, pageSize: 20 });
  assert.equal(limited.total, 1);
  assert.equal(limited.rows[0].statusCode, 429);
  assert.deepEqual(limited.codes, all.codes, "the menu still counts every code");

  assert.equal(queryLog(coded, { range: "today", nowMs: NOW, code: 404, pageSize: 20 }).total, 0);
});

test("the log window is the same one the cards use", () => {
  const fromMs = at(1, 0);
  const toMs = at(0, 23);
  const custom = queryLog(records, { range: "custom", fromMs, toMs, nowMs: NOW, pageSize: 20 });
  assert.equal(custom.fromMs, fromMs);
  assert.equal(custom.toMs, toMs);
  assert.deepEqual(
    custom.rows.map((row) => row.id.split(":").pop()),
    ["newest", "second", "third"],
    "the two-day window stops before the aborted row",
  );
});
