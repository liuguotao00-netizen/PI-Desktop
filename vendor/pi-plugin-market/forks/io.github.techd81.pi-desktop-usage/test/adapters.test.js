"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const cli = require("../src/adapters/cli.js");
const desktop = require("../src/adapters/desktop.js");
const { readFixture } = require("./helpers.js");

const CLI_SESSION = "--D--demo--/2026-10-01T10-00-00-000Z_11111111-1111-4111-8111-111111111111.jsonl";
const DESKTOP_SESSION = "22222222-2222-4222-8222-222222222222.jsonl";

/**
 * @param {string} text
 * @returns {string[]}
 */
function lines(text) {
  return text.split("\n").filter((line) => line.trim() !== "");
}

test("cli adapter: header carries the session id and the project cwd", async () => {
  const [headerLine] = lines(await readFixture(`cli/sessions/${CLI_SESSION}`));
  const header = cli.parseHeader(cli.safeParse(headerLine));
  assert.ok(header);
  assert.equal(header.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(header.projectPath, "D:\\demo");
});

test("cli adapter: assistant messages, summary usage and a broken line", async () => {
  const all = lines(await readFixture(`cli/sessions/${CLI_SESSION}`));
  const header = cli.parseHeader(cli.safeParse(all[0]));
  const ctx = { sessionId: header.sessionId, projectPath: header.projectPath, fallbackTimestampMs: 1 };

  const parsed = all.slice(1).map((line) => cli.safeParse(line));
  assert.equal(parsed.filter((value) => value === null).length, 1, "one line is deliberately unreadable");

  const records = parsed.flatMap((value) => (value === null ? [] : cli.parseEntry(value, ctx)));
  assert.equal(records.length, 4);

  const first = records.find((record) => record.entryId === "resp-1");
  assert.ok(first);
  assert.equal(first.id, "cli:11111111-1111-4111-8111-111111111111:resp-1");
  assert.equal(first.inputTokens, 100);
  assert.equal(first.outputTokens, 20);
  assert.equal(first.cacheReadTokens, 5);
  assert.equal(first.totalTokens, 125);
  assert.equal(first.costUsd, 0.00121);
  assert.equal(first.costStatus, "recorded");
  assert.equal(first.projectPath, "D:\\demo");
  assert.equal(first.kind, "assistant");
  assert.equal(first.timestampMs, 1790848806000);

  const noCost = records.find((record) => record.entryId === "a3");
  assert.ok(noCost);
  assert.equal(noCost.totalTokens, 60);
  assert.equal(noCost.costUsd, null);
  assert.equal(noCost.costStatus, "unknown");

  const summary = records.find((record) => record.entryId === "c1");
  assert.ok(summary);
  assert.equal(summary.kind, "summary");
  assert.equal(summary.totalTokens, 35);
  assert.equal(summary.costUsd, 0);
});

test("cli adapter ignores user messages and payloads without usage", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  assert.deepEqual(cli.parseEntry({ type: "message", message: { role: "user" } }, ctx), []);
  assert.deepEqual(cli.parseEntry({ type: "message", message: { role: "assistant" } }, ctx), []);
  assert.deepEqual(cli.parseEntry({ type: "other" }, ctx), []);
});

test("desktop adapter: operation usage, aggregate expansion and compaction", async () => {
  const all = lines(await readFixture(`desktop/sessions/${DESKTOP_SESSION}`));
  const header = desktop.parseHeader(desktop.safeParse(all[0]));
  assert.ok(header);
  assert.equal(header.sessionId, "22222222-2222-4222-8222-222222222222");
  assert.equal(header.projectPath, null);

  const ctx = { sessionId: header.sessionId, projectPath: null, fallbackTimestampMs: 1 };
  const records = all
    .slice(1)
    .map((line) => desktop.safeParse(line))
    .filter((value) => value !== null)
    .flatMap((value) => desktop.parseEntry(value, ctx));

  assert.equal(records.length, 3, "the aborted message carries no usage");

  const message = records.find((record) => record.entryId === "d2");
  assert.ok(message);
  assert.equal(message.totalTokens, 11197);
  assert.equal(message.costUsd, 0.0016012);
  assert.equal(message.costStatus, "estimated");
  assert.equal(message.providerKey, "prov-1");
  assert.equal(message.model, "deepseek-v4.1-flash");
  assert.equal(message.kind, "assistant");

  const expanded = records.find((record) => record.entryId === "d3#op-2");
  assert.ok(expanded, "aggregate usage is counted through its operations");
  assert.equal(expanded.totalTokens, 110);
  assert.equal(expanded.costUsd, 0.0002);

  const summary = records.find((record) => record.entryId === "d5");
  assert.ok(summary);
  assert.equal(summary.kind, "summary");
  assert.equal(summary.totalTokens, 540);
  assert.equal(summary.costUsd, 0.011);
});

