/**
 * The takeover bar loaded into the transparent WebContentsView above the
 * page. It is a trusted local document (not injected into the site): the page
 * only ever receives the pointer-events-none ownership effect.
 */

export const AGENT_CONTROL_BAR_URL = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;
 font:500 12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#bar{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);display:flex;
 align-items:center;gap:8px;padding:6px 8px 6px 12px;border-radius:999px;
 background:rgba(16,19,25,.97);color:#f5f8fd;
 box-shadow:0 8px 28px rgba(0,0,0,.45),0 0 0 1px rgba(59,130,246,.5);white-space:nowrap}
#orbit{width:12px;height:12px;box-sizing:border-box;border-radius:50%;
 border:2px solid rgba(59,130,246,.5);border-top-color:rgba(59,130,246,1);
 box-shadow:0 0 12px rgba(59,130,246,.9);animation:spin 1.1s linear infinite}
#bar[data-busy="false"] #orbit{animation-duration:3.2s}
#bar[data-busy="false"]:not([data-user="true"]){background:rgba(30,34,42,.82);opacity:.9;
 box-shadow:0 6px 20px rgba(0,0,0,.32),0 0 0 1px rgba(59,130,246,.28)}
#bar[data-user="true"] #orbit{border-color:rgba(245,158,11,.5);border-top-color:rgba(245,158,11,1);
 box-shadow:0 0 12px rgba(245,158,11,.9)}
#label{max-width:200px;overflow:hidden;text-overflow:ellipsis}
button{all:unset;cursor:pointer;padding:4px 10px;border-radius:999px;
 background:rgba(255,255,255,.15);color:inherit;font:inherit}
button:hover{background:rgba(255,255,255,.26)}
@keyframes spin{to{transform:rotate(360deg)}}
</style></head><body><div id="bar" data-busy="true" data-user="false">
<span id="orbit"></span><span id="label">Agent 空闲（可接管）</span>
<button id="main" data-action="takeover">接管</button>
<button id="stop">终止</button></div>
<script>
document.getElementById("main").addEventListener("click", function () {
  console.log("pi-agent-control:" + this.dataset.action);
});
document.getElementById("stop").addEventListener("click", function () {
  console.log("pi-agent-control:stop");
});
window.__piControl = function (state, action) {
  var bar = document.getElementById("bar");
  var label = document.getElementById("label");
  var main = document.getElementById("main");
  var user = state === "user";
  bar.dataset.busy = user ? "false" : "true";
  bar.dataset.user = user ? "true" : "false";
  label.textContent = user ? "你已接管浏览器"
    : state === "agent" ? "Agent 正在操作" + (action ? "：" + action : "") : "Agent 空闲（可接管）";
  main.textContent = user ? "交还" : "接管";
  main.dataset.action = user ? "handBack" : "takeover";
};
</script></body></html>`)}`;
