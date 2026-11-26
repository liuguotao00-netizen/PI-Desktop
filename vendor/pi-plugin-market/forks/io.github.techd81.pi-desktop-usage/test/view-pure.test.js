"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const panel = require("../views/app.js");

test("shares are clamped and safe against a zero denominator", () => {
  assert.equal(panel.shareOf(50, 100), 0.5);
  assert.equal(panel.shareOf(150, 100), 1);
  assert.equal(panel.shareOf(-5, 100), 0);
  assert.equal(panel.shareOf(5, 0), 0);
  assert.equal(panel.shareOf(Number.NaN, 100), 0);
});

test("line and area paths use the full plot box", () => {
  assert.equal(panel.linePath([], 100, 50, 10), "");
  assert.equal(panel.linePath([10, 0], 100, 50, 10), "M0.00,0.00 L100.00,50.00");
  assert.equal(panel.linePath([5], 100, 50, 10), "M50.00,25.00");
  assert.match(panel.areaPath([10, 5], 100, 50, 10), /^M0\.00,0\.00 L100\.00,25\.00 L100\.00,50\.00 L0,50\.00 Z$/);
});

test("pointer mapping picks the nearest bucket and clamps at the edges", () => {
  assert.equal(panel.indexAt(-20, 200, 5), 0);
  assert.equal(panel.indexAt(0, 200, 5), 0);
  assert.equal(panel.indexAt(100, 200, 5), 2);
  assert.equal(panel.indexAt(200, 200, 5), 4);
  assert.equal(panel.indexAt(500, 200, 5), 4);
  assert.equal(panel.indexAt(50, 0, 5), 0);
});

test("donut segments tile the whole circumference", () => {
  const circumference = 2 * Math.PI * 70;
  const segments = panel.donutGeometry([1, 1, 2], circumference);
  assert.equal(segments.length, 3);
  assert.ok(Math.abs(segments.reduce((sum, segment) => sum + segment.length, 0) - circumference) < 1e-6);
  assert.equal(segments[0].fraction, 0.25);
  assert.equal(segments[1].dashoffset.toFixed(3), (-segments[0].length).toFixed(3));
  assert.match(segments[2].dasharray, /^\d+\.\d{3} \d+\.\d{3}$/);

  const empty = panel.donutGeometry([0, 0], 100);
  assert.equal(empty[0].fraction, 0);
  assert.equal(empty[0].length, 0);
});

test("heat levels spread values over five steps", () => {
  assert.deepEqual(panel.heatLevels([0, 0, 0]), [0, 0, 0]);
  // Quartiles of the five active days, not fractions of the biggest one.
  assert.deepEqual(panel.heatLevels([10, 40, 60, 80, 100]), [1, 1, 2, 3, 4]);
  assert.deepEqual(panel.heatLevels([7, 7, 7]), [4, 4, 4], "nothing to rank, one real tone");
});

test("one runaway day does not flatten the rest of the year", () => {
  // 39 ordinary days and one that is ~800x the median, the case a real user hit.
  const values = Array.from({ length: 40 }, (_unused, index) => 1_000_000 + index * 10_000);
  values[7] = 828_000_000;
  const levels = panel.heatLevels(values);
  const counts = [0, 0, 0, 0, 0];
  for (const level of levels) counts[level] += 1;

  assert.equal(levels[7], 4, "the spike keeps the darkest step");
  assert.deepEqual(counts, [0, 10, 10, 10, 10], "the ordinary days still fill every step");
});

test("heat levels ignore blanks and junk", () => {
  const levels = panel.heatLevels([0, Number.NaN, -5, 3, 9]);
  assert.deepEqual(levels.slice(0, 3), [0, 0, 0]);
  assert.deepEqual(levels.slice(3), [1, 4], "two active days rank end to end");
});

test("axis ticks stay inside the series", () => {
  assert.deepEqual(panel.tickIndices(0, 8), []);
  assert.deepEqual(panel.tickIndices(3, 8), [0, 1, 2]);
  const ticks = panel.tickIndices(31, 8);
  assert.equal(ticks.length, 8);
  assert.equal(ticks[0], 0);
  assert.equal(ticks[ticks.length - 1], 30);
  assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
});

test("escaping neutralises markup in user controlled strings", () => {
  assert.equal(panel.esc('<img src=x onerror="1">'), "&lt;img src=x onerror=&quot;1&quot;&gt;");
  assert.equal(panel.esc("a&b"), "a&amp;b");
  assert.equal(panel.esc(null), "");
});