test("desktop adapter skips a bare aggregate without operations", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  const entry = {
    type: "message",
    id: "x",
    role: "assistant",
    createdAt: "2026-10-02T08:00:00.000Z",
    meta: { usage: { aggregation: "aggregate", inputTokens: 900, outputTokens: 99, totalTokens: 999 } },
  };
  assert.deepEqual(desktop.parseEntry(entry, ctx), []);
});

test("desktop adapter accepts the lowerCamel token field spelling", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  const entry = {
    type: "message",
    id: "y",
    role: "assistant",
    createdAt: "2026-10-02T08:00:00.000Z",
    meta: { usage: { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, cost: { total: 0.5 }, costStatus: "reported" } },
  };
  const [record] = desktop.parseEntry(entry, ctx);
  assert.equal(record.totalTokens, 26);
  assert.equal(record.costStatus, "recorded");
});

test("desktop adapter falls back to the message provider and model for bare operations", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  const entry = {
    type: "message",
    id: "z",
    role: "assistant",
    createdAt: "2026-10-02T08:00:00.000Z",
    meta: {
      providerId: "prov-9",
      modelId: "model-9",
      usage: {
        aggregation: "aggregate",
        operations: [
          { operationId: "o1", inputTokens: 10, outputTokens: 5, totalTokens: 15, cost: { total: 0.001 } },
        ],
      },
    },
  };
  const records = desktop.parseEntry(entry, ctx);

  assert.equal(records.length, 1);
  assert.equal(records[0].providerKey, "prov-9", "the operation inherits the message provider");
  assert.equal(records[0].model, "model-9");
});

test("a trimmed aggregate still counts the tokens its operations omit", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  const entry = {
    type: "message",
    id: "agg",
    role: "assistant",
    createdAt: "2026-10-02T08:00:00.000Z",
    meta: {
      usage: {
        aggregation: "aggregate",
        inputTokens: 900,
        outputTokens: 99,
        totalTokens: 999,
        cost: { total: 9.99 },
        operations: [
          {
            operationId: "op-1",
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            cost: { total: 0.0002 },
          },
        ],
      },
    },
  };
  const records = desktop.parseEntry(entry, ctx);
  assert.equal(records.length, 2, "the missing part is added back, not dropped");

  const remainder = records.find((record) => record.entryId === "agg#remainder");
  assert.ok(remainder);
  assert.equal(remainder.inputTokens, 800);
  assert.equal(remainder.outputTokens, 89);
  assert.equal(remainder.totalTokens, 889);
  assert.ok(Math.abs(remainder.costUsd - 9.9898) < 1e-9);

  const totalTokens = records.reduce((sum, record) => sum + record.totalTokens, 0);
  const totalCost = records.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
  assert.equal(totalTokens, 999, "the aggregate total is authoritative");
  assert.ok(Math.abs(totalCost - 9.99) < 1e-9);
});

test("an aggregate whose operations already add up adds no extra record", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  const entry = {
    type: "message",
    id: "agg",
    role: "assistant",
    createdAt: "2026-10-02T08:00:00.000Z",
    meta: {
      usage: {
        aggregation: "aggregate",
        inputTokens: 100,
        outputTokens: 10,
        totalTokens: 110,
        cost: { total: 0.0002 },
        operations: [
          {
            operationId: "op-1",
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            cost: { total: 0.0002 },
          },
        ],
      },
    },
  };
  const records = desktop.parseEntry(entry, ctx);
  assert.equal(records.length, 1);
  assert.equal(records[0].entryId, "agg#op-1");
});

test("an aggregate that only reports its total still counts the whole total", () => {
  const ctx = { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 };
  const entry = {
    type: "message",
    id: "agg2",
    role: "assistant",
    createdAt: "2026-10-02T08:00:00.000Z",
    meta: {
      usage: {
        aggregation: "aggregate",
        totalTokens: 1000,
        operations: [
          {
            operationId: "op-1",
            inputTokens: 100,
            outputTokens: 0,
            totalTokens: 100,
            cost: { total: 0.001 },
          },
        ],
      },
    },
  };
  const records = desktop.parseEntry(entry, ctx);
  const remainder = records.find((record) => record.entryId === "agg2#remainder");
  assert.ok(remainder);
  // No per-field split was reported, so the whole gap has to land somewhere.
  assert.equal(remainder.inputTokens, 900);
  assert.equal(remainder.totalTokens, 900);
  assert.equal(records.reduce((sum, record) => sum + record.totalTokens, 0), 1000);
  assert.equal(remainder.requestCount, 0, "the remainder is part of the same request");
  const requests = records.reduce((sum, record) => sum + record.requestCount, 0);
  assert.equal(requests, 1, "one message is still one request");
});

