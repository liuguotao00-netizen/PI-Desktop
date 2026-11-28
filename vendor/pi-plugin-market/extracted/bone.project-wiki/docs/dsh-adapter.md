# DeepSeek Harness adapter contract

## Scope and tested runtime

The optional `adapters/dsh` package targets DeepSeek Harness 0.2.2-rc.1 and Node >=24.9.0. Adapter 0.2.1 is independent of PI knowledge 0.4.1. Native React session-scoped Slots mount the original PI renderer, with a sidebar guide before the first message and an additive conversation view. A compact title badge displays only the current client's plugin version: `v0.2.1` in DSH or `v0.4.1` in PI.

Agent memory writes use the shared `maintainMemory` assessment gate; low-value, temporary and duplicate outcomes do not persist. The native panel remains an explicit manual editing surface. Chinese conceptual memory titles are independent of original source titles; see [quality admission](memory-maintenance.md).

No PI host APIs are emulated globally. The adapter supplies a private host-shaped seam to the common WikiService. The existing PI entry, extension, tool declaration and packaging retain their contracts. The shared declaration is extracted into `tool-contract.cjs` without altering the PI schema.

## Authority and persistence

Every operation receives a Gateway-resolved or tool-execution Agent. The immutable `agent.session.header.cwd` fixes the project; foreground navigation and mutable operation cwd do not select it. Request workspacePath is an expected-context assertion. Agentless calls fail closed. The Gateway handles authentication, strict wire envelopes, Agent lookup and cancellation. The custom Remote additionally accepts owner principals only. Wiki input types and bounds are validated before dispatch, and errors expose bounded machine codes rather than raw provider paths or document content.

Knowledge reads and mutations use the Agent's scoped `ctx.fs`. Paths are relative to `.bone-project-wiki`, normalized, bounded and checked for canonical containment; linked wiki components are refused. File versions are opaque and invocation-local. Body reads check provider versions before and after reading. Writes create only absent files or replace exactly observed versions; deletes preserve the observed source guard. Existing common final revision checks, capacity checks and verified readback remain enabled. Single-file publication is atomic through the provider; remember, rename, import and index updates are not multi-file transactions.

Published write versions stay pinned through readback, and a readback mismatch never authorizes overwriting a competing writer. Binary windows use one pinned provider version across chunks. Loose-file revisions hash the provider's opaque version when available, and that observation also fences deletion. Hosts without file versions keep their existing revision shape; no fabricated mtime is introduced.

Mutations resolve the current session sandbox policy and pass it to the provider. Read-only and out-of-root writes fail even on the bare local backend. Missing policy on a confining provider fails closed. Knowledge writes never fall back to Node fs, shell commands or silently elevated execution. Derived index writes may fail without preventing a read; their metadata never becomes source authority. DSH exposes no mtime, so the adapter omits it and verifies actual bodies.

Record schema version 1, stable recordId, Chinese paths, title-driven names, document content hashes and source-linked memory remain compatible with PI. There is no migration and no preferences transfer. Different projects use independent queues; same-project operations retain FIFO and invocation identity. Shared preferences use DSH live settings with both common content revisions and settings revisions.

DSH's provider cannot delete directories. The adapter advertises `hostCapabilities.directoryDelete:false`, disables that UI action, and rejects it before deleting any content. Directory creation, individual file deletion and moves remain available. Web external open/reveal are disabled. Both hosts use the original 350 ms autosave, Markdown read/edit transition and document-linked memory editor.

## Memory lifecycle

Activation registers agent-scoped providers for existing and new agents. An accepted genuine-user pre-step prepares verified recalled facts plus the shared current-Agent maintenance workflow. The current session model reads memoryIndex and related actual sources before minimal tool-based consolidation. No literal candidates are persisted at settlement; completed/error hooks only invalidate preparation. Tool continuations preserve admitted-turn guidance and bounded initial/latest task paths. Rejection, error, disable and disposal clear the corresponding lifetime. See [maintenance and main-file contracts](memory-maintenance.md) and the [trigger audit](memory-trigger-audit.md).

Common selection and presentation preserve draft/status/scope isolation, actual source verification, full facts or full-read pointers, automatic 1200-character/six-entry/180-character-body limits, and manual 10000-character/sixteen-entry/1800-character-body limits. These are character budgets, not tokens.