test("translations fall back to Chinese and interpolate variables", () => {
  assert.equal(panel.t("zh", "metricCost"), "总成本");
  assert.equal(panel.t("en", "metricCost"), "Total cost");
  assert.equal(panel.t("xx", "metricCost"), "总成本");
  assert.equal(panel.t("en", "missing-key"), "missing-key");
  assert.equal(panel.t("zh", "trendTitle", { range: "7D" }), "7D 趋势");
  assert.equal(panel.t("en", "trendTitle", { range: "7D" }), "7D trend");
  assert.equal(panel.t("zh", "trendTitle", { unused: 1 }), "{range} 趋势");
});

test("bar layout keeps every bar inside its slot", () => {
  assert.deepEqual(panel.barLayout(0, 300), { slot: 0, width: 0 });
  const wide = panel.barLayout(3, 300);
  assert.equal(wide.slot, 100);
  assert.equal(wide.width, 26);
  const tight = panel.barLayout(30, 300);
  assert.ok(tight.width >= 2 && tight.width < 10);
});

test("month headers land on the week column that starts the month", () => {
  const days = Array.from({ length: 40 }, (_, index) => ({
    dateMs: new Date(2026, 0, 1 + index).getTime(),
    tokens: index,
  }));
  const { leading, starts } = panel.monthStarts(days);
  assert.equal(leading, 4, "2026-01-01 is a Thursday");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].week, 0);
  assert.equal(starts[1].week, Math.floor((4 + 31) / 7));
  assert.deepEqual(panel.monthStarts([]), { leading: 0, starts: [] });
});

test("asset URLs are derived from the panel script location", () => {
  assert.equal(panel.assetBaseFrom("file:///D:/p/views/app.js"), "file:///D:/p/views/assets/");
  assert.equal(panel.assetBaseFrom("https://host/plugins/x/views/app.js"), "https://host/plugins/x/views/assets/");
  assert.equal(panel.assetBaseFrom("./app.js"), "./assets/");
  assert.equal(panel.assetBaseFrom("app.js"), "./assets/");
  assert.equal(panel.assetBaseFrom(""), "./assets/");
});

test("local date inputs round-trip through datetime-local text", () => {
  const midnight = new Date(2026, 9, 22, 0, 0).getTime();
  assert.equal(panel.toLocalInput(midnight), "2026-10-22T00:00");
  assert.equal(panel.toLocalInput(new Date(2026, 0, 5, 7, 9).getTime()), "2026-01-05T07:09");
  assert.equal(panel.fromLocalInput("2026-10-22T17:45"), new Date(2026, 9, 22, 17, 45).getTime());
  assert.equal(panel.fromLocalInput(panel.toLocalInput(midnight)), midnight);
  assert.equal(panel.fromLocalInput("2026-10-22"), Number.NaN);
  assert.equal(panel.fromLocalInput(""), Number.NaN);
});

test("day helpers stay on local midnight", () => {
  const afternoon = new Date(2026, 9, 22, 17, 45, 30, 400).getTime();
  assert.equal(panel.startOfLocalDay(afternoon), new Date(2026, 9, 22).getTime());
  assert.equal(panel.endOfLocalDay(afternoon), new Date(2026, 9, 22, 23, 59, 59, 999).getTime());
  assert.equal(panel.shiftDays(panel.startOfLocalDay(afternoon), -6), new Date(2026, 9, 16).getTime());
  assert.equal(panel.shiftDays(new Date(2026, 0, 31).getTime(), 1), new Date(2026, 1, 1).getTime());
  assert.equal(
    panel.combineDayWithTime(new Date(2026, 9, 1).getTime(), new Date(2026, 9, 22, 17, 45).getTime()),
    new Date(2026, 9, 1, 17, 45).getTime(),
  );
});

test("the calendar grid covers six aligned week rows", () => {
  const cells = panel.monthGrid(new Date(2026, 9, 15).getTime());
  assert.equal(cells.length, 42);
  assert.equal(new Date(cells[0].dateMs).getDay(), 0, "the grid starts on a Sunday");
  assert.equal(new Date(cells[6].dateMs).getDay(), 6, "and every row ends on a Saturday");
  assert.equal(cells[0].dateMs, new Date(2026, 8, 27).getTime(), "2026-10-01 is a Thursday");
  assert.equal(cells[0].inMonth, false);
  assert.equal(cells[4].dateMs, new Date(2026, 9, 1).getTime());
  assert.equal(cells[4].inMonth, true);
  assert.equal(cells.filter((cell) => cell.inMonth).length, 31);
  cells.forEach((cell) => assert.equal(new Date(cell.dateMs).getHours(), 0));
});