test("a cli compaction row borrows the model its session was running", () => {
  const entry = {
    type: "compaction",
    id: "c9",
    timestamp: "2026-10-02T08:00:00.000Z",
    usage: { input: 2000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.03 } },
  };
  const unknown = cli.parseEntry(entry, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].model, "", "nothing to name the model with before any message");

  const known = cli.parseEntry(entry, {
    sessionId: "s",
    projectPath: null,
    fallbackTimestampMs: 1,
    lastModel: "deepseek-v4-flash-0731",
    lastProvider: "token-rhythm",
  });
  assert.equal(known[0].model, "deepseek-v4-flash-0731");
  assert.equal(known[0].provider, "token-rhythm");
  assert.equal(known[0].kind, "summary");
  assert.equal(known[0].totalTokens, 2100, "the attribution never changes the tokens");
  assert.equal(known[0].costUsd, 0.03);
});

test("a desktop compaction row keeps the model its entry records", () => {
  const entry = {
    type: "compaction",
    id: "d9",
    createdAt: "2026-10-02T08:00:00.000Z",
    providerId: "prov-7",
    modelId: "deepseek-v4.1-flash",
    usage: {
      input: 3000,
      output: 300,
      totalTokens: 3300,
      cost: { total: 0.004 },
      desktopUsage: {
        aggregation: "operation",
        operationId: "op-9",
        providerId: "prov-7",
        modelId: "deepseek-v4.1-flash",
        inputTokens: 3000,
        outputTokens: 300,
        totalTokens: 3300,
      },
    },
  };
  const records = desktop.parseEntry(entry, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(records.length, 1, "the totals stay aggregate-silent, not double counted");
  assert.equal(records[0].model, "deepseek-v4.1-flash");
  assert.equal(records[0].providerKey, "prov-7");
  assert.equal(records[0].totalTokens, 3300);
  assert.equal(records[0].kind, "summary");

  // The entry-level ids are the fallback when only the nested operation names them.
  const bare = desktop.parseEntry(
    { ...entry, providerId: undefined, modelId: undefined },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(bare[0].model, "deepseek-v4.1-flash", "the operation carries the model too");
});

test("desktop adapter: the turn's duration and ending reach the record", () => {
  const entry = {
    type: "message",
    role: "assistant",
    id: "turn-1",
    createdAt: "2026-11-17T06:15:01.000Z",
    meta: {
      modelId: "deepseek-v4.1-flash",
      providerId: "prov-1",
      responseDurationMs: 2175,
      status: "complete",
      usage: {
        inputTokens: 228,
        outputTokens: 526,
        cacheReadTokens: 31400,
        cost: { total: 0.0009 },
      },
    },
  };
  const [record] = desktop.parseEntry(entry, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(record.durationMs, 2175);
  assert.equal(record.status, "complete");
  assert.equal(record.statusCode, 200, "a finished turn is the 200 path");

  const rejected = desktop.parseEntry(
    {
      ...entry,
      meta: {
        ...entry.meta,
        status: "error",
        error: { code: "CONTEXT_TOO_LARGE", details: { providerStatus: 413, phase: "stream" } },
      },
    },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(rejected[0].statusCode, 413, "the provider's own status is kept");
  assert.equal(rejected[0].errorCode, "CONTEXT_TOO_LARGE");

  const failed = desktop.parseEntry(
    { ...entry, isError: true, meta: { ...entry.meta, status: "error" } },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(failed[0].status, "error");

  // A row without a duration is not timed; the log then shows no speed.
  const untimed = desktop.parseEntry(
    { ...entry, meta: { ...entry.meta, responseDurationMs: undefined } },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(untimed[0].durationMs, null);
});

test("desktop adapter: one operation inherits the turn timing, several do not", () => {
  const base = {
    type: "message",
    role: "assistant",
    id: "turn-2",
    createdAt: "2026-11-17T06:15:01.000Z",
    meta: {
      modelId: "m",
      providerId: "p",
      responseDurationMs: 4000,
      status: "complete",
      usage: {
        aggregation: "aggregate",
        totalTokens: 300,
        inputTokens: 300,
        cost: { total: 0.002 },
        operations: [{ operationId: "op-1", inputTokens: 100 }, { operationId: "op-2", inputTokens: 100 }],
      },
    },
  };
  const twoOps = desktop.parseEntry(base, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(twoOps.length, 3, "two operations plus the remainder row");
  assert.ok(
    twoOps.every((record) => record.durationMs === null),
    "splitting one duration over two operations would overstate both speeds",
  );

  const oneOp = desktop.parseEntry(
    {
      ...base,
      meta: {
        ...base.meta,
        usage: { ...base.meta.usage, operations: [{ operationId: "op-1", inputTokens: 300 }], totalTokens: 300 },
      },
    },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(oneOp[0].durationMs, 4000, "the single operation is the turn");
  assert.equal(oneOp[0].status, "complete");
});

test("desktop adapter: a user line is the clock a turn's first call measures against", () => {
  const at = "2026-11-17T06:15:00.000Z";
  assert.equal(desktop.turnClock({ type: "message", role: "user", createdAt: at }), Date.parse(at));
  assert.equal(desktop.turnClock({ type: "message", role: "assistant", createdAt: at }), null);
  assert.equal(desktop.turnClock({ type: "session", sessionId: "s" }), null);
  assert.equal(desktop.turnClock(null), null);
});

test("desktop adapter: a tool result is also a clock for the call it triggers", () => {
  const at = "2026-11-17T06:15:10.000Z";
  assert.equal(desktop.turnClock({ type: "message", role: "tool", createdAt: at }), Date.parse(at));
  assert.equal(
    desktop.turnClock({ type: "message", role: "assistant", createdAt: at }),
    null,
    "an assistant message is not a request boundary",
  );
});

test("cli adapter: a missing durationMs falls back to written minus dispatched", () => {
  const entry = {
    type: "message",
    id: "entry-2",
    timestamp: "2026-11-17T06:15:24.000Z",
    message: {
      role: "assistant",
      provider: "pi",
      model: "m",
      usage: { input: 10, output: 500, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      stopReason: "stop",
      timestamp: Date.parse("2026-11-17T06:15:00.000Z"),
    },
  };
  const [record] = cli.parseEntry(entry, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(record.durationMs, 24000, "24 s between dispatch and write");

  const written = { ...entry, message: { ...entry.message, durationMs: 23500 } };
  const [timed] = cli.parseEntry(written, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(timed.durationMs, 23500, "the host's own number wins when it exists");
});

test("cli adapter: durationMs and stopReason become duration and status", () => {
  const entry = {
    type: "message",
    id: "entry-1",
    timestamp: "2026-11-17T06:15:01.000Z",
    message: {
      role: "assistant",
      provider: "pi",
      model: "m",
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
      stopReason: "toolUse",
      timestamp: Date.parse("2026-11-17T06:15:01.000Z"),
      durationMs: 1234,
    },
  };
  const [record] = cli.parseEntry(entry, { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 });
  assert.equal(record.durationMs, 1234);
  assert.equal(record.status, "complete", "a tool call still finished");
  assert.equal(record.statusCode, 200, "a finished turn is the 200 path");

  const blocked = cli.parseEntry(
    {
      ...entry,
      message: { ...entry.message, stopReason: "error", errorMessage: '500: {"message":"blocked"}' },
    },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(blocked[0].statusCode, 500, "the text prefix is the HTTP status");
  assert.equal(blocked[0].status, "error");

  const plain = cli.parseEntry(
    {
      ...entry,
      message: { ...entry.message, stopReason: "error", errorMessage: "aborted by user" },
    },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(plain[0].statusCode, null, "a message without a leading code has no status");

  const aborted = cli.parseEntry(
    { ...entry, message: { ...entry.message, stopReason: "aborted" } },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(aborted[0].status, "aborted");

  const failed = cli.parseEntry(
    { ...entry, message: { ...entry.message, stopReason: "error" } },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(failed[0].status, "error");

  const unknown = cli.parseEntry(
    { ...entry, message: { ...entry.message, stopReason: undefined, durationMs: undefined } },
    { sessionId: "s", projectPath: null, fallbackTimestampMs: 1 },
  );
  assert.equal(unknown[0].status, "unknown", "an unrecorded ending is not a success");
  assert.equal(unknown[0].durationMs, null);
});
