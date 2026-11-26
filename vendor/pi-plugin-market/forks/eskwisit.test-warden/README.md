# Test Warden for PI-Desktop

Test Warden keeps unit tests in step with your code, whatever test framework the project uses:

1. **Did behaviour break?** It runs the tests that cover a change on the old code and on the new
   code. A test that passed before and fails now is reported as a regression.
2. **Would the tests even notice?** It fills real gaps with a dedicated test-writer sub-agent, and
   keeps a new test only if it can fail:
   - for a fix or feature, it must fail on the old code;
   - for a new suite, it must fail with the code under test emptied out.
   Every new test must also pass 3 times in a row on the current code.
3. **Create a test suite for a file.** It writes a suite for the file and **never changes that
   file**. A bug it finds is **reported** with a failing test that reproduces it. It is not fixed.

It is built for low token cost. Deterministic plugin tools read the project, map changes to tests,
compare runs and filter tests, so the agent only reads short structured results. Most changes spawn
**no** sub-agent at all.

## Framework-agnostic

Test Warden contains no table of frameworks. It uses what the project itself declares:

| It needs | It takes it from |
|---|---|
| The test command | The project's declared scripts: `package.json` `scripts.test*`, `deno.json` tasks, `composer.json`, `Makefile`/`Justfile` `test` targets, `tox`/`nox`, `go test`, `cargo test`. Also the test steps of its CI (GitHub Actions, GitLab, CircleCI, Azure, Bitbucket, Travis, Jenkins). The agent **runs it once to verify** it, works out the per-file form if the runner has one, and pins the result. If nothing is declared, it asks you once. |
| Which files are tests | Test globs found in the project's own config (e.g. `angular.json` `include`, `testMatch`, a `tsconfig.spec.json`), then the naming its existing tests follow (`*.spec.ts`, `*_test.go`, `test_*.py`, `*Test.java`, `*_spec.rb`, …). Cross-ecosystem conventions are used only for a cold start. |
| How to run one test | A per-file command with `{file}`, a per-directory command with `{dir}`, or the whole suite (slower, but works with any runner, e.g. Karma). |

Karma/Jasmine, Jest, Vitest, Mocha, pytest, RSpec, PHPUnit, JUnit, `go test`, `cargo test`, and
anything else the project runs from a command, all work the same way.

## How a run works

```
request ─► warden_profile   the project's verified test command, test patterns, examples, helpers
        ─► warden_check     change: map changed files → tests; old code (git worktree) vs working tree
                            suite:  the targets' existing tests; where the new suite and bug file go
                            (both snapshot the files the run must be able to restore)
        ─► writers (0..n)   only for real gaps or the requested targets; never one file for two writers
        ─► warden_gate      targets unchanged (content hash vs snapshot)? new tests can fail?
                            bug reproductions fail 3/3?
        ─► triage           every failure gets a cause: stale-test, test-defect, source-bug or env
        ─► warden_lessons   every run: one rule per non-bug cause, applied on the next run
        ─► report           ≤ 14 lines: regressions, failures, kept tests, bugs, gaps, learned
```

**The code under test is read-only, enforced.** `warden_check plan` writes
`.test-warden/guard.json` (the run, the protected sources, an expiry); a small agent extension
then blocks every Edit, Write and obvious Bash write (`>`, `sed -i`, `cp`/`mv`/`rm`, `git
checkout --`) to those files, blocks the `fixer` agent, and refuses to run the scripts under
`.test-warden/runs/` with a Bash timeout below 900 s. It applies to the orchestrator and to the
writer sub-agents alike. The guard ends with `warden_lessons add` (the last step of every run),
with `warden_check {action:"release"}` when you explicitly ask for a source fix, or after
`guardMinutes`. The gate's snapshot check remains the backstop.

## Prompts

| You say | What happens |
|---|---|
| "Create a test suite for src/app/my-component.ts" | A suite in the project's naming next to it, or the existing test file is extended. Bugs are reported with a failing reproduction in `my-component.bugs.spec.ts`. `my-component.ts` is not modified. |
| "Run Test Warden on my changes. Intent: … Kind: feature" | Regression check of your uncommitted changes; tests are written only for real gaps. |
| "Test Warden: check src/x.ts against main for regressions only" | Check only, no writers. |

Saying what the code is meant to do ("Intent: …") is what the writer tests against. Without it,
the writer asks rather than guessing.

## The tools

| Tool | Does |
|---|---|
| `warden_profile` | `get`: per language group, the declared and verified commands with their evidence, test patterns, layout, helpers, 2–3 example tests, config files, CI hints and warnings. Cached in `.test-warden/profile.json` and refreshed when root config or CI files change. `set`: save a verified `suite` and/or `file` command, or `patterns`, and pin the profile. |
| `warden_check` | `plan` (mode `change`): maps each changed file to its tests (by name ignoring separators and one typo, by import in any language, through a test helper, or by directory for per-directory runners), snapshots them and writes `check.sh`. `plan` (mode `suite`): the targets' tests, plus suggested `own` and `bugs` files. `verdict`: regressions, failing tests, uncovered sources, and incomplete or timed-out units. |
| `warden_gate` | `plan`: detects any change to the code under test by content hash, whether the writer reported it or not, and returns the exact restore command. Flags writes outside the tests and writes `gate.sh`. `verdict`: `keep`, `reject` (with the reason) and `bugs.confirmed`, plus the undo command for rejected files. |
| `warden_lessons` | `get`, `add`, `remove` for up to 30 one-line lessons. Each must point to a file that exists; near-duplicates are merged and lessons whose file is gone are dropped. |

## Built-in agents: which help

