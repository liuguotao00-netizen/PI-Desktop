# Changelog

## 0.2.7

- Slash commands work right after installation, and stay current: on load the plugin
  writes the `/stop-that-shit` and `/sts` composer templates into `~/.pi/agent/prompts`
  and replaces either one when the shipped text changed, so an upgrade reaches users who
  never run the installer. The displaced text is kept once as a `.md.bak` copy.
- `npm run prompts:desktop` performs the same write from a checkout.

## 0.2.6

First release on the plugin center.

- `别再造史了` joins the `+ 新建` menu as a sidebar view; the command opens the view
  first and falls back to the standalone panel window when the host cannot reveal it.
- The panel toolbar carries an `EN` / `中` switch. The choice is remembered locally and
  overrides the host locale until you switch back; reason codes, tool names, and policy
  values keep their recorded form.
- The session table scrolls horizontally instead of clipping its last columns.
- Doctor rows explain themselves in the selected language, including the record counts,
  damaged-file count, stale locks, and registration time.
- Plugin id is `io.github.techd81.stop-that-shit`, so the data directory becomes
  `%USERPROFILE%\.pi-desktop\plugins\data\io.github.techd81.stop-that-shit`. A previous
  `local.stop-that-shit` data directory is not migrated automatically; copy it over to
  keep the existing audit history.
- Host audit records now report the real host family instead of `other`, and a read-only
  contract is no longer bypassed by `npm i`, `pnpm add`, `yarn add`, `bun add`, or
  `uv add`.
- A mistyped `/sts explain evt_…` no longer persists a directive error that used to
  refuse every later `Task` call in the session.
- The panel and `/sts doctor` survive a damaged or non-directory data path instead of
  failing to render.

## Earlier development

- 0.2.5 — upstream decision core and the 24 Bad/Good evaluation cases.
- PI-Desktop port — desktop adapter (hooks, tool classifier, panel, doctor, prompt
  templates), the sidebar view, and a 223-case test suite.