test("picker presets resolve to explicit windows", () => {
  const now = new Date(2026, 9, 22, 17, 45).getTime();
  assert.deepEqual(panel.presetWindow("all", now), { range: "all", fromMs: 0, toMs: 0 });
  assert.deepEqual(panel.presetWindow("24h", now), { range: "custom", fromMs: now - 86400000, toMs: now });
  assert.deepEqual(panel.presetWindow("today", now), {
    range: "custom",
    fromMs: new Date(2026, 9, 22).getTime(),
    toMs: now,
  });
  assert.equal(panel.presetWindow("7d", now).fromMs, new Date(2026, 9, 16).getTime());
  assert.equal(panel.presetWindow("14d", now).fromMs, new Date(2026, 9, 9).getTime());
  assert.equal(panel.presetWindow("30d", now).fromMs, new Date(2026, 8, 23).getTime());
  assert.equal(panel.presetWindow("unknown", now).fromMs, new Date(2026, 9, 16).getTime());
  ["today", "24h", "7d", "14d", "30d"].forEach((id) => {
    const window = panel.presetWindow(id, now);
    assert.equal(window.range, "custom");
    assert.ok(window.toMs > window.fromMs, `${id} keeps a positive window`);
  });
});

test("custom range labels describe the window", () => {
  assert.equal(panel.customRangeText(new Date(2026, 9, 1).getTime(), new Date(2026, 9, 7, 23).getTime()), "10/1 – 10/7");
  assert.equal(panel.customRangeText(new Date(2026, 9, 22).getTime(), new Date(2026, 9, 22, 17).getTime()), "10/22");
  assert.equal(panel.customRangeText(0, 0), "");
  assert.equal(panel.customRangeText(new Date(2026, 9, 7).getTime(), new Date(2026, 9, 1).getTime()), "");
});

test("free-form accents accept six digit hex only", () => {
  assert.equal(panel.isHexColor("#7c5cff"), true);
  assert.equal(panel.isHexColor("#7C5CFF"), true);
  assert.equal(panel.isHexColor("#fff"), false);
  assert.equal(panel.isHexColor("7c5cff"), false);
  assert.equal(panel.isHexColor("violet"), false);
  assert.equal(panel.isHexColor(null), false);
});

test("a tiny slice keeps a visible arc without breaking the ring", () => {
  const circumference = 2 * Math.PI * 66;
  const segments = panel.donutGeometry([26000, 35], circumference);

  assert.equal(segments[1].fraction, 35 / 26035);
  assert.ok(segments[1].length >= 4, "0.13% of the ring still renders");
  assert.ok(Math.abs(segments[0].length + segments[1].length - circumference) < 1e-6);

  const zeroed = panel.donutGeometry([26000, 0], circumference);
  assert.equal(zeroed[1].length, 0, "a zero slice stays empty");
  assert.ok(Math.abs(zeroed[0].length - circumference) < 1e-6);
});

test("the smoothed trend path stays inside the plot box", () => {
  assert.equal(panel.smoothPath([], 100, 50, 10), "");
  assert.equal(panel.smoothPath([10], 100, 50, 10), "M50.00,0.00");
  assert.equal(panel.smoothPath([10, 0], 100, 50, 10), "M0.00,0.00 L100.00,50.00");

  const spiky = [0, 0, 100, 0, 0, 40, 0];
  const path = panel.smoothPath(spiky, 320, 200, 100);
  assert.match(path, /^M0\.00,200\.00 C/);
  const numbers = path.match(/-?\d+\.\d{2}/g).map(Number);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  ys.forEach((value) => {
    assert.ok(value >= -0.01 && value <= 200.01, `control point ${value} stays inside the box`);
  });
  assert.match(panel.smoothAreaPath(spiky, 320, 200, 100), / L320\.00,200\.00 L0,200\.00 Z$/);
});

/**
 * Minimal usage payload for the card renderers.
 */
