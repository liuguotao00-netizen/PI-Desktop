# Source forks

Each directory here is a source snapshot of an upstream plugin whose catalog
entry exposes a real Git repository. The market publishes compiled `.piplug`
artifacts for most plugins, so those cannot be represented here as source.

`UPSTREAM.json` records the repository, commit, version and tarball URL.
`pnpm sync:plugin-forks` refreshes snapshots; `pnpm check:plugin-forks` reports
whether upstream HEAD moved without writing anything.

## Coverage (2026-11-26)

- 122 plugins have a confirmed public source repository.
- All are mirrored here. `BOUND-REPOSITORIES.json` records the market's
  `boundRepository` claim for every plugin that has one.
- Branch-specific sources are supported through `UPSTREAM.json.branch`
  (for example `in.memcode.memory`, `adoin.panel.anywhere`,
  `io.github.muzimu217.theme-forge`, `io.github.muzimu217.vision-kit`).
- Sources include monorepos, nested roots and package-layout sources without a
  root plugin manifest.
- The remaining 8 catalog entries have no usable source tree on their
  bound repository or branch; `NO-SOURCE.md` lists them.

`pnpm discover:plugin-forks` re-runs the GitHub API discovery. It is limited by
the unauthenticated API quota; set `GITHUB_TOKEN` in the environment to scan
more candidates in one pass.

Do not edit a snapshot in place. Local changes belong in a patch applied after
the snapshot is updated, so the next upstream sync stays reviewable.

## Independent forks

`pnpm sync:independent-forks` materializes one Git repository per plugin under
`~/.pi-desktop-dev/plugin-forks/<id>/`:

```text
repo/        working checkout on branch pi-fork
origin.git   bare fork remote
upstream     source repository
```

It fetches `upstream`, fast-forwards when the fork has no local commits, merges
when it does, pushes `pi-fork` to `origin`, and exports the resulting tree back
into this directory. Set `UPSTREAM.json.forkOrigin` to a GitHub fork URL to push
to a hosted fork instead of the local bare remote.

`pnpm check:independent-forks` fetches and reports behind/ahead without writing.

## License

A source fork is not a redistribution grant. `local.pi-markdown` currently has
no LICENSE file in the upstream repository; review the upstream terms before
shipping or repackaging it.
