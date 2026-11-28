"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { pickInputBackend, pickScreenshotBackend } = require("../lib/backends.js");

function fakeWhich(installed) {
  return (bin) => (installed.includes(bin) ? `/usr/bin/${bin}` : null);
}

const WAYLAND = { type: "wayland", waylandDisplay: "wayland-0", x11Display: ":0" };
const X11 = { type: "x11", waylandDisplay: null, x11Display: ":0" };
const TTY = { type: "tty", waylandDisplay: null, x11Display: null };

test("Wayland 截图选 grim", () => {
  const b = pickScreenshotBackend(WAYLAND, { which: fakeWhich(["grim"]), env: {} });
  assert.equal(b.kind, "grim");
  assert.equal(b.bin, "/usr/bin/grim");
});

test("Wayland 缺 grim 时给出明确错误与安装提示", () => {
  const b = pickScreenshotBackend(WAYLAND, { which: fakeWhich([]), env: {} });
  assert.equal(b.kind, null);
  assert.equal(b.reason, "no_screenshot_backend");
  assert.match(b.message, /grim/);
  assert.match(b.hint, /grim/);
});

test("X11 优先 import，其次 scrot", () => {
  assert.equal(
    pickScreenshotBackend(X11, { which: fakeWhich(["import", "scrot"]), env: {} }).kind,
    "import"
  );
  assert.equal(
    pickScreenshotBackend(X11, { which: fakeWhich(["scrot"]), env: {} }).kind,
    "scrot"
  );
  const none = pickScreenshotBackend(X11, { which: fakeWhich([]), env: {} });
  assert.equal(none.kind, null);
  assert.match(none.hint, /imagemagick|scrot/i);
});

test("Wayland 装了 ydotool 但没有 ydotoold socket → 明确报守护进程没跑", () => {
  const b = pickInputBackend(WAYLAND, {
    which: fakeWhich(["ydotool"]),
    env: { XDG_RUNTIME_DIR: "/nonexistent-runtime-dir-for-test" },
  });
  assert.equal(b.kind, null);
  assert.equal(b.reason, "ydotoold_not_running");
  assert.match(b.hint, /ydotoold/);
});

test("Wayland 什么都没装 → 提示 ydotool，并说明 xdotool 在 Wayland 无效", () => {
  const b = pickInputBackend(WAYLAND, { which: fakeWhich([]), env: {} });
  assert.equal(b.kind, null);
  assert.equal(b.reason, "no_input_backend");
  assert.match(b.message, /ydotool/);
  assert.match(b.hint, /xdotool 在 Wayland 下无效/);
});

test("Wayland 只有 wtype → 选 wtype，并说明它只能打字", () => {
  const b = pickInputBackend(WAYLAND, { which: fakeWhich(["wtype"]), env: {} });
  assert.equal(b.kind, "wtype");
  assert.match(b.note, /只能输入文本/);
});

test("X11 输入选 xdotool；缺了就报错", () => {
  assert.equal(pickInputBackend(X11, { which: fakeWhich(["xdotool"]), env: {} }).kind, "xdotool");
  const none = pickInputBackend(X11, { which: fakeWhich([]), env: {} });
  assert.equal(none.kind, null);
  assert.equal(none.reason, "no_input_backend");
});

test("tty 会话：截图与输入都报 no_graphical_session", () => {
  assert.equal(
    pickScreenshotBackend(TTY, { which: fakeWhich(["grim", "import"]), env: {} }).reason,
    "no_graphical_session"
  );
  assert.equal(
    pickInputBackend(TTY, { which: fakeWhich(["xdotool", "ydotool"]), env: {} }).reason,
    "no_graphical_session"
  );
});