function cardUsage() {
  const row = (extra) => ({
    requests: 1,
    cost: 0.1,
    costComplete: true,
    costMissing: 0,
    ...extra,
  });
  return {
    range: "7d",
    bucket: "day",
    fromMs: new Date(2026, 9, 16).getTime(),
    toMs: new Date(2026, 9, 22, 15).getTime(),
    totals: row({ tokens: 200, requests: 4, cost: 0.4, input: 120, output: 40, cacheRead: 20, cacheWrite: 20 }),
    previous: row({ tokens: 100, cost: 0.2, requests: 2 }),
    series: [],
    heatmap: [],
    bySource: [
      row({ source: "desktop", tokens: 150, requests: 3, cost: 0.3 }),
      row({ source: "cli", tokens: 50, requests: 1, cost: 0.1 }),
    ],
    byProject: [
      row({ projectPath: "D:\\aa", projectName: "aa", source: "cli", tokens: 100 }),
      row({ projectPath: "D:\\bb", projectName: "bb", source: "cli", tokens: 60 }),
      row({ projectPath: "D:\\cc", projectName: "cc", source: "cli", tokens: 30 }),
      row({ projectPath: "D:\\dd", projectName: "dd", source: "cli", tokens: 10 }),
    ],
    byModel: [row({ model: "m1", source: "cli", tokens: 200 })],
  };
}

test("card markup never leaks source code as visible text", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const usage = cardUsage();
  // A stray statement pasted into a template literal renders as text: it is valid
  // JavaScript, so nothing else catches it.
  const forbidden = /=>|\bconst \b|\bfunction \b|\.reduce\(|\breturn \b/;
  for (const name of ["sourceRankCardHtml", "projectRankCardHtml", "metricsHtml"]) {
    const html = view[name](usage);
    const leaked = html.split("\n").filter((line) => forbidden.test(line));
    assert.deepEqual(leaked, [], `${name} rendered code as text`);
    // A dropped closing tag still parses, but it silently reparents the rest of
    // the card: a balanced count is the cheapest way to notice.
    const open = (html.match(/<div\b/g) ?? []).length;
    const close = (html.match(/<\/div>/g) ?? []).length;
    assert.equal(open, close, `${name} has unbalanced div tags`);
    const sections = (html.match(/<section\b/g) ?? []).length;
    const sectionClose = (html.match(/<\/section>/g) ?? []).length;
    assert.equal(sections, sectionClose, `${name} has unbalanced section tags`);
  }
});

test("the project card lists three rows but shares are of the whole window", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.projectRankCardHtml(cardUsage());

  const rows = html.match(/data-action="rank-row"/g) ?? [];
  assert.equal(rows.length, 3, "only the top three fit on screen");
  // 100 of 200 tokens overall, not 100 of the 190 the three rows add up to.
  assert.ok(html.includes('data-share="50%"'), "the share is of the whole window");
  assert.ok(!html.includes('data-name="dd"'), "the fourth project stays out of the list");
});

test("the source card summarises requests, cost and tokens together", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.sourceRankCardHtml(cardUsage());
  assert.ok(html.includes("合计"));
  assert.ok(html.includes("4 次请求"), "the summary counts every request");
  assert.ok(html.includes("$0.40"), "exact cost when every row is priced");
  assert.ok(html.includes("200"), "the total token figure is present");
});

/**
 * A full panel payload: every card needs its own data slice to render.
 */
function richUsage() {
  const base = cardUsage();
  const day = (index) => new Date(2026, 9, 1 + index).getTime();
  return {
    ...base,
    meta: { records: 12 },
    series: Array.from({ length: 7 }, (_unused, index) => ({
      startMs: new Date(2026, 9, 16 + index).getTime(),
      key: `k${index}`,
      tokens: 10 + index,
      input: 5,
      output: 2,
      cacheRead: 2,
      cacheWrite: 1,
      cost: 0.01 * (index + 1),
      requests: 1,
    })),
    heatmap: Array.from({ length: 10 }, (_unused, index) => ({
      dateMs: day(index),
      tokens: index * 10,
      cost: index * 0.01,
      requests: index,
      costComplete: true,
    })),
  };
}

/**
 * Stack-based tag balance check. A dropped closing tag still parses, so nothing
 * else notices that the rest of the card moved somewhere it does not belong.
 * @param {string} html
 * @returns {string[]} problems, empty when balanced
 */
function unbalancedTags(html) {
  const voids = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
    "param", "source", "track", "wbr",
    "path", "circle", "line", "rect", "polyline", "polygon", "stop", "use", "ellipse",
  ]);
  const stack = [];
  const problems = [];
  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = tag.exec(html)) !== null) {
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    if (voids.has(name) || match[4] === "/") continue;
    if (closing) {
      const top = stack.pop();
      if (top !== name) problems.push(`</${name}> closes <${top ?? "nothing"}>`);
      continue;
    }
    stack.push(name);
  }
  for (const name of stack) problems.push(`<${name}> is never closed`);
  return problems;
}

