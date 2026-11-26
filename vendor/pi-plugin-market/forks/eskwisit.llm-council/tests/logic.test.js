"use strict";

// Pure logic: ranking parser, per-seat aggregate, prompts, titles, globs, casting, shuffling, run paths.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { loadMain, sandbox, fakePi } = require("./helpers.js");

const t = loadMain(fakePi(sandbox())).__t;
const labels = (...ls) => Object.fromEntries(ls.map((l) => [l, {}]));

describe("parseRanking", () => {
  it("reads a numbered ranking after the header", () => {
    assert.deepEqual(t.parseRanking("x\nFINAL RANKING:\n1. Response C\n2. Response A"), ["Response C", "Response A"]);
  });
  it("falls back to any label when the ranking is not numbered", () => {
    assert.deepEqual(t.parseRanking("FINAL RANKING: Response B > Response A"), ["Response B", "Response A"]);
    assert.deepEqual(t.parseRanking("I like Response A over Response B"), ["Response A", "Response B"]);
  });
  it("reads from the last header, so an earlier mention does not break it", () => {
    const text = "quoting `FINAL RANKING:` here, Response B...\nFINAL RANKING:\n1. Response C\n2. Response A\n3. Response B";
    assert.deepEqual(t.parseRanking(text), ["Response C", "Response A", "Response B"]);
  });
  it("ignores case, drops duplicates and labels outside the valid set", () => {
    assert.deepEqual(t.parseRanking("Final ranking\n1. **Response B**\n2. Response B\n3. Response Z", labels("Response A", "Response B")), ["Response B"]);
  });
  it("needs word boundaries", () => {
    assert.deepEqual(t.parseRanking("Response Analysis is weak; FINAL RANKING:\n1. Response A"), ["Response A"]);
  });
});

describe("aggregateRankings", () => {
  it("scores per seat, so two seats on the same model stay apart", () => {
    const lm = {
      "Response A": { seat: "contrarian", advisor: "x", model: "m" },
      "Response B": { seat: "first-principles", advisor: "y", model: "m" },
    };
    const agg = t.aggregateRankings([
      { ranking: "FINAL RANKING:\n1. Response B\n2. Response A" },
      { ranking: "FINAL RANKING:\n1. Response A\n2. Response B" },
      { ranking: "FINAL RANKING:\n1. Response B\n2. Response A" },
    ], lm);
    assert.deepEqual(agg.map((a) => [a.seat, a.average_rank, a.rankings_count]), [["first-principles", 1.33, 3], ["contrarian", 1.67, 3]]);
  });
});

