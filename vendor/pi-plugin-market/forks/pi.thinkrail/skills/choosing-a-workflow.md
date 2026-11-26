---
name: choosing-a-workflow
description: "Use FIRST for every new request. At the first request in a project session, automatically set up an existing codebase with no durable spec graph before handling the request; then resume it. Not for routed continuations."
---

> 移植自 JetBrains/ThinkRail 的 `packages/pi-thinkrail-workflow/skills/choosing-a-workflow`（MIT）。

# Choosing a Workflow

The root router of the workflow family, shipped in this plugin's `skills/` directory. It classifies the incoming
work and names the workflow skill that governs it — nothing more. A routed skill's steps live in that
skill alone; read it, don't run it from memory.

## Project-session preflight

At the first user request in a session attached to a project, inspect the project state before acting on
that request. A durable spec graph is one or more non-temporary Markdown specs with non-empty `id` and
`type` frontmatter; ignore task-specs under `.thinkrail/context/` for this check.

`spec_validate` is that inspection, in one read-only call: its first line is `[thinkrail-state] specs=N`.
Call it before your first action in a session that changes anything or runs a command — the plugin's
`tool_call` gate refuses those tools until it sees that answer, and keeps refusing when N is 0 and no
onboarding skill has been loaded. A refusal is not a dead end: it names the exact next call.

- **Existing source code, no durable spec graph:** onboarding is automatic and takes priority over the
  first request, whatever the request asks. Read and follow `setting-up-a-project`, which routes this
  code-only project to `importing-a-codebase`. Do not first answer a question, research another topic, or
  implement the requested change. After the initial graph is complete, return to the original request and
  handle it normally by classifying it below.
- **A durable spec graph exists:** do not run onboarding automatically; classify the request below.
- **No project is attached:** this is not a spec-less project session; do not infer a workspace or start
  onboarding.

If onboarding is already in progress, continue its active workflow without restarting this preflight.

## Classify

Read the request and the workspace, then answer four questions — usually silently, from what is already
in front of you:

1. **Is this project onboarding?** No durable spec graph yet — an empty (or effectively empty) workspace
   where the user brings a raw idea, or an existing codebase being set up / specced for the first time.
2. **Is this the PR lifecycle?** Finished work shipping as a pull request, or an existing PR being
   tended — created, brought up to date, given screenshots, its checks watched, its review comments
   addressed. Fixes that flow from a PR's own review comments belong here, not to feature work.
3. **Is this spec-graph maintenance?** A durable graph exists and the ask is to complete or repair it —
   fill in a missing spec or architecture doc, refresh stale or duplicated content, fix dangling links —
   with no behavior change.
4. **Does the work create or change anything in the project?** A new feature, added functionality, a
   behavior change, a nontrivial design decision — anything that alters what the project is or does.

Apply the first matching row below. Dedicated onboarding, PR and graph-maintenance routes take
precedence over the general project-change row.

| Classification | Route |
|---|---|
| Project onboarding — no durable spec graph: an empty workspace with a raw idea, or an existing codebase to set up / spec | Read and follow **setting-up-a-project** — a dispatcher that routes on the workspace's state |
| The PR lifecycle — finished work to ship as a pull request, or an existing PR to tend: create, bring up to date, screenshots, checks, review comments | Read and follow **shipping-a-pr** |
| Spec-graph maintenance — a durable graph exists and the ask is to complete or repair it, with no behavior change | Read and follow **extending-a-spec-graph** |
| Other work creates or changes the project — a new feature, added functionality, a behavior change, a nontrivial design decision | Read and follow **brainstorming** — however small it looks; that skill owns the "too small" judgment |
| Anything else — answering questions, explaining code, running commands or checks, work that changes nothing | **No matching workflow.** Say so in one line (e.g. "No workflow skill covers this; proceeding directly.") and proceed with your own judgment. Never stretch a route to fit — a forced route is worse than none. |

An audit-only request (including checking a graph and reporting gaps) changes nothing: use the direct
reporting route above, with no repair plan or approval round. Route to graph maintenance only when
repairs are requested.

One route per piece of work. If the request combines automatic onboarding with another task, complete
the initial graph first, then return to the original request and classify it using the table. If a
request bundles different non-onboarding work (e.g. "explain X, then change Y"), route the part that
changes the project and handle the rest directly.

If the route is genuinely ambiguous from the request alone, ask one short clarifying question
(`ask_user_question`, composed per the **asking-user-questions** concept skill) rather than guessing.

## Red flags — stop and re-route

- You started designing or editing before naming a route — routing comes first.
- You followed a route from memory instead of reading the relevant skill.
- You classed a change as "anything else" because it looked small or mechanical — size is
  brainstorming's call, not the router's.
- You treated a temporary task-spec under `.thinkrail/context/` as proof that initial project onboarding is complete.
- You finished automatic onboarding but failed to return to the user's original request.

## Handoff

This skill ends by naming exactly one of: **setting-up-a-project**, **extending-a-spec-graph**,
**shipping-a-pr**, **brainstorming**, or **no matching workflow** (proceed with judgment). Adding a workflow to the family adds a row to the table above —
see the **writing-workflow-skills** skill.