test("every card in the panel closes all of its tags", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";

  const html = view.bodyHtml(richUsage());
  assert.deepEqual(unbalancedTags(html), []);
  // The card inventory, so a missing or duplicated section is visible here.
  assert.equal((html.match(/<section class="card/g) ?? []).length, 7, "heatmap, trend, bars, 2 ranks, 2 donuts");
  assert.equal((html.match(/<article class="card metric"/g) ?? []).length, 8);
  assert.equal((html.match(/<section class="metrics"/g) ?? []).length, 1);
  assert.equal((html.match(/<div class="grid-2"/g) ?? []).length, 2);
  assert.equal((html.match(/data-action="rank-row"/g) ?? []).length, 5, "2 sources + 3 projects");
  assert.equal((html.match(/data-action="heat-day"/g) ?? []).length, 10, "one button per heat cell");

  const empty = view.bodyHtml(null);
  assert.deepEqual(unbalancedTags(empty), []);
  assert.ok(empty.includes("empty"), "the no-data state still renders its own block");
});

test("no card renders JavaScript as visible text", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.bodyHtml(richUsage());
  const forbidden = /=>|\.reduce\(|\bconst \b|\bfunction \b/;
  const leaked = html.split("\n").filter((line) => forbidden.test(line));
  assert.deepEqual(leaked, []);
});

test("every volume card carries a direction pill and paints its mini-trend to match", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";

  const up = view.metricsHtml(richUsage());
  assert.equal(
    (up.match(/class="delta-badge is-up"/g) ?? []).length,
    7,
    "seven volume cards rise against the previous window",
  );
  assert.equal((up.match(/class="delta-badge is-down"/g) ?? []).length, 0);
  assert.ok(up.includes("var(--delta-up)"), "the sparkline repeats the direction");
  assert.ok(up.includes("+120"), "no baseline falls back to the absolute change");
  assert.ok(up.includes('title="较上期 ↑'), "the comparison is spelled out in the title");

  const falling = richUsage();
  falling.totals = {
    ...falling.totals,
    tokens: 50,
    cost: 0.1,
    requests: 1,
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 1,
  };
  falling.previous = {
    ...falling.previous,
    tokens: 200,
    cost: 0.4,
    requests: 4,
    input: 120,
    output: 40,
    cacheRead: 20,
    cacheWrite: 20,
  };
  const down = view.metricsHtml(falling);
  assert.equal((down.match(/class="delta-badge is-down"/g) ?? []).length, 7, "a fall reads as a fall");
  assert.ok(down.includes("var(--delta-down)"));
  assert.deepEqual(unbalancedTags(down), []);
});

test("a hidden slice stops claiming a share instead of showing a dimmed one", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.hidden.clear();
  view.state.hidden.add("source|cli");

  const html = view.bodyHtml(richUsage());
  assert.ok(html.includes("slice-row is-off"), "the row is marked off");
  assert.match(html, /class="pct">—</, "a hidden slice claims no percentage");

  view.state.hidden.clear();
  const restored = view.bodyHtml(richUsage());
  assert.ok(!restored.includes("slice-row is-off"));
});

test("the heat hover card lists the day level and its models with shares", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const html = view.heatTipHtml(
    {
      dateMs: new Date(2026, 7, 2).getTime(),
      tokens: 1000,
      cost: 1,
      requests: 4,
      costComplete: true,
      models: [
        { model: "deepseek-v4-flash", source: "cli", provider: "pi", tokens: 700 },
        { model: "gpt-5.6", source: "desktop", provider: "pi", tokens: 200 },
      ],
      otherTokens: 100,
    },
    2,
  );

  assert.ok(html.includes("2026-08-02"), "the card names the day");
  assert.ok(html.includes("等级 2"));
  assert.ok(html.includes("pi · deepseek-v4-flash"));
  assert.ok(html.includes("70%"), "each row carries its share of the day");
  assert.ok(html.includes("其他模型"), "the tail folds into one row");
  assert.equal((html.match(/tip-model-bar/g) ?? []).length, 3, "one bar per row");
  assert.deepEqual(unbalancedTags(html), []);

  const quiet = view.heatTipHtml({ dateMs: Date.now(), tokens: 0, cost: 0, requests: 0, models: [] }, 0);
  assert.ok(!quiet.includes("模型明细"), "an empty day has no model block");
});

