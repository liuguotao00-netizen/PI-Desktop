# PI-Desktop Session Titles

An independent PI-Desktop plugin that replaces a new session's first-prompt title with a concise, model-composed title after the first completed turn. The prompt template, model, and thinking level are configurable from the plugin panel.

## What it does

- Uses the first user prompt and first assistant reply, each bounded by the host to a small excerpt.
- Sends one one-shot completion through PI-Desktop's plugin model API. The plugin never receives provider credentials.
- Upgrades the deterministic 48-character fallback the core already derived from the first prompt. The host applies the upgrade only while the session still carries that exact automatic title, so a manual rename always wins the race.
- Leaves every title it cannot improve: a session the user renamed, a session that already received a generated title, and a host that never reported an eligible title stay untouched.

The prompt template supports `{{userPrompt}}` and `{{assistantReply}}`; it must include `{{userPrompt}}`. Leave the model blank to follow the session model, then fall back to the default ready model. Unsupported thinking levels fall back to `off`.

## How it fits the core title

A session is readable with or without this plugin. Sending the first prompt makes PI-Desktop write a whitespace-collapsed, 48-character fallback derived from that prompt, and it keeps that text as a *replaceable* automatic title. This plugin is the optional second layer that turns the label into a model-composed title; it is not what creates the label.

`expectedTitle` in the `session.autoTitle` context is therefore the current derived text rather than a localized placeholder like "New task". Pass it back unchanged to `setAutoTitle`; the host refuses the update when the title moved on in between.

Titles of remote sessions are derived and owned by the host that runs them, and a native Pi session keeps its own title, so this plugin upgrades ordinary local desktop sessions.

## Permissions

The manifest requests `session.autoTitle` for the narrow first-turn context and compare-and-set title update, `agent.complete` to run a one-shot completion, `models.list` for the model selector, and `ui.panel` for its settings window. The plugin does not request full transcript access, filesystem access, network access, or credentials.

Each eligible completed turn may consume one completion from the selected model. Only one attempt runs per session at a time; the plugin skips aborted and failed turns. Existing sessions with custom or previously generated titles remain unchanged. Its private settings are stored with the plugin by PI-Desktop.

## Install

Requires PI-Desktop 0.18.0 or newer, which provides the narrow automatic-title plugin API and the core first-prompt fallback. In PI-Desktop, open **Plugins → Load development plugin** and select this directory. Grant the requested permissions, then run **Session Titles: Configure** from the command palette.

This plugin is licensed under LGPL-3.0-or-later; see [LICENSE](LICENSE).

## Test

```sh
npm test
```

This repository has no runtime dependencies.
