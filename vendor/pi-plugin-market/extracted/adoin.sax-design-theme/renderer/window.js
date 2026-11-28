"use strict";
(() => {
  // renderer/window.ts
  var mode = document.querySelector("#mode");
  var maximize = document.querySelector("#maximize");
  var theme = document.querySelector("#theme");
  mode.onclick = () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    theme.href = `../themes/sax-${dark ? "dark" : "light"}.css`;
    mode.textContent = dark ? "\u6D45\u8272" : "\u6DF1\u8272";
  };
  maximize.onclick = () => {
    const max = document.documentElement.dataset.maximized !== "true";
    document.documentElement.dataset.maximized = String(max);
    maximize.textContent = max ? "\u8FD8\u539F" : "\u6700\u5927\u5316";
    maximize.setAttribute("aria-pressed", String(max));
  };
})();