test("the pricing dialog edits the draft and ships no markup surprises", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.pricingOpen = false;
  view.state.pricingDraft = {};
  assert.ok(!view.bodyHtml(richUsage()).includes("pricing-modal"), "closed by default");

  view.state.pricingOpen = true;
  view.state.pricingDraft = { m1: { input: "3" } };
  const html = view.bodyHtml(richUsage());

  assert.ok(html.includes("pricing-modal"), "the dialog is part of the panel while open");
  assert.ok(html.includes("模型定价"));
  assert.equal((html.match(/class="price-row"/g) ?? []).length, 1, "one row per model in the window");
  assert.equal((html.match(/data-role="price"/g) ?? []).length, 4, "four rates per model");
  assert.ok(html.includes('value="3"'), "the draft value is what the input shows");
  assert.ok(html.includes("data-action=\"pricing-save\""), "there is a way to commit");
  assert.deepEqual(unbalancedTags(html), []);

  view.state.pricingOpen = false;
  view.state.pricingDraft = {};
});

test("the pricing dialog lists every built-in model behind an empty field", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.builtinPricing = {
    m1: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  view.state.pricingOpen = true;
  view.state.pricingDraft = {};

  const html = view.bodyHtml(richUsage());
  assert.equal(
    (html.match(/class="price-row"/g) ?? []).length,
    2,
    "the window model plus the built-in model that has no traffic here",
  );
  assert.ok(html.includes("claude-sonnet-4-20250514"), "a built-in model is listed and editable");
  assert.ok(html.includes("price-filter"), "the list can be searched");
  assert.ok(html.includes("共 2 个模型"), "the count reflects the list");
  assert.equal((html.match(/data-role="price"/g) ?? []).length, 8, "four rates per model");
  assert.ok(html.includes("price-builtin"), "both rows are marked as built-in");
  assert.ok(html.includes('value=""'), "fields start empty and inherit the built-in rate");

  // Every bucket, not just the first: the placeholder is the only place the
  // built-in rate is visible for a model the user has not typed anything into.
  const row = html.slice(html.indexOf('data-price-model="m1"'));
  const cells = row.slice(0, row.indexOf("</li>"));
  for (const [field, rate] of [
    ["input", "3"],
    ["output", "15"],
    ["cacheRead", "0.3"],
    ["cacheWrite", "3.75"],
  ]) {
    assert.ok(
      cells.includes(`data-field="${field}"`) && cells.includes(`placeholder="${rate}"`),
      `${field} shows the built-in ${rate}`,
    );
  }
  assert.deepEqual(unbalancedTags(html), []);

  view.state.pricingOpen = false;
  view.state.builtinPricing = {};
});

test("the pricing dialog counts what its filter leaves behind", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.builtinPricing = {
    m1: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  view.state.pricingOpen = true;
  view.state.pricingDraft = {};
  view.state.pricingFilter = "gpt";

  const none = view.bodyHtml(richUsage());
  assert.equal((none.match(/class="price-row"/g) ?? []).length, 0, "nothing matches the filter");
  assert.ok(none.includes("共 0 个模型"), "the count follows the filter");
  assert.ok(none.includes("当前区间还没有发现模型"), "an empty list says why it is empty");

  view.state.pricingFilter = "claude";
  const one = view.bodyHtml(richUsage());
  assert.equal((one.match(/class="price-row"/g) ?? []).length, 1);
  assert.ok(one.includes("共 1 个模型"));

  view.state.pricingFilter = "";
  view.state.pricingOpen = false;
  view.state.builtinPricing = {};
});

test("the rate card opens on an empty panel too", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.pricingOpen = true;
  view.state.pricingDraft = {};
  view.state.builtinPricing = { m1: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };

  const html = view.bodyHtml({ meta: { records: 0 } });
  assert.ok(html.includes("pricing-modal"), "a first install can still reach its rate card");
  assert.deepEqual(unbalancedTags(html), []);

  view.state.pricingOpen = false;
  view.state.builtinPricing = {};
});

test("a draft row submits only the buckets the user typed", () => {
  const view = require("../views/app.js");

  assert.deepEqual(
    view.draftRates({ input: "3", output: "", cacheRead: " ", cacheWrite: null }),
    { input: "3" },
    "an empty field must not freeze the built-in rate at zero",
  );
  assert.deepEqual(view.draftRates({}), {}, "an untouched row is not a price");
  assert.deepEqual(
    view.draftRates({ input: "0", output: "0" }),
    { input: "0", output: "0" },
    "a real zero is a price the user typed",
  );
});

