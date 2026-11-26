"use strict";

/**
 * 按键名 <-> evdev keycode 映射（只收录常用键，不追求补全全表）。
 *
 * 为什么需要它：X11 的 xdotool 认名字（`xdotool key ctrl+c`），而 Wayland 的 ydotool
 * 只认 evdev 数字键码（`ydotool key 29:1 46:1 46:0 29:0`）。同一个 "ctrl+c" 必须能翻译
 * 成两种形式，否则键盘工具在 Wayland 下必然不可用。
 */

// 名字（小写）-> evdev keycode
const KEYCODES = {
  esc: 1,
  escape: 1,
  "1": 2,
  "2": 3,
  "3": 4,
  "4": 5,
  "5": 6,
  "6": 7,
  "7": 8,
  "8": 9,
  "9": 10,
  "0": 11,
  minus: 12,
  "-": 12,
  equal: 13,
  "=": 13,
  backspace: 14,
  tab: 15,
  q: 16,
  w: 17,
  e: 18,
  r: 19,
  t: 20,
  y: 21,
  u: 22,
  i: 23,
  o: 24,
  p: 25,
  leftbracket: 26,
  "[": 26,
  rightbracket: 27,
  "]": 27,
  enter: 28,
  return: 28,
  leftctrl: 29,
  leftcontrol: 29,
  a: 30,
  s: 31,
  d: 32,
  f: 33,
  g: 34,
  h: 35,
  j: 36,
  k: 37,
  l: 38,
  semicolon: 39,
  ";": 39,
  apostrophe: 40,
  "'": 40,
  grave: 41,
  "`": 41,
  leftshift: 42,
  backslash: 43,
  "\\": 43,
  z: 44,
  x: 45,
  c: 46,
  v: 47,
  b: 48,
  n: 49,
  m: 50,
  comma: 51,
  ",": 51,
  dot: 52,
  period: 52,
  ".": 52,
  slash: 53,
  "/": 53,
  rightshift: 54,
  leftalt: 56,
  space: 57,
  capslock: 58,
  f1: 59,
  f2: 60,
  f3: 61,
  f4: 62,
  f5: 63,
  f6: 64,
  f7: 65,
  f8: 66,
  f9: 67,
  f10: 68,
  numlock: 69,
  scrolllock: 70,
  f11: 87,
  f12: 88,
  rightctrl: 97,
  rightcontrol: 97,
  rightalt: 100,
  altgr: 100,
  home: 102,
  up: 103,
  pageup: 104,
  prior: 104,
  left: 105,
  right: 106,
  end: 107,
  down: 108,
  pagedown: 109,
  next: 109,
  insert: 110,
  delete: 111,
  del: 111,
  leftmeta: 125,
  rightmeta: 126,
};

// 修饰键别名（点击语义：按下再抬起）
const MODIFIERS = {
  ctrl: "leftctrl",
  control: "leftctrl",
  shift: "leftshift",
  alt: "leftalt",
  option: "leftalt",
  super: "leftmeta",
  meta: "leftmeta",
  win: "leftmeta",
  cmd: "leftmeta",
  command: "leftmeta",
  hyper: "leftmeta",
};

// xdotool 与 evdev 名字不一致的几个键，Wayland 以外的后端用这个表
const XDOTOOL_ALIASES = {
  leftctrl: "ctrl",
  rightctrl: "ctrl",
  leftshift: "shift",
  rightshift: "shift",
  leftalt: "alt",
  rightalt: "alt",
  leftmeta: "super",
  rightmeta: "super",
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  insert: "Insert",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  prior: "Page_Up",
  next: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  tab: "Tab",
  space: "space",
  comma: "comma",
  dot: "period",
  period: "period",
  slash: "slash",
  semicolon: "semicolon",
  apostrophe: "apostrophe",
  grave: "grave",
  minus: "minus",
  equal: "equal",
  leftbracket: "bracketleft",
  rightbracket: "bracketright",
  backslash: "backslash",
};

function normalizeKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function resolveKey(name) {
  let key = normalizeKey(name);
  if (!key) return null;
  if (MODIFIERS[key]) key = MODIFIERS[key];
  return Object.prototype.hasOwnProperty.call(KEYCODES, key) ? key : null;
}

function keycode(name) {
  const resolved = resolveKey(name);
  return resolved === null ? null : KEYCODES[resolved];
}

function xdotoolKeyName(name) {
  const resolved = resolveKey(name);
  if (resolved === null) return null;
  if (XDOTOOL_ALIASES[resolved]) return XDOTOOL_ALIASES[resolved];
  // 字母/数字/F1-F12 在 xdotool 与 evdev 里同名
  return resolved;
}

/**
 * 解析 "ctrl+shift+t" / "Return" 这种组合，返回 {modifiers:[], key:"t"}。
 * 无法识别的键返回 null，由调用方给出明确错误。
 */
function parseCombo(combo) {
  if (typeof combo !== "string" || !combo.trim()) return null;
  const parts = combo
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  if (!parts.length) return null;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (resolveKey(key) === null) return null;
  const modifiers = [];
  for (const mod of mods) {
    const normalized = normalizeKey(mod);
    const resolvedMod = MODIFIERS[normalized] || (KEYCODES[normalized] ? normalized : null);
    if (!resolvedMod) return null;
    modifiers.push(resolvedMod);
  }
  return { modifiers, key: resolveKey(key) };
}

module.exports = {
  KEYCODES,
  MODIFIERS,
  XDOTOOL_ALIASES,
  normalizeKey,
  resolveKey,
  keycode,
  xdotoolKeyName,
  parseCombo,
};