describe("prompts", () => {
  it("the review prompt shows every response and demands the strict ranking format", () => {
    const p = t.buildReviewPrompt("Q?", [["Response A", "alpha"], ["Response B", "beta"]]);
    assert.match(p, /### Response A\n\nalpha/);
    assert.match(p, /### Response B\n\nbeta/);
    assert.match(p, /FINAL RANKING:\n1\. Response C\n2\. Response A\n3\. Response B\n\nWrite nothing after the ranking\.$/);
    assert.match(p, /Strongest:.*\n.*Biggest blind spot:.*\n.*All missed:/);
  });
  it("uses our own wording, not the upstream templates", () => {
    const p = t.buildReviewPrompt("Q?", [["Response A", "a"]]);
    const c = t.buildChairmanPrompt("Q?", [], [], []);
    for (const upstream of [
      "Each line should be: number, period, space, then ONLY the response label",
      "You are evaluating different responses to the following question",
      "Your task as Chairman is to synthesize all of this information",
      "represents the council's collective wisdom",
    ]) {
      assert.ok(!p.includes(upstream) && !c.includes(upstream), upstream);
    }
  });
  it("the chairman prompt reveals advisors and models, and asks for the five sections", () => {
    const c = t.buildChairmanPrompt("Q?", [{ label: "Response A", advisor: "The Contrarian", model: "m1", response: "r" }],
      [{ advisor: "The Executor", model: "m2", ranking: "FINAL RANKING:\n1. Response A" }],
      [{ label: "Response A", advisor: "The Contrarian", average_rank: 1, rankings_count: 1 }]);
    assert.match(c, /### Response A: The Contrarian \(model: m1\)/);
    assert.match(c, /### Review by The Executor \(model: m2\)/);
    assert.match(c, /1\. Response A, The Contrarian: average rank 1 \(1 votes\)/);
    for (const h of ["Where the Council Agrees", "Where the Council Clashes", "Blind Spots the Council Caught", "The Recommendation", "The One Thing to Do First"]) {
      assert.ok(c.includes(`## ${h}`), h);
    }
  });
  it("cleans titles", () => {
    assert.equal(t.cleanTitle(`"${"x".repeat(60)}"`), `${"x".repeat(47)}...`);
    assert.equal(t.cleanTitle("  Align Pi With JS \n"), "Align Pi With JS");
    assert.equal(t.cleanTitle(""), "LLM Council");
    assert.equal(t.cleanTitle(null), "LLM Council");
  });
});

describe("globMatch", () => {
  it("matches shell-style patterns case-insensitively on the whole id", () => {
    assert.ok(t.globMatch("google/*", "google/gemini-x"));
    assert.ok(t.globMatch("GOOGLE/*", "google/gemini-x"));
    assert.ok(!t.globMatch("google/*", "xgoogle/gemini"));
    assert.ok(t.globMatch("*/claude-?aiku-*", "anthropic/claude-haiku-5"));
    assert.ok(t.globMatch("x/[ab]-1", "x/b-1") && !t.globMatch("x/[!ab]-1", "x/b-1"));
    assert.ok(t.globMatch("a.b/c+d", "a.b/c+d") && !t.globMatch("a.b/c", "aXb/c"));
  });
});

const CATALOG = ["anthropic/big-1", "anthropic/mid-1", "work/big-1", "xai/grok-x", "google/free-1", "openrouter/fast-1"];
const GOOD = {
  contrarian: ["anthropic/big-1", "anthropic/mid-1"],
  "first-principles": ["anthropic/big-1", "xai/grok-x"],
  expansionist: ["xai/grok-x", "anthropic/mid-1"],
  outsider: ["xai/grok-x", "anthropic/mid-1"],
  executor: ["anthropic/mid-1", "anthropic/big-1"],
  chairman: ["anthropic/big-1", "anthropic/mid-1"],
};

describe("buildCast", () => {
  it("inserts the same model through another account right after it", () => {
    const { cast, warnings } = t.buildCast(GOOD, CATALOG, ["google/*"]);
    assert.deepEqual(cast.contrarian, ["anthropic/big-1", "work/big-1", "anthropic/mid-1"]);
    assert.deepEqual(warnings, []);
  });
  it("rejects excluded, unknown and missing seats, listing every problem", () => {
    assert.throws(() => t.buildCast({ ...GOOD, outsider: ["google/free-1"] }, CATALOG, ["google/*"]), /outsider: google\/free-1 is excluded/);
    assert.throws(() => t.buildCast({ ...GOOD, chairman: ["nope/x"] }, CATALOG, []), /chairman: nope\/x is not in the delegation catalog/);
    const { chairman, ...noChairman } = GOOD;
    assert.throws(() => t.buildCast(noChairman, CATALOG, []), /chairman: no model given/);
    assert.throws(() => t.buildCast({ ...GOOD, judge: ["xai/grok-x"] }, CATALOG, []), /unknown seat/);
  });
  it("warns about a single model family and a missing fallback", () => {
    const mono = Object.fromEntries(Object.keys(GOOD).map((s) => [s, ["anthropic/mid-1"]]));
    const { warnings } = t.buildCast(mono, CATALOG, ["google/*"]);
    assert.ok(warnings.some((w) => /one model family \(mid\)/.test(w)), warnings.join("\n"));
    assert.ok(warnings.includes("contrarian has no fallback model"));
    assert.ok(warnings.includes("chairman has no fallback model"));
  });
  it("accepts inherit when there is no catalog", () => {
    const all = Object.fromEntries(Object.keys(GOOD).map((s) => [s, ["inherit"]]));
    assert.deepEqual(t.buildCast(all, [], []).cast.chairman, ["inherit"]);
  });
});

describe("staleSeats", () => {
  it("flags seats whose primary model left the catalog or got excluded", () => {
    const { cast } = t.buildCast(GOOD, CATALOG, []);
    assert.deepEqual(t.staleSeats(cast, CATALOG, []), []);
    assert.deepEqual(t.staleSeats(cast, CATALOG.filter((m) => m !== "xai/grok-x"), []), ["expansionist", "outsider"]);
    assert.deepEqual(t.staleSeats(cast, CATALOG, ["anthropic/big*"]), ["contrarian", "first-principles", "chairman"]);
    assert.equal(t.staleSeats({}, CATALOG, []).length, 6);
  });
});

describe("shuffle and run paths", () => {
  it("a seeded shuffle is repeatable and keeps every item", () => {
    const items = ["a", "b", "c", "d", "e"];
    assert.deepEqual(t.shuffle(items, 7), t.shuffle(items, 7));
    assert.deepEqual(t.shuffle(items).slice().sort(), items);
    assert.deepEqual(items, ["a", "b", "c", "d", "e"]);
  });
  it("accepts run directories under .llm-council/runs only", () => {
    assert.equal(t.runPath(".llm-council/runs/20260101-120000/"), ".llm-council/runs/20260101-120000");
    assert.equal(t.runPath("./.llm-council/runs/x1"), ".llm-council/runs/x1");
    assert.equal(t.runPath("20260101-120000"), ".llm-council/runs/20260101-120000");
    for (const bad of ["", "../x", ".llm-council/runs/../../etc", "/abs/.llm-council/runs/x", "src/x", ".llm-council/runs/a/b"]) {
      assert.throws(() => t.runPath(bad), /run must be/, bad);
    }
  });
});