test("an estimated cost is never rendered as an exact one", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  const usage = cardUsage();
  // The price table, not the provider, priced these rows.
  usage.totals = { ...usage.totals, costEstimated: 2, costComplete: false };
  usage.bySource = usage.bySource.map((row) => ({ ...row, costEstimated: 1, costComplete: false }));

  assert.ok(view.sourceRankCardHtml(usage).includes("≈$0.40"), "a partial total keeps the ≈ mark");
  assert.ok(view.metricsHtml(usage).includes("≈"), "and so does the cost card");
});

/* ------------------------------------------------------------ model ring */

/** @returns {any} a window whose model ring spans both sources */
function mixedSourceUsage() {
  return {
    totals: { tokens: 1000 },
    bySource: [
      { source: "desktop", tokens: 600, cost: 0.6, requests: 3, costComplete: true },
      { source: "cli", tokens: 400, cost: 0.4, requests: 2, costComplete: true },
    ],
    byModel: [
      { model: "deepseek-v4.1-flash", source: "desktop", provider: "p", tokens: 600, cost: 0.6, requests: 3, costComplete: true, costMissing: 0 },
      { model: "deepseek-v4.1-flash", source: "cli", provider: "p", tokens: 400, cost: 0.4, requests: 2, costComplete: true, costMissing: 0 },
    ],
    byModelRest: null,
  };
}

test("a model ring names the source once two sources run the same model", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.donutMetric.model = "tokens";

  const rows = view.donutRows("model", mixedSourceUsage());
  assert.deepEqual(
    rows.map((row) => `${row.label} ${row.suffix}`.trim()),
    ["deepseek-v4.1-flash (PI-Desktop)", "deepseek-v4.1-flash (Pi-CLI)"],
    "two identical names would be indistinguishable in the legend",
  );
  assert.equal(rows[0].key, "model|desktop|deepseek-v4.1-flash", "the slice key still tells them apart");

  const single = mixedSourceUsage();
  single.byModel = [single.byModel[0]];
  single.bySource = [single.bySource[0]];
  assert.deepEqual(
    view.donutRows("model", single).map((row) => row.suffix),
    [""],
    "one source needs no tag",
  );
});

test("the model ring counts rows the capped list dropped", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.donutMetric.model = "tokens";
  const usage = mixedSourceUsage();
  usage.byModel = Array.from({ length: 7 }, (_unused, index) => ({
    model: `m${index}`,
    source: "cli",
    provider: "",
    tokens: 10,
    cost: 0,
    requests: 1,
    costComplete: true,
    costMissing: 0,
  }));
  usage.byModelRest = { tokens: 90, cost: 0, requests: 9, costMissing: 0, costEstimated: 0, costComplete: true };

  const rows = view.donutRows("model", usage);
  const other = rows[rows.length - 1];
  assert.equal(other.key, "model|other");
  assert.equal(other.value, 10 + 90, "the remainder covers the seventh row and everything past the cap");
});

/* ------------------------------------------------------------ request log */

test("a log row shows the full clock today and a date further back", () => {
  const view = require("../views/app.js");
  const now = new Date(2026, 10, 22, 20, 30, 0).getTime();
  assert.equal(view.logTimeLabel(new Date(2026, 10, 22, 16, 15, 1).getTime(), now), "16:15:01");
  assert.equal(view.logTimeLabel(new Date(2026, 10, 17, 14, 17, 0).getTime(), now), "11-17 14:17");
  assert.equal(view.logTimeLabel(new Date(2025, 0, 3, 9, 5, 0).getTime(), now), "2025-01-03 09:05");
  assert.equal(view.logTimeLabel(0, now), "—");
});


test("speed needs a duration, and durations stay readable", () => {
  const view = require("../views/app.js");
  assert.equal(view.logSpeed(1000, 2000), 500);
  assert.equal(view.logSpeed(1000, null), null, "no duration means no speed");
  assert.equal(view.logSpeed(1000, 0), null, "a zero divisor is not a measurement");
  assert.equal(view.logSpeedLabel(499.6), "≈500 tok/s");
  assert.equal(view.logSpeedLabel(null), "—");
  assert.equal(view.logDurationLabel(734), "734ms");
  assert.equal(view.logDurationLabel(2175), "2.2s");
  assert.equal(view.logDurationLabel(64000), "1m 04s");
  assert.equal(view.logDurationLabel(null), "—");
});

