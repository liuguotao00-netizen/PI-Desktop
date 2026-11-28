# ThinkRail for PI-Desktop — Changelog


## 1.7.1

- **The gate no longer waits for a failure it can never see.** PI-Desktop returns a plugin tool's `{ error }` payload as a *successful* result — the session records `status: success` and `result.isError: false`, and `plugin.log` says `ok: true` — so `spec_validate` answering `{"error": "No workspace is open"}` looked like an ordinary result. No `[thinkrail-state]` line, no `isError`: `state.checked` stayed false and every work tool stayed refused for the whole session. The fail-open path added in 1.6.0 could not fire in exactly the case it exists for. Verified on 0.22.0 against a session with no workspace open; the same `{ error }` → success mapping is in the 2026-11-05 session history, so it is a long-standing host contract rather than a 0.22.0 regression.
- **`spec_validate` now decides on its own evidence.** A strict first line `[thinkrail-state] specs=N` records the graph, as before. Any other outcome — an error, no workspace, an unregistered tool, rejected arguments, a missing state line — opens the gate for the rest of the session. An errored result never records a graph, even when its body happens to contain a state line.
- **The refusal fuse stays at 16.** It is a backstop for a model that ignores the gate, not the recovery path: a burst of parallel work tools in one turn must not trip it, and the evidence rule above is what recovers a session that cannot validate.
- Nothing else about the gate changes: read-only tools, `Skill`, questions, todos and the spec read tools still pass, unknown tool names still pass, and 0 durable specs still requires onboarding before the project is changed. Tests pin the fail-open path, the no-record-on-error rule and the 16-refusal fuse.

## 1.7.0

- **New worker: `extending-a-spec-graph`.** Partial graph → complete graph no longer falls between the two setup workers. The dispatcher names the route instead of saying "no skill covers it": audit the gaps with evidence, propose the repair in one task-spec, approve once, repair root → architecture → modules, then validate. It documents what the system *is*; an ask that turns out to need behavior design leaves for `brainstorming` with one line saying why. The root router gains the matching classification row and names the skill in its handoff.
- The gap table carries its own guardrails: `specs=N` is not the score (merging two wrong nodes into one right node is progress with the count going down), and a directory without a `SPEC.md` is not a gap — the boundary has to be genuine.
- Duplicate ids are renamed per file (`spec_update` refuses id changes); each inbound reference is checked for its intended target. Links to the retained id stay, confirmed links to the renamed node move, and ambiguous references are reported unresolved.
- **`spec-graph` and `writing-specs` stop restating each other.** `spec-graph` keeps the graph — nodes, frontmatter, link kinds, status values, the seven tools; `writing-specs` becomes the single home for spec content (short / honest / on-rails, the edges that matter, and which evidence permits a status move). The "reach for the spec tools first" trigger stays where the host prompt reads it.
- **Meta-rule 16 replaces hit-counting.** A candidate earns a skill by naming the flow that falls short, its unique steps or gate, its outside reach, its ending, and the duplication it removes. Frequency is evidence, never a threshold, and the router records nothing — a read-only request never writes to the repository. The composer stays what the concept model calls it: a stateful router.
- Graph maintenance owns its approval across the router, brainstorming, meta-rules and project specs; onboarding and PR keep their workflows. Audit-only requests end with findings. Repairs compare with the validation baseline, fix newly introduced errors and leave unrelated baseline issues reported outside the approved scope. Spec granularity belongs to `writing-specs`.
- Tests compare the skills directory with manifest declarations and check that skill handoff references resolve; formatting and heading assertions do not stand in for routing behavior.
- `workflow-verification.md` provides isolated manual host scenarios, approval/rejection checks and a raw-evidence record format. It is an executable verification path, not an observed run; family rows remain `unverified by use`.
- Gate evidence now recognizes exact host-prefixed ThinkRail names and accepts graph counts only from a successful validate result's strict first line. Onboarding requires a successful exact Skill id; failed or similar calls do not unlock work.
- ID lookup includes drafts and refuses ambiguous candidates consistently across get/update/delete; creation checks all ids. Plugin mutations serialize, reread fresh content and reject detected external conflicts. Permission errors cannot imply an absent file. Host overwrite writes still leave an external-writer race after the last check.
- YAML aliases retain existing list members during edits; ordinary YAML object arrays no longer crash indexing. Directory caps, depth limits and unreadable portions mark the index incomplete; tools and panel cannot claim full validity from partial coverage.
- Panel state is isolated per project, checked around I/O and discarded after observed switches. Hint polling discovers idle project/content changes; failures retain a visible stale snapshot and retry throttle. Late renderer responses cannot replace newer state, and parent cycles remain visible.
- PR compound requests track remaining phases, creation owns its prerequisite rebase, and direct screenshot requests establish a clean or isolated fixed head/base capture environment.
- Host fixtures fix ASAR extraction, resolver dependencies and error-code forwarding; load tests have bounded waits. Full local suite: 85 passed, 0 skipped (42 core, 12 engine, 13 gate, 13 panel, 5 installed-host checks). Model-driven PR flows remain unobserved.

