"use strict";

/**
 * 纯函数层：把「想做什么」翻译成「该跑哪条命令」。
 *
 * 这一层刻意不执行任何进程，也不读文件系统 —— 离线单元测试就是测它。
 * 所有平台差异都收敛在这里：
 *   Wayland  ydotool（mousemove/click/type/key，键盘只认 evdev 数字键码）
 *   X11      xdotool（认键名）
 */

const { parseCombo, keycode, xdotoolKeyName } = require("./keymap.js");

const BUTTONS = ["left", "middle", "right"];

// ydotool 的按键掩码约定
const YDOTOOL_MASKS = { left: "0xC0", middle: "0xC2", right: "0xC1" };
// xdotool 的按钮编号约定
const XDOTOOL_BUTTONS = { left: 1, middle: 2, right: 3 };

function assertFiniteInt(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${name} 必须是整数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

function assertButton(button) {
  if (!BUTTONS.includes(button)) {
    throw new Error(`button 只能是 ${BUTTONS.join("/")}，收到 ${JSON.stringify(button)}`);
  }
  return button;
}

function assertCount(count) {
  const n = count === undefined || count === null ? 1 : count;
  if (!Number.isInteger(n) || n < 1 || n > 3) {
    throw new Error(`count 必须是 1..3 的整数，收到 ${JSON.stringify(count)}`);
  }
  return n;
}

/** 鼠标绝对移动 */
function planMove(backend, args) {
  const x = assertFiniteInt(args.x, "x");
  const y = assertFiniteInt(args.y, "y");
  if (backend.kind === "ydotool") {
    return [[backend.bin, "mousemove", "--absolute", "-x", String(x), "-y", String(y)]];
  }
  if (backend.kind === "xdotool") {
    return [[backend.bin, "mousemove", String(x), String(y)]];
  }
  throw new Error("no input backend");
}

/** 鼠标点击；先移动再点（给了坐标时） */
function planClick(backend, args) {
  const button = assertButton(args.button || "left");
  const count = assertCount(args.count);
  const cmds = [];
  if (args.x !== undefined && args.x !== null) {
    cmds.push(...planMove(backend, { x: args.x, y: args.y }));
  }
  for (let i = 0; i < count; i += 1) {
    if (backend.kind === "ydotool") {
      cmds.push([backend.bin, "click", YDOTOOL_MASKS[button]]);
    } else if (backend.kind === "xdotool") {
      cmds.push([backend.bin, "click", String(XDOTOOL_BUTTONS[button])]);
    } else {
      throw new Error("no input backend");
    }
  }
  return cmds;
}

/**
 * 滚轮。ydotool 1.x 没有 wheel 子命令，所以 Wayland 下如实报不支持，
 * 而不是发一条注定失败的假命令。
 */
function planScroll(backend, args) {
  const direction = args.direction || "down";
  if (direction !== "up" && direction !== "down") {
    throw new Error(`direction 只能是 up/down，收到 ${JSON.stringify(args.direction)}`);
  }
  const amount = args.amount === undefined || args.amount === null ? 1 : args.amount;
  if (!Number.isInteger(amount) || amount < 1 || amount > 20) {
    throw new Error(`amount 必须是 1..20 的整数，收到 ${JSON.stringify(amount)}`);
  }
  if (backend.kind === "xdotool") {
    const cmds = [];
    if (args.x !== undefined && args.x !== null) {
      cmds.push(...planMove(backend, { x: args.x, y: args.y }));
    }
    const button = direction === "up" ? "4" : "5";
    for (let i = 0; i < amount; i += 1) cmds.push([backend.bin, "click", button]);
    return cmds;
  }
  const err = new Error("unsupported_on_backend");
  err.unsupported = true;
  err.hint =
    "ydotool 1.x 没有滚轮子命令，Wayland 下无法滚动。可在 X11 会话使用，或用合成器的原生接口。";
  throw err;
}

/** 输入文本 */
function planType(backend, args) {
  const text = String(args.text === undefined || args.text === null ? "" : args.text);
  if (!text) throw new Error("text 不能为空");
  if (backend.kind === "ydotool") {
    // ydotool type 把剩余参数拼起来当文本；以 '-' 开头时用 -- 隔开，避免被当成选项
    const argv = [backend.bin, "type"];
    if (text.startsWith("-")) argv.push("--");
    argv.push(text);
    return [argv];
  }
  if (backend.kind === "xdotool") {
    const delay = Number.isInteger(args.delayMs) ? Math.max(0, Math.min(2000, args.delayMs)) : 12;
    return [[backend.bin, "type", "--delay", String(delay), text]];
  }
  if (backend.kind === "wtype") {
    return [[backend.bin, text]];
  }
  throw new Error("no input backend");
}

/** 逐个组合键，例如 ["ctrl+c", "Return"] */
function planKey(backend, args) {
  const keys = Array.isArray(args.keys) ? args.keys : args.key ? [args.key] : [];
  if (!keys.length) throw new Error("key 或 keys 不能为空");
  const parsed = keys.map((combo) => {
    const p = parseCombo(combo);
    if (!p) {
      const err = new Error(`无法识别的按键组合：${combo}`);
      err.hint = "用 + 连接修饰键，例如 ctrl+shift+t；可接受的键名见 lib/keymap.js";
      throw err;
    }
    return { combo, ...p };
  });

  if (backend.kind === "ydotool") {
    const seq = [];
    for (const item of parsed) {
      const mods = item.modifiers.map((m) => keycode(m));
      const key = keycode(item.key);
      if (key === null) throw new Error(`无法解析键码：${item.combo}`);
      for (const m of mods) seq.push(`${m}:1`);
      seq.push(`${key}:1`);
      seq.push(`${key}:0`);
      for (const m of mods.slice().reverse()) seq.push(`${m}:0`);
    }
    return [[backend.bin, "key", ...seq]];
  }
  if (backend.kind === "xdotool") {
    const combos = parsed.map((item) => {
      const mods = item.modifiers.map((m) => xdotoolKeyName(m));
      const key = xdotoolKeyName(item.key);
      return [...mods, key].join("+");
    });
    return [[backend.bin, "key", "--", ...combos]];
  }
  if (backend.kind === "wtype") {
    const err = new Error("unsupported_on_backend");
    err.unsupported = true;
    err.hint = "wtype 只支持输入文本，不支持组合键；组合键需要 ydotool。";
    throw err;
  }
  throw new Error("no input backend");
}

module.exports = {
  BUTTONS,
  YDOTOOL_MASKS,
  XDOTOOL_BUTTONS,
  planMove,
  planClick,
  planScroll,
  planType,
  planKey,
  assertFiniteInt,
  assertButton,
  assertCount,
};