test("a provider roll-up rates only the requests that reported an ending", () => {
  const view = require("../views/app.js");
  const group = { requests: 44, complete: 40, error: 2, aborted: 0, unknown: 2, timedMs: 50000, timedOutput: 5000 };
  assert.equal(view.logGroupSuccess(group), 40 / 42, "unknown endings are not failures");
  assert.equal(view.logGroupSuccess({ complete: 0, error: 0, aborted: 0, unknown: 3 }), null);
  assert.equal(view.logGroupSpeed(group), 100);
  assert.equal(view.logGroupSpeed({ timedMs: 0 }), null);
});

test("a roll-up sorts by the column the user picked", () => {
  const view = require("../views/app.js");
  const rows = [
    { key: "a", requests: 5, cost: 0.5, tokens: 10, complete: 5, error: 0, aborted: 0 },
    { key: "b", requests: 9, cost: 0.1, tokens: 90, complete: 4, error: 5, aborted: 0 },
    { key: "c", requests: 2, cost: 0.9, tokens: 40, complete: 0, error: 0, aborted: 0 },
  ];
  assert.deepEqual(view.sortLogGroups(rows, { key: "requests", dir: "desc" }).map((row) => row.key), ["b", "a", "c"]);
  assert.deepEqual(view.sortLogGroups(rows, { key: "cost", dir: "asc" }).map((row) => row.key), ["b", "a", "c"]);
  assert.deepEqual(
    view.sortLogGroups(rows, { key: "success", dir: "desc" }).map((row) => row.key),
    ["a", "b", "c"],
    "an unrated roll-up sorts with the unknown bucket",
  );
});

test("the log dialog draws its tabs, its rows and its pager", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.logTab = "requests";
  view.state.logCode = "all";
  view.state.logPageSize = 20;
  view.state.logColumns = { source: true, provider: true, model: true, cost: true, speed: true, ttft: true, code: true };
  view.state.logData = {
    page: 2,
    pageCount: 3,
    total: 47,
    counts: { all: 47, complete: 45, error: 1, aborted: 1, unknown: 0 },
    codes: [
      { code: 200, count: 46 },
      { code: 413, count: 1 },
    ],
    rows: [
      {
        id: "row-1",
        timestampMs: Date.now(),
        source: "cli",
        provider: "workbuddy",
        model: "deepseek-v4.1-flash",
        status: "complete",
        statusCode: 200,
        errorCode: "",
        inputTokens: 228,
        outputTokens: 526,
        cacheReadTokens: 31400,
        cacheWriteTokens: 0,
        totalTokens: 32154,
        cost: 0.0009,
        costEstimated: false,
        durationMs: 2175,
        ttftMs: 2946,
      },
    ],
    providers: [],
    models: [],
  };
  const html = view.logMainHtml();
  assert.ok(html.includes('data-tab="requests"'), "the request tab exists");
  assert.ok(html.includes("请求日志") && html.includes("供应商") && html.includes("模型"));
  assert.ok(html.includes("deepseek-v4.1-flash"), "the row is drawn");
  assert.ok(html.includes("≈242 tok/s"), "speed comes from output over the recorded duration");
  assert.ok(html.includes("共 47 条记录"), "the footer counts the whole filtered set");
  assert.ok(html.includes('value="2"'), "the pager sits on the page the backend returned");
  assert.ok(html.includes('data-action="log-prev"') && html.includes('data-action="log-next"'));
  const thead = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  assert.ok(!thead.includes("缓存写入"), "a column that was never switched on stays off");
  assert.ok(thead.includes("状态码"), "the status-code column is on by default");
  assert.ok(html.includes(">200</span>"), "a finished turn shows its 200");
  assert.ok(html.includes('data-code="413"'), "a code outside the fixed list still reaches the filter");
  assert.ok(html.includes('data-code="429"'), "and every code of the reference list is offered");
  assert.ok(html.includes("2.9s"), "the first call of a turn shows its first-token gap");
  assert.ok(
    html.includes('class="log-logo"') && html.includes("pi-cli.svg"),
    "the app column shows the source logo, not a colour chip",
  );
});

test("switching a column on adds exactly one column", () => {
  const view = require("../views/app.js");
  view.state.locale = "zh";
  view.state.logTab = "requests";
  view.state.logColumns = { source: true };
  const visibleBefore = (view.logMainHtml().match(/<th data-col=/g) || []).length;

  view.state.logColumns = { source: true, cost: true };
  const after = view.logMainHtml();
  assert.equal((after.match(/<th data-col=/g) || []).length, visibleBefore + 1);
  assert.ok(after.includes('data-col="cost"'));
});
