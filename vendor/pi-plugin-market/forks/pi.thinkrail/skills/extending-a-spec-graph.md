---
name: extending-a-spec-graph
description: "Use when a durable spec graph exists and the ask is to complete or repair it — a missing doc, a stale node, duplicated content, dangling links — without changing behavior. Not for designing new work: use brainstorming."
---

# Extending a spec graph

A durable graph already exists and no longer matches the system: a module with no `SPEC.md`, an
`architecture.md` that predates the code, a node sitting `stale`, a dangling link, one fact written twice.
Repair the record — this worker owns approved repairs to an existing graph.

**Scope, before the first search.** This worker documents what the system **is**. Anything that decides
what it should become — a feature, a changed interface, a moved boundary, a new contract — belongs to
`brainstorming`, and this workflow stops and hands over the moment that shows up. A request that mixes
both is split, and the reply says which part lands here.

## 1. Audit — read only

Spec tools first (`spec_graph` from the root, `spec_get`, `spec_grep`), then code and existing docs to
confirm. Run `spec_validate` and retain its baseline diagnostics. Record each gap with its evidence:

| Gap | Evidence |
|---|---|
| Missing root or `architecture.md` | nothing describes the topology the code demonstrates |
| Module with no spec on a **genuine** boundary | a real responsibility or edge the code enforces, and no spec states it — never "this directory has no `SPEC.md`" (see `writing-specs`) |
| Stale node | the spec says X, the code does Y |
| Dangling link, duplicate id, parent cycle | `spec_validate` |
| Orphan | no `parent` and not a root document |
| Fact written twice | one decision restated in two specs |
| Rationale living in code | a paragraph that belongs in the owning spec |

`specs=N` is not the score. Merging two wrong nodes into one right node is progress with the count going
down; adding a `SPEC.md` per directory to make it climb is the failure this table exists to prevent.

If the request is only to audit or report, stop here with findings: no task-spec, repair or approval
round. For a repair request, continue with the approved scope; finding more gaps does not authorize them.

## 2. Propose the repair

One `task-spec` at `.thinkrail/context/TASK-extend-graph-<slug>.md` carries the plan: what gets added,
rewritten, merged, or removed, and which links move with it. Ask only what changes the outcome — usually
whether a boundary is real, or which of two nodes owns a fact — one round, per `asking-user-questions`.

## 3. Approve once

This worker owns its approval: present the gap table and the repair plan, wait for an explicit go-ahead,
and touch nothing durable before it. Approving the repair scope is not approving every inference in it —
what is inferred stays `draft` or marked unconfirmed, per `writing-specs`.

## 4. Repair

Order: root → `architecture.md` → module specs, so each child is written against a settled parent.
Prose goes through the normal `edit`/`write` tools; `spec_create` for a node that does not exist,
`spec_update` for frontmatter and links only.

- **Code can show drift; it cannot confirm intent.** A re-read proves the spec is stale. Coming back from
  `stale` to `active` also needs the owning intent confirmed, and the report says which of the two moved.
- **Duplicate ids are fixed per file.** `spec_update` refuses `id` in `set` (`Cannot rename a spec's id via
  set.`). Inspect every duplicate file directly, decide which keeps the id, and rename the other file's
  frontmatter. Determine each inbound reference's intended target individually: keep links to the file
  retaining the old id, migrate only those confirmed to target the renamed file. An ambiguous target
  stays unresolved and is reported for confirmation; never bulk-migrate all references. Structural
  validity alone cannot establish that a reference still has the right meaning.

## 5. Verify and report

Run `spec_validate` again and compare with the baseline. Resolve errors introduced by this repair;
fix existing errors only within the approved scope. Report each approved gap as resolved or unresolved
with its reason, plus out-of-scope baseline diagnostics, ambiguous references, and draft/unconfirmed
content. An unresolved approved item makes the repair partial or blocked, not complete. A scoped repair
can finish with unrelated baseline errors still present; never claim the whole graph is clean in that
case. Retire the task-spec when the scoped work ends, retaining the unresolved list in the report.

## Ending

Hands back to its caller (`setting-up-a-project`), or ends here when it was entered directly. An ask that
turns out to need behavior design leaves through `brainstorming`, with one line saying why.