| Agent | Used? | Why |
|---|---|---|
| `test-warden-writer` (ships with the plugin) | yes | Writes tests from the **intent**, in the project's own framework and style, only into the files it is given. Puts bug reproductions in a separate file, never edits the code under test, and answers in strict JSON. |
| `test-runner` | sometimes | Diagnoses a failure whose cause the log excerpt doesn't show. |
| `fixer` | **no** | It edits source until the tests pass, which hides the bugs you want to catch. |

## Permissions

| Permission | Why |
|---|---|
| `agent.extension` | loads `extension/warden-guard.js`, which blocks writes to the code under test while a run is open |
| `agent.prompt.inject` | indexes the Test Warden skill so the agent can load it |
| `agent.tool.register` | the four `warden_*` tools the agent calls during a run |
| `fs.read` | reading the project's manifests, test configs, CI files and tests, across the workspace |
| `fs.write` | writing the profile, the lessons and each run's files, limited to `.test-warden/**` |

`agent.prompt.inject`, `agent.tool.register` and `fs.write` are high-risk permissions. The plugin
has no network access and runs no programs itself.

### What it can and cannot do

It **can**:

- read workspace files to find the project's own test commands, test patterns and tests (the host
  always refuses credential files such as `.env*`, `.ssh/` and `*.pem`)
- write under `.test-warden/` in your workspace: `profile.json` and `lessons.json` (meant to be
  committed), and per run (git-ignored) the plan, exact snapshots of the files it protects, the
  generated `check.sh` and `gate.sh`, results, failure logs and verdicts
- write bash scripts that the **agent** runs with its own Bash tool, under your Bash approval
  settings. They run your project's test command on the current code, and on old or deliberately
  emptied copies of it in temporary `git worktree`s under `$TMPDIR`, which are removed afterwards.
  They never install packages (pnpm's pre-run dependency install is switched off) and stop a run
  that hangs after the run timeout
- copy its `test-warden-writer.md` sub-agent to `~/.agents/subagents/` on load, and remove it on
  unload unless you edited it
- keep `maxWriters`, `writerModel`, `runTimeout` and `guardMinutes` in its plugin settings

It **cannot** and does not:

- access the network, so nothing leaves your computer except through the models you configured
- run programs itself, or load code
- write workspace files outside `.test-warden/`, including the code under test. Through the
  scripts it never writes your working tree, and a writer's edit to the code under test is
  detected by content and undone from the snapshot
- touch any file in `~/.agents/subagents/` other than its own `test-warden-*.md`

Details for reviewers are in [docs/security-review.md](docs/security-review.md).

## Files

| Path | Commit it? | Holds |
|---|---|---|
| `.test-warden/profile.json` | yes | The verified commands and patterns (pinned) |
| `.test-warden/lessons.json` | yes | The lessons |
| `.test-warden/guard.json` | no (git-ignored automatically) | The open run's protected sources; removed when the run ends |
| `.test-warden/runs/` | no (git-ignored automatically) | Plans, snapshots, scripts, results, failure logs and verdicts |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Maximum writers | 3 | Upper bound on parallel writers. The orchestrator uses 1 unless the targets are independent. |
| Writer model | empty | Delegation model id for the writer. Empty uses the agent's default. |
| Run timeout (seconds) | 600 | Each test run of `check.sh` or `gate.sh` is stopped after this many seconds (30–7200), with every process it started, and reported as timed out, never as a failure. Raise it for a slow whole-suite command. |
| Guard duration (minutes) | 120 | How long after `warden_check plan` the sources under test stay read-only for every tool call (1–1440), unless the run ends earlier with `warden_lessons add` or `warden_check release`. |

## Known limits

- **Whole files, not single tests.** The gate judges a test file as a whole, not each test case in
  it. A useless test next to a good one in the same file passes. When a runner has no per-file
  command, all files are judged together as one suite run.
- **Suite-only runners and bug files.** With a whole-suite command, a confirmed bug reproduction
  makes the suite fail. The skill then gates the tests and the bug file separately.
- **Root profile only.** Monorepos are flagged with a warning.
- **Mapping is heuristic.** Tests are matched by name, by import, or through one helper. Fix a
  pattern once with `warden_profile set` and it stays pinned.
- **Tests inside the source file.** Languages whose convention puts tests in the source file
  (e.g. Rust unit tests) get separate test files, because the source file is read-only.
- **No mutation testing.** The revert check and the "target emptied" check stand in for it,
  without depending on any framework.

## Development

The plugin has no build step and no dependencies. Run the tests with Node 20 or later, git and
bash:

```bash
node --test tests/
```

The tests load `main.js` with a fake PI-Desktop host in a temporary folder. They cover:

- path, glob and test-file classification;
- command discovery with no framework table: Angular/Karma, an unknown Ruby project and CI hints;
- `warden_profile set` and its validation;
- mapping changed files to their tests;
- snapshots, restore and undo;
- the gate rules and bug confirmation;
- lessons, writer install and removal;
- the manifest matching the registered tools.

`tests/e2e.test.js` uses real git repositories and runs the generated scripts. It covers a
planted regression, a whole-suite command, a workspace inside a larger repository, the feature
gate, a hanging run stopped by the run timeout, and the full "create a test suite" flow. In that flow the target has a bug and uncommitted
user edits, and the writer tries to "fix" it.

Load this folder from the plugins page as a development plugin; it hot-reloads on save. Widening
its permissions needs a manual re-load.

## Credits

The design came out of an [LLM Council](https://github.com/eskwisit/pi-llm-council) run:
deterministic regression detection, a revert gate, one narrow writer, small evidence-backed
memory, and no `fixer`.

## License

[Apache-2.0](LICENSE)

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
