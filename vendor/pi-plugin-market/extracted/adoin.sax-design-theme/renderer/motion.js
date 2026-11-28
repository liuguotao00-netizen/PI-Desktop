"use strict";
(() => {
  // renderer/motion.ts
  var document = window.document;
  var menu = document.getElementById("demo-menu");
  var trigger = document.getElementById("menu-toggle");
  var items = [...menu.querySelectorAll("button")];
  function setMenu(open, restore = false) {
    menu.inert = !open;
    menu.classList.toggle("is-open", open);
    trigger.setAttribute("aria-expanded", String(open));
    if (open) items[0].focus();
    else if (restore) trigger.focus();
  }
  trigger.onclick = () => setMenu(!menu.classList.contains("is-open"));
  menu.addEventListener("keydown", (e) => {
    const index = items.findIndex((item) => item === document.activeElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      items[e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    }
    if (e.key === "Tab") setMenu(false, true);
  });
  items.forEach((item) => item.onclick = () => {
    document.getElementById("result").textContent = `\u5DF2\u9009\u62E9\uFF1A${item.textContent}`;
    setMenu(false, true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.classList.contains("is-open")) {
      e.preventDefault();
      setMenu(false, true);
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof Element) || !e.target.closest(".anchor")) setMenu(false);
  });
  var dialog = document.getElementById("demo-dialog");
  var reduced = matchMedia("(prefers-reduced-motion: reduce)");
  var particlePi = { ui: { openLayer() {
    const element = document.createElement("div");
    Object.assign(element.style, { position: "fixed", top: "0", left: "0", width: "0", height: "0", zIndex: "600" });
    document.body.append(element);
    return { element, close: () => element.remove() };
  } } };
  var particles = window.SaxDissolve.attachHostDissolve(particlePi, { activeTheme: () => true });
  document.getElementById("particles-toggle").onclick = () => {
    if (particles) {
      particles.dispose();
      particles = null;
    } else particles = window.SaxDissolve.attachHostDissolve(particlePi, { activeTheme: () => true });
    document.getElementById("particles-toggle").setAttribute("aria-pressed", String(!!particles));
    document.getElementById("particles-toggle").textContent = particles ? "\u7C92\u5B50\u5F00\u542F\uFF1A\u5207\u6362\u666E\u901A\u7F29\u653E\u9000\u51FA" : "\u666E\u901A\u7F29\u653E\uFF1A\u5207\u6362\u7C92\u5B50\u6EB6\u89E3";
    updateStatus();
  };
  var logs = [];
  function log(text) {
    logs.push(text);
    document.getElementById("event-log").textContent = logs.slice(-10).join("\n");
  }
  function duration(token) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return parseFloat(value) * (value.endsWith("ms") ? 1 : 1e3) || 0;
  }
  function updateStatus() {
    document.getElementById("motion-status").textContent = `\u7CFB\u7EDF\u51CF\u5C11\u52A8\u6548\uFF1A${reduced.matches ? "\u5F00\u542F" : "\u5173\u95ED"} \xB7 \u5165\u573A ${duration("--sax-motion-dialog")}ms \xB7 \u9000\u51FA ${particles ? "\u7C92\u5B50 220" : duration("--sax-motion-exit")}ms \xB7 \u9875\u9762 ${document.visibilityState}`;
  }
  reduced.addEventListener("change", updateStatus);
  document.addEventListener("visibilitychange", updateStatus);
  document.getElementById("theme").addEventListener("load", updateStatus);
  document.getElementById("force").onclick = () => {
    const enabled = document.documentElement.dataset.previewMotion !== "on";
    document.documentElement.dataset.previewMotion = enabled ? "on" : "";
    document.getElementById("force").setAttribute("aria-pressed", String(enabled));
    document.getElementById("force").textContent = enabled ? "\u4EC5\u9884\u89C8\uFF1A\u6062\u590D\u7CFB\u7EDF\u8BBE\u7F6E" : "\u4EC5\u9884\u89C8\uFF1A\u5F3A\u5236\u64AD\u653E";
    updateStatus();
  };
  var exitTimer;
  function finishClose() {
    clearTimeout(exitTimer);
    if (!dialog.classList.contains("sax-motion-leaving")) return;
    dialog.close();
    dialog.classList.remove("sax-motion-leaving");
    document.getElementById("dialog-close").disabled = false;
    log("closed\uFF1A\u9000\u573A\u7ED3\u675F\u540E\u5173\u95ED");
  }
  function closeDialog() {
    if (!dialog.open || dialog.classList.contains("sax-motion-leaving")) return;
    if (particles) {
      dialog.close();
      log("closed\uFF1A\u539F\u59CB\u5F39\u7A97\u5173\u95ED\uFF0C\u7C92\u5B50\u89C2\u5BDF\u5668\u5904\u7406\u89C6\u89C9\u526F\u672C");
      return;
    }
    dialog.classList.add("sax-motion-leaving");
    document.getElementById("dialog-close").disabled = true;
    const ms = duration("--sax-motion-exit");
    if (ms === 0) finishClose();
    else exitTimer = setTimeout(finishClose, ms + 100);
  }
  document.getElementById("dialog-open").onclick = () => {
    setMenu(false);
    if (dialog.open) return;
    clearTimeout(exitTimer);
    dialog.classList.remove("sax-motion-leaving");
    document.getElementById("dialog-close").disabled = false;
    dialog.showModal();
    log("open\uFF1A\u5F00\u59CB\u5165\u573A");
  };
  document.getElementById("dialog-close").onclick = closeDialog;
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeDialog();
  });
  dialog.addEventListener("animationstart", (e) => {
    if (e.target === dialog && !e.pseudoElement) log(`start\uFF1A${e.animationName}`);
  });
  dialog.addEventListener("animationend", (e) => {
    if (e.target !== dialog || e.pseudoElement) return;
    log(`end\uFF1A${e.animationName} \xB7 ${Math.round(e.elapsedTime * 1e3)}ms`);
    if (e.animationName === "sax-dialog-exit") finishClose();
  });
  dialog.addEventListener("close", () => document.getElementById("dialog-open").focus());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog();
    }
  });
  updateStatus();
  var toastTimer;
  var removalTimer;
  document.getElementById("toast-open").onclick = () => {
    clearTimeout(toastTimer);
    clearTimeout(removalTimer);
    document.querySelector(".toast")?.remove();
    let viewport = document.querySelector(".toast-viewport");
    if (!viewport) {
      viewport = document.createElement("div");
      viewport.className = "toast-viewport";
      document.body.append(viewport);
    }
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.setAttribute("role", "status");
    toast.textContent = "\u5DF2\u5B8C\u6210 \xB7 \u8F7B\u91CF\u53CD\u9988\uFF0C\u4E0D\u6253\u65AD\u64CD\u4F5C";
    viewport.append(toast);
    toastTimer = setTimeout(() => {
      toast.classList.add("closing");
      removalTimer = setTimeout(() => toast.remove(), duration("--sax-motion-exit") + 20);
    }, 1800);
  };
  document.getElementById("mode").onclick = () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.getElementById("theme").href = `../themes/sax-${dark ? "dark" : "light"}.css`;
    document.getElementById("mode").textContent = dark ? "\u5207\u6362\u6D45\u8272" : "\u5207\u6362\u6DF1\u8272";
  };
})();
