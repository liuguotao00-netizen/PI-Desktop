# ADR: Browser-level agent control and a non-CDP evaluate path

- Status: Accepted
- Date: 2026-11-24

## Context

Agents drive the built-in browser (`pi.browser.*`) from three callers: the
bundled `Browser` tool, first-party plugins, and scheduled tasks. Before this
change there was no way for the user to intervene: an agent kept driving the
page while the user watched, and a plugin could not tell which session it was
driving, so per-session state fell back to a process-wide default.

Automation against risk-sensitive sites also needed an execution path that does
not attach the DevTools debugger, because `Runtime.enable` and friends are
observable by the page.

## Decision

1. **Control state is per session and lives in Electron main**
   (`browser-agent-control.ts`): `idle`, `agent`, `user`. Every browser
   operation that drives the page enters `agent`; the session's turn keeps it
   there between operations (`noteTurnStarted` / `noteTurnEnded`), and only the
   end of the turn or an explicit stop returns it to `idle`. View plumbing
   (`setBounds`, `setVisible`, `getState`, `reveal`) is excluded so the bar does
   not flicker.
2. **The gate sits in the generic plugin host-api dispatcher**, not in the MCP
   child and not only in `invokeBrowser`. Any plugin that holds `browser.cdp`
   may name its session, and every driving method is wrapped by
   `assertAgentMayOperate` / `beginOperation` / `endOperation`.
3. **User actions have defined side effects.** Takeover enters `user`,
   aborts the running turn through the same channel as the composer's stop
   button (`pi-desktop/agent/abort`), and blocks further browser work with
   `HANDOFF_REQUIRED`. `stop` gracefully stops the turn (`agent/stop`) and
   returns to `idle`. `handBack` returns to `agent` while the turn still runs
   (otherwise `idle`) and never auto-resumes work. `reset` clears an idle hold
   left by a closed tab.
4. **The control bar is a native overlay view**, not page DOM and not panel
   HTML: a 360×56 transparent `WebContentsView` mounted above the site view,
   bottom-centred over the page. Its buttons report through `console-message`;
   the host binds them to the control state machine. The panel bridge channel
   (`browser.getAgentControl` / `setAgentControl`) and its `onPanelInvoke`
   forwarding were removed with the old in-panel bar.
5. **Ownership effect is injected into the visible page** (`browser-agent-glow.ts`):
   four-edge light sweep, breathing vignette, an inward curtain pulse and an
   irregular white dot field, in
   qiwork's `agentBrowserFrame` palette. It is `pointer-events:none`, removed on
   `idle`, and re-asserted every 3 s so navigation restores it.
6. **`pi.browser.evaluateNative` uses `webContents.executeJavaScript`** and
   attaches no debugger. Snapshot keeps CDP because the accessibility tree has
   no non-CDP equivalent.

## Consequences

- Takeover interrupts the whole turn, not only browser work. This is the cost of
  "immediate interrupt" and is stated in the control bar copy.
- A submission already sent to the renderer cannot be withdrawn; only later
  operations are refused.
- Plugins that forget to pass `sessionId` are still gated, but under the
  `default` key. Because the plugin view reports bounds without a session, the
  visible page is often keyed `default`; the host therefore also pushes control
  state to the active page when no page matches the event's session.
- Automation runs stop at their next browser operation and are recorded as
  `cancelled` with `HANDOFF_REQUIRED`, rather than blocking the queue.

## Alternatives

- Gate only inside `invokeBrowser`: rejected — plugin tool calls reach the host
  through the generic host-api dispatcher and never touch `invokeBrowser`.
- In-panel control bar: removed — the site view paints above panel HTML, so the
  bar could only live in a strip outside the page.
- Page-injected control bar: rejected — it adds interactable DOM to the site
  (detection surface); only the pointer-events-none effect is injected.
- Auto-resume the agent on hand-back: rejected — the user just took control; a
  silent resume would repeat the surprise.
