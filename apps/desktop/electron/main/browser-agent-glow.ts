/**
 * Page-local agent ownership effect: qiwork's four-edge sweep, breathing
 * vignette and the inward curtain pulse. Injected into the visible page and
 * re-asserted by the caller; nothing here is owned by the page.
 */

const AGENT_GLOW_CSS = `#pi-agent-glow{position:fixed;inset:0;box-sizing:border-box;overflow:hidden;pointer-events:none;z-index:2147483646;
 box-shadow:inset 0 0 0 1px rgba(59,130,246,.85),inset 0 0 36px rgba(37,99,235,.62),inset 0 0 120px rgba(29,78,216,.42);
 background-color:rgba(29,78,216,.1);
 background-image:linear-gradient(90deg,rgba(37,99,235,.3),transparent 120px,transparent calc(100% - 120px),rgba(37,99,235,.22)),
 linear-gradient(180deg,rgba(37,99,235,.24),transparent 90px,transparent calc(100% - 90px),rgba(37,99,235,.18));
 transition:box-shadow 450ms ease;animation:piAgentBreathe 3.8s ease-in-out infinite}
#pi-agent-glow *{pointer-events:none}
#pi-agent-glow[data-mode="user"]{box-shadow:inset 0 0 0 1px rgba(59,130,246,.65),inset 0 0 32px rgba(59,130,246,.4),inset 0 0 72px rgba(59,130,246,.2);
 background-color:transparent;background-image:linear-gradient(90deg,rgba(59,130,246,.16),transparent 72px,transparent calc(100% - 72px),rgba(59,130,246,.16));animation:none}
#pi-agent-glow[data-mode="user"]>span,#pi-agent-glow[data-mode="user"] .pi-agent-dots{display:none}
#pi-agent-glow>span[data-side]{position:absolute;background:rgba(29,78,216,.34)}
#pi-agent-glow>span>i{position:absolute;display:block;background:linear-gradient(90deg,transparent,#3b82f6 30%,#fff 45%,#fff 55%,#3b82f6 70%,transparent);filter:drop-shadow(0 0 4px #3b82f6) drop-shadow(0 0 14px #3b82f6)}
#pi-agent-glow>span[data-side="top"],#pi-agent-glow>span[data-side="bottom"]{left:0;right:0;height:1px}
#pi-agent-glow>span[data-side="top"]>i,#pi-agent-glow>span[data-side="bottom"]>i{top:0;left:0;width:32%;height:100%;animation:piAgentRunX 2.4s linear infinite}
#pi-agent-glow>span[data-side="top"]{top:0}
#pi-agent-glow>span[data-side="bottom"]{bottom:0}
#pi-agent-glow>span[data-side="bottom"]>i{animation-direction:reverse;animation-delay:-1.2s}
#pi-agent-glow>span[data-side="left"],#pi-agent-glow>span[data-side="right"]{top:0;bottom:0;width:1px}
#pi-agent-glow>span[data-side="left"]>i,#pi-agent-glow>span[data-side="right"]>i{top:0;left:0;width:100%;height:32%;background:linear-gradient(180deg,transparent,#3b82f6 30%,#fff 45%,#fff 55%,#3b82f6 70%,transparent);animation:piAgentRunY 2.4s linear infinite}
#pi-agent-glow>span[data-side="right"]{right:0}
#pi-agent-glow>span[data-side="right"]>i{animation-delay:-.6s}
#pi-agent-glow>span[data-side="left"]{left:0}
#pi-agent-glow>span[data-side="left"]>i{animation-direction:reverse;animation-delay:-1.8s}
#pi-agent-glow .pi-agent-bloom{position:absolute;inset:0;pointer-events:none;opacity:0;transform:scale(1.35);transform-origin:center;
 background:radial-gradient(ellipse at center,transparent 26%,rgba(37,99,235,.18) 60%,rgba(29,78,216,.72) 100%);
 animation:piAgentBloomPulse 6.8s cubic-bezier(.4,0,.6,1) infinite}
#pi-agent-glow[data-mode="user"] .pi-agent-bloom{display:none}
@keyframes piAgentBloomPulse{0%,100%{opacity:0;transform:scale(1.35)}20%,52%{opacity:1;transform:scale(1)}74%{opacity:0;transform:scale(1.35)}}
#pi-agent-glow .pi-agent-dots{position:absolute;inset:0;pointer-events:none;opacity:.34;
 background-image:radial-gradient(circle,rgba(255,255,255,.98) 0 1px,rgba(147,197,253,.82) 1.6px,transparent 3.4px),
 radial-gradient(circle,rgba(219,234,254,.85) 0 .8px,rgba(96,165,250,.6) 1.4px,transparent 2.8px);
 background-size:19px 19px,31px 31px;background-position:0 0,9px 13px;
 filter:blur(.3px) drop-shadow(0 0 2px rgba(96,165,250,.95)) drop-shadow(0 0 7px rgba(37,99,235,.7));
 -webkit-mask-image:radial-gradient(ellipse at center,transparent 28%,#000 80%);
 mask-image:radial-gradient(ellipse at center,transparent 28%,#000 80%)}
@keyframes piAgentBreathe{0%,100%{opacity:.9}50%{opacity:1}}
@keyframes piAgentRunX{from{transform:translateX(-100%)}to{transform:translateX(312.5%)}}
@keyframes piAgentRunY{from{transform:translateY(-100%)}to{transform:translateY(312.5%)}}
@media (prefers-reduced-motion: reduce){#pi-agent-glow{transition:none}#pi-agent-glow,#pi-agent-glow>span>i,#pi-agent-glow .pi-agent-dots,#pi-agent-glow .pi-agent-bloom{animation:none}}`;

export function agentGlowOn(mode: "idle" | "agent" | "user"): string {
  return `(() => {
  const ID = "pi-agent-glow", STYLE = "pi-agent-glow-style";
  let style = document.getElementById(STYLE);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE;
    style.textContent = ${JSON.stringify(AGENT_GLOW_CSS)};
    (document.body || document.documentElement).appendChild(style);
  }
  let frame = document.getElementById(ID);
  if (!frame) {
    frame = document.createElement("div");
    frame.id = ID;
    for (const side of ["top", "right", "bottom", "left"]) {
      const runner = document.createElement("span");
      runner.dataset.side = side;
      runner.appendChild(document.createElement("i"));
      frame.appendChild(runner);
    }
    const bloomLayer = document.createElement("div");
    bloomLayer.className = "pi-agent-bloom";
    frame.appendChild(bloomLayer);
    const dots = document.createElement("div");
    dots.className = "pi-agent-dots";
    frame.appendChild(dots);
    (document.body || document.documentElement).appendChild(frame);
  }
  frame.dataset.mode = ${JSON.stringify(mode)};
})()`;
}
export const AGENT_GLOW_OFF = `(() => {
  for (const id of ["pi-agent-glow", "pi-agent-glow-style"]) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }
})()`;
