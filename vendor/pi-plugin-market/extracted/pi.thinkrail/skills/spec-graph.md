---
name: spec-graph
description: "Use first when exploring a project, investigating an area, planning or starting a task, implementing a change, or checking recorded decisions. Find and read relevant specs before code; also create and maintain specs."
---

# Spec graph

> 移植自 JetBrains/ThinkRail 的 `packages/spec-graph/skills/spec-graph/SKILL.md`（MIT）。
> 工具名、语义与约束与上游一致；`read` / `write` / `edit` 用 DSH 自带的同名工具。

## Specs are the ground truth

- Specs describe the architecture, decisions, contracts, and boundaries behind the code — the intent
  that the code alone does not reveal. Treat them as authoritative.
- **Reach for the spec tools first.** Whenever you set out to explore the project, plan a change,
  investigate an area, or work with specs in any way, first use `spec_grep` / `spec_get` / `spec_graph`
  before `grep`, `find`, or reading source. The specs are the map; code is the territory you confirm.
- **Start from the specs, not the code.** To understand an area or plan a change, read relevant specs
  first and use them as the map; read code second to confirm details.
- **Check work against them.** Before introducing a decision, contract, or boundary change, find what the
  specs already say and align with it. If a change contradicts a recorded decision, surface the
  contradiction and reconcile it — update the spec or change the approach — rather than silently diverging.
- **Keep them honest.** A change that moves or blurs a boundary, or overturns a decision, updates the
  spec as part of the same change. Specs that drift from the code stop being ground truth.

What a spec's prose may contain — how short it runs, where rationale lives, how unconfirmed content is
marked, what evidence lets a claim leave `draft` — is the **`writing-specs`** concept's ground, and the
family's rules for spec content accrue there. This skill owns the graph itself: nodes, frontmatter, links,
and the tools that move them.

## The graph

- `parent` links form the hierarchy between spec nodes. Root documents sit at the repository root;
  a module spec sits beside the module it describes. Which boundaries need their own spec is governed
  by `writing-specs`.
- `depends-on`, `references`, and `implements` form a dependency layer across the tree.

## Frontmatter

- Required: `id` (a unique slug), `type`, `title`.
- Optional: `status` (lifecycle), `parent` (single link), `depends-on` / `references` / `implements`
  (link lists), `covers`, `tags`.
- A file is a spec when its frontmatter carries `id` and `type`.
- `status` values: `draft` (being written), `active` (in force), `stale` (drifting from the code), `done`,
  `deprecated`. Optional; which evidence permits a move between them is `writing-specs`' call.
- Types:
  - `goal-and-requirements` — the product goal and scope; the root of the graph.
  - `architecture-design` — system-wide topology, cross-cutting decisions, and invariants.
  - `module-design` — a package or module's responsibility and boundary.
  - `submodule-design` — the same, for a directory-level module inside a package.
  - `task-spec` — a temporary working document for a piece of work; not durable, and removed once the
    work lands.

## Tools

Read:
- `spec_grep` — search within specs (content, narrowed by metadata filters).
- `spec_get` — a spec's frontmatter, its resolved links, and its path. Read the body with the normal
  `read` tool using that path.
- `spec_graph` — a bounded slice of the graph: a subtree, ancestors, or a node's neighbors, to a depth.

Manage:
- `spec_create` — a new spec with scaffolded frontmatter and headings.
- `spec_update` — a spec's frontmatter (fields and links). It does not touch the body, and it refuses to
  rename an `id`.
- `spec_delete` — remove a spec.
- `spec_validate` — report dangling links, duplicate ids, and parent cycles.

Prose is written and edited with the normal `write`/`edit` tools; the spec tools own frontmatter and
structure.

## Working with specs

Norms, not a procedure: the order a piece of work runs in belongs to the workflow you are in.
- **Orient** with `spec_graph` / `spec_get` / `spec_grep` before reading source.
- **Align** — surface a contradiction with a recorded decision before diverging.
- **Update in the same change** — frontmatter and links with `spec_update`, prose with `edit`, a new
  module with `spec_create`.
- **Check** with `spec_validate` after structural changes.
