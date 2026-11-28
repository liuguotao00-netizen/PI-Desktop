"use strict";
(() => {
  // renderer/search.ts
  var document = window.document;
  var query = document.getElementById("query");
  var results = document.getElementById("results");
  var overlay = document.getElementById("overlay");
  var entries = [["\u4ECA\u5929", "\u65B0\u5EFA\u4EFB\u52A1", "\u5F00\u59CB\u4E00\u4E2A\u65B0\u7684\u4F1A\u8BDD"], ["\u4ECA\u5929", "\u521B\u5EFA Pi-Desktop \u4E3B\u9898\u63D2\u4EF6", "PI-Desktop-Sax-Theme"], ["\u4ECA\u5929", "Phase 1 \xB7 \u534F\u8BAE\u8FB9\u754C\u4E0E\u67B6\u6784\u51B3\u7B56", "PI-Desktop \u63D2\u4EF6\u5F00\u53D1"], ["\u66F4\u65E9", "\u7814\u7A76\u7C92\u5B50\u6EB6\u89E3\u4E0E\u5F39\u7A97\u9000\u51FA", "Sax Design Vue"], ["\u66F4\u65E9", "\u6574\u7406\u9879\u76EE\u4E0E\u4F1A\u8BDD\u5F52\u6863", "\u5DE5\u4F5C\u7A7A\u95F4"], ["\u547D\u4EE4", "New task", "\u521B\u5EFA\u4EFB\u52A1"], ["\u547D\u4EE4", "Compact conversation context", "\u538B\u7F29\u4F1A\u8BDD\u4E0A\u4E0B\u6587"]];
  var selected = 0;
  function close() {
    overlay.hidden = true;
    document.getElementById("reopen").focus();
  }
  function draw() {
    results.replaceChildren();
    let lastGroup = "";
    const filtered = entries.filter((e) => e.join(" ").toLowerCase().includes(query.value.toLowerCase()));
    selected = Math.min(selected, Math.max(0, filtered.length - 1));
    filtered.forEach((entry, index) => {
      if (entry[0] !== lastGroup) {
        const label = document.createElement("div");
        label.className = "search-group-label";
        label.textContent = entry[0];
        results.append(label);
        lastGroup = entry[0];
      }
      const row = document.createElement("button");
      row.className = "search-item" + (index === selected ? " active" : "");
      row.type = "button";
      const icon = document.createElement("span");
      icon.className = "search-item-icon";
      icon.textContent = entry[0] === "\u547D\u4EE4" ? "\u2318" : "\u25A2";
      const detail = document.createElement("span");
      detail.className = "search-session-details";
      const title = document.createElement("span");
      title.className = "search-item-title";
      title.textContent = entry[1];
      const meta = document.createElement("span");
      meta.className = "search-item-meta";
      meta.textContent = entry[2];
      detail.append(title, meta);
      row.append(icon, detail);
      row.onclick = () => {
        document.getElementById("selection").textContent = `\u9884\u89C8\u9009\u62E9\uFF1A${entry[1]}`;
        close();
      };
      results.append(row);
    });
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "search-empty";
      empty.textContent = "\u6CA1\u6709\u5339\u914D\u7684\u7ED3\u679C\uFF0C\u8BD5\u8BD5\u5176\u4ED6\u5173\u952E\u8BCD";
      results.append(empty);
    }
  }
  query.oninput = () => {
    selected = 0;
    draw();
  };
  query.addEventListener("keydown", (e) => {
    const count = results.querySelectorAll(".search-item").length;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && count) {
      e.preventDefault();
      selected = (selected + (e.key === "ArrowDown" ? 1 : -1) + count) % count;
      draw();
      results.querySelector(".active")?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      results.querySelector(".active")?.click();
    }
  });
  document.getElementById("close").onclick = close;
  document.getElementById("reopen").onclick = () => {
    overlay.hidden = false;
    query.focus();
  };
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  document.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (e.key === "Tab") {
      const controls = [...overlay.querySelectorAll("input,button")];
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  document.getElementById("mode").onclick = () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.getElementById("theme").href = `../themes/sax-${dark ? "dark" : "light"}.css`;
    document.getElementById("mode").textContent = dark ? "\u6D45\u8272" : "\u6DF1\u8272";
  };
  draw();
  query.focus();
})();
