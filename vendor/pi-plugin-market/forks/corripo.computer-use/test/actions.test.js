"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  planMove,
  planClick,
  planScroll,
  planType,
  planKey,
} = require("../lib/actions.js");

const YDOTOOL = { kind: "ydotool", bin: "/usr/bin/ydotool" };
const XDOTOOL = { kind: "xdotool", bin: "/usr/bin/xdotool" };
const WTYPE = { kind: "wtype", bin: "/usr/bin/wtype" };

test("Wayland 鼠标移动用 ydotool 的绝对坐标语法", () => {
  assert.deepEqual(planMove(YDOTOOL, { x: 100, y: 200 }), [
    ["/usr/bin/ydotool", "mousemove", "--absolute", "-x", "100", "-y", "200"],
  ]);
});

test("X11 鼠标移动用 xdotool mousemove", () => {
  assert.deepEqual(planMove(XDOTOOL, { x: 0, y: 0 }), [
    ["/usr/bin/xdotool", "mousemove", "0", "0"],
  ]);
});

test("坐标必须是整数且非负，否则明确报错", () => {
  assert.throws(() => planMove(YDOTOOL, { x: 1.5, y: 2 }), /整数/);
  assert.throws(() => planMove(YDOTOOL, { x: "10", y: 2 }), /整数/);
  assert.throws(() => planMove(YDOTOOL, { x: NaN, y: 2 }), /整数/);
  assert.throws(() => planMove(YDOTOOL, { y: 2 }), /整数/);
});

test("双击生成两条 click 命令", () => {
  assert.deepEqual(planClick(YDOTOOL, { count: 2 }), [
    ["/usr/bin/ydotool", "click", "0xC0"],
    ["/usr/bin/ydotool", "click", "0xC0"],
  ]);
  assert.deepEqual(planClick(XDOTOOL, { count: 2, button: "right" }), [
    ["/usr/bin/xdotool", "click", "3"],
    ["/usr/bin/xdotool", "click", "3"],
  ]);
});

test("点击带坐标时先移动再点击", () => {
  assert.deepEqual(planClick(XDOTOOL, { x: 5, y: 6 }), [
    ["/usr/bin/xdotool", "mousemove", "5", "6"],
    ["/usr/bin/xdotool", "click", "1"],
  ]);
});

test("非法按钮与非法点击数被拒", () => {
  assert.throws(() => planClick(YDOTOOL, { button: "back" }), /button/);
  assert.throws(() => planClick(YDOTOOL, { count: 0 }), /count/);
  assert.throws(() => planClick(YDOTOOL, { count: 9 }), /count/);
});

test("X11 滚轮映射到按钮 4/5", () => {
  assert.deepEqual(planScroll(XDOTOOL, { direction: "up", amount: 2 }), [
    ["/usr/bin/xdotool", "click", "4"],
    ["/usr/bin/xdotool", "click", "4"],
  ]);
  assert.deepEqual(planScroll(XDOTOOL, { direction: "down" }), [
    ["/usr/bin/xdotool", "click", "5"],
  ]);
});

test("Wayland 滚轮如实报不支持，而不是发一条假命令", () => {
  assert.throws(
    () => planScroll(YDOTOOL, { direction: "down" }),
    (err) => err.unsupported === true && Boolean(err.hint)
  );
});

test("文本输入：ydotool 与 xdotool 的语法差异", () => {
  assert.deepEqual(planType(YDOTOOL, { text: "hello" }), [
    ["/usr/bin/ydotool", "type", "hello"],
  ]);
  // 以 - 开头的文本要用 -- 隔开，避免被当成选项
  assert.deepEqual(planType(YDOTOOL, { text: "-v" }), [
    ["/usr/bin/ydotool", "type", "--", "-v"],
  ]);
  assert.deepEqual(planType(XDOTOOL, { text: "hi", delayMs: 30 }), [
    ["/usr/bin/xdotool", "type", "--delay", "30", "hi"],
  ]);
  assert.throws(() => planType(YDOTOOL, { text: "" }), /text/);
});

test("组合键：ydotool 展开成 evdev 按下/抬起序列", () => {
  assert.deepEqual(planKey(YDOTOOL, { key: "ctrl+c" }), [
    ["/usr/bin/ydotool", "key", "29:1", "46:1", "46:0", "29:0"],
  ]);
  assert.deepEqual(planKey(YDOTOOL, { keys: ["ctrl+a", "Return"] }), [
    [
      "/usr/bin/ydotool",
      "key",
      "29:1",
      "30:1",
      "30:0",
      "29:0",
      "28:1",
      "28:0",
    ],
  ]);
});

test("组合键：xdotool 用键名", () => {
  assert.deepEqual(planKey(XDOTOOL, { key: "ctrl+shift+t" }), [
    ["/usr/bin/xdotool", "key", "--", "ctrl+shift+t"],
  ]);
  assert.deepEqual(planKey(XDOTOOL, { keys: ["ctrl+a", "Return"] }), [
    ["/usr/bin/xdotool", "key", "--", "ctrl+a", "Return"],
  ]);
});

test("无法识别的组合键给出 hint", () => {
  assert.throws(
    () => planKey(YDOTOOL, { key: "ctrl+bogus" }),
    (err) => /无法识别/.test(err.message) && Boolean(err.hint)
  );
  assert.throws(() => planKey(YDOTOOL, { keys: [] }), /不能为空/);
});

test("wtype 只能打字：组合键与鼠标都报不支持", () => {
  assert.throws(
    () => planKey(WTYPE, { key: "ctrl+c" }),
    (err) => err.unsupported === true
  );
  assert.throws(() => planMove(WTYPE, { x: 1, y: 1 }), /no input backend/);
});