## 1.6.0

- **First-session onboarding is now enforced, not advised.** The standing rule was the only entry point, and a prompt paragraph is advisory: the agent could read it and still answer the request or edit code without ever routing. That is why 1.5.x could not guarantee "no spec graph → `setting-up-a-project`". The same module now also runs a `tool_call` gate — the host refuses that call, so the model cannot route around it.
- Gate rule 1: until the session has called `spec_validate`, every work tool (`bash`, `edit`, `write`, `multitool`-style edits, `task`, `browser`, `spec_create/update/delete`, …) is refused, and the refusal names `spec_validate` as the next call.
- Gate rule 2: once `spec_validate` reports 0 durable specs, work stays refused until the `setting-up-a-project` skill has been loaded — onboarding outranks the request, whatever it asks. Loading only the root router is not enough for an empty graph.
- `spec_validate` now leads with a machine-readable `[thinkrail-state] specs=N` line (durable count, `.thinkrail/context/` drafts excluded) and names the onboarding route when N is 0. The rule block carries the recorded state into the next turn, so the decision is not left to the model's memory.
- Fail-open, by design: read-only tools, `Skill`, questions, todos and the spec read tools always pass; unknown tool names pass; a spec-tool error (no project attached) or 16 consecutive refusals open the gate for the rest of the session. A gate that can wedge a session would be worse than no gate.
- Docs, meta-rules (12b) and tests updated together: the hook set, both gate states, the state line, the fail-open paths and the fuse are all pinned; the module is still import-free, filesystem-free, network-free.

## 1.5.2

- The spec-graph no longer counts a `brainstorming` draft as project state. `task-spec` files under `.thinkrail/context/` were being indexed as ordinary specs, so a code-only project holding nothing but a draft read as "durable spec graph present" and the router's automatic first-session onboarding was skipped. `spec_graph`, `spec_grep`, `spec_validate` and the panel now share the rule's definition of durable: a draft is not a graph.
- Drafts stay fully usable: `spec_create` still writes into `.thinkrail/context/`, and `spec_update` / `spec_delete` still resolve them by id, because those read the full scan rather than the graph.
- Cover both halves in tests: a project holding only drafts has an empty graph, and a real spec still counts while its draft stays writable and addressable.

## 1.5.1

- Deliver the standing workflow rule over whichever channel the running host actually reads. PI-Desktop 0.20.x replaced the extension runner: `emitBeforeAgentStart` now hard-codes `systemPromptOptions` to `{}` and its merger only reads a returned `systemPrompt`, so writing `sections[name]` had become a silent no-op. That is why the router stopped firing: the plugin still loaded, but the rule never reached the model.
- Keep the section channel first for hosts that still expose a section map (PI-Desktop 0.15.x-0.19.x and upstream pi); with no map, append the same rule, wrapped in `<pi-thinkrail-workflow>` tags, to the end of the system prompt and return the combined string. The host prompt is preserved, never replaced, and the append is idempotent.
- Cover both channels in tests: a host with a section map still gets no returned `systemPrompt`, a host without one gets the appended block, an already-appended rule is not appended twice, and an empty or non-string prompt is left alone.

## 1.5.0

- On the first request in an attached project session, automatically run project setup/import before handling the request when source code exists but no durable spec graph is present.
- Ignore temporary task-specs under `.thinkrail/context/` when determining whether initial onboarding is complete.
- Skip automatic onboarding when a durable graph already exists or no project is attached; after import, resume the original request in the same session.
- Restore specs-before-code lookup and the pre-#485 broad workflow entry: every new request reaches the router, and every project change enters brainstorming regardless of size or how fully specified it is.
- Require explicit approval of the brainstorming task-spec design before writing durable SPEC files or implementation source.
- This repository does not contain the upstream `pi-todos` package, tools, or skills; TODO planning behavior is outside this plugin's scope.

## 1.4.1

- Inject the standing rule through the host's named prompt section without replacing the full prompt.
- Align spec indexing order, ignored-directory checks, path resolution, and tool risk metadata with the host/upstream contracts.
- Support PI-Desktop 0.15.6 and newer.
- Add host-bundle symlink containment coverage for the real path resolver.
