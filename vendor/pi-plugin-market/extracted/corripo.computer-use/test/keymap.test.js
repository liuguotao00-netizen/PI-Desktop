"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseCombo, keycode, xdotoolKeyName, resolveKey } = require("../lib/keymap.js");

test("parseCombo 解析单键与组合键", () => {
  assert.deepEqual(parseCombo("ctrl+c"), { modifiers: ["leftctrl"], key: "c" });
  assert.deepEqual(parseCombo("Ctrl+Shift+T"), {
    modifiers: ["leftctrl", "leftshift"],
    key: "t",
  });
  assert.deepEqual(parseCombo("Return"), { modifiers: [], key: "return" });
  assert.deepEqual(parseCombo("alt+f4"), { modifiers: ["leftalt"], key: "f4" });
});

test("parseCombo 对未知键返回 null，而不是猜一个键出来", () => {
  assert.equal(parseCombo("ctrl+nosuchkey"), null);
  assert.equal(parseCombo("hyperduper+x".replace("hyperduper", "zzz")), null);
  assert.equal(parseCombo(""), null);
  assert.equal(parseCombo(null), null);
});

test("evdev 键码与 Linux input-event-codes 一致", () => {
  assert.equal(keycode("c"), 46);
  assert.equal(keycode("ctrl"), 29);
  assert.equal(keycode("shift"), 42);
  assert.equal(keycode("alt"), 56);
  assert.equal(keycode("super"), 125);
  assert.equal(keycode("Return"), 28);
  assert.equal(keycode("Escape"), 1);
  assert.equal(keycode("space"), 57);
  assert.equal(keycode("up"), 103);
});

test("xdotool 键名映射：修饰键与特殊键改成 xdotool 认的名字", () => {
  assert.equal(xdotoolKeyName("enter"), "Return");
  assert.equal(xdotoolKeyName("esc"), "Escape");
  assert.equal(xdotoolKeyName("leftctrl"), "ctrl");
  assert.equal(xdotoolKeyName("leftmeta"), "super");
  assert.equal(xdotoolKeyName("pageup"), "Page_Up");
  assert.equal(xdotoolKeyName("a"), "a");
  assert.equal(xdotoolKeyName("nosuchkey"), null);
});

test("resolveKey 对大小写与空白不敏感", () => {
  assert.equal(resolveKey("  CTRL "), "leftctrl");
  assert.equal(resolveKey("Control"), "leftctrl");
});