Automatic preparation diagnostics reuse the common allowlist and validation: no raw prompt, title, body or arbitrary paths; at most 20 KiB each and ten per project. Writes use the provider and its deployment permissions. Context is re-read after diagnostic I/O before publication. Traces describe prepared context, not proof of model receipt or use. Forgetting reuses common reference cleanup and has no cross-process atomicity claim.

Host limits remain explicit: PI generic running-steering events lack proven genuine-user provenance, and DSH may retain previously accepted context after full provider unload. Configuration disable empties the still-registered provider. Consumed context cannot be revoked and committed records cannot be rolled back. Retiring settlement autosaves removes dependence on PI's early settlement boundary.

## Native UI and preview isolation

Each native React slot owns a ShadowRoot, lexical document/window boundary, original renderer state, requests, drafts, overlays and disposable resources. The build reuses the original two tabs, file tree, stylesheet and typography. DOM queries, form locks, drag/drop, locale, timers, readers and object URLs are scoped to that mount. Global pointer-release and outside-menu listeners are bounded and removed on disposal. The host document language and globals are not replaced.

Session identity comes from the slot's injected sessionId. Request generations and expected workspace protect late results; saves retain the editor node, focus, selection and newer typing. Hidden tabs continue protecting unsaved memory-summary drafts before reload. The original-style More menu exposes import, preferences, context and export normally supplied by PI window chrome. There are no additional main tabs.

The memory overview includes a collapsed main-file preview. `.bone-project-wiki/memory/MEMORY.md` is generated once at the end of a successful dirty project operation, preserves unowned/manually edited files and is excluded from memory records. The plan-safe memoryIndex action returns a fresh read-only projection. Additive mainMemory publication metadata distinguishes a committed record from an incomplete main-file update.

The Client requires host React only. Markdown uses the common safe renderer; a strict field projection supplies remember requests without persistence/display metadata. The imported HTML preview is the only iframe, with opaque-origin allow-scripts sandbox, no-referrer and the existing local-only CSP. XLSX previews are offline and read-only, retain file bytes and show cached formula values without evaluating formulas.

## Distribution and verification

`node scripts/build-dsh.mjs` produces a prebuilt package. The Client factory id matches package.json.name; package exports include the native Client, the shared strict Typert descriptor, English/Chinese metadata and an original SVG icon. No source map, tests, runtime dependency trees, credentials or private profile data belong in the archive.

`node scripts/build-dsh-index.mjs` emits a valid format-1 empty index while publication is pending. After an actual npm release, `--published` verifies exact registry name/version, timestamp, bundle declaration, runtime range and integrity metadata before creating an installable entry. Serve a verified index at a stable HTTPS URL and add it to Discover; DSH has no default central index. A local tgz is directly installable but is not a supported npm/Git index provenance source.

Acceptance covers the existing PI test suite and extension loader; DSH provider/tool/memory/permission/cancellation/conflict tests; native blank-session page initialization, save/read/search/linked memory/recall, editor identity, preferences, anonymous and cross-origin rejection, HTML sandbox and XLSX previews; isolated package install/restart; archive, locale and index validation. No real model/provider calls, paid APIs, user profile installation or verify:ui:* commands are required or used.

## Native Web acceptance command

Use an owned temporary profile with Chinese UI, authenticate a temporary browser context, and select the fixture project before saving its Playwright storage state. The test checks the expected project path before its first mutation. Storage state may include IndexedDB and must remain private. No model configuration is needed.

`DSH_HOME` isolates profile configuration, not the default project. DSH's default project can reside in the operating system Documents directory. Every mutating acceptance run must explicitly select and assert an owned temporary project; changing the profile or working directory alone is insufficient. Earlier 0.1.0 demonstration flows reached that default project, so their historical isolation statement is corrected in delivery records. Existing unknown files there are not modified or removed.

```sh
DSH_TEST_URL=http://127.0.0.1:38961 \
DSH_TEST_WORKSPACE=/absolute/path/to/temporary/project \
DSH_TEST_STORAGE_STATE=/absolute/path/to/private/browser-state.json \
DSH_TEST_OUTPUT_DIR=/absolute/path/to/temporary/artifacts \
python3 adapters/dsh/tests/native-flow.py
```
