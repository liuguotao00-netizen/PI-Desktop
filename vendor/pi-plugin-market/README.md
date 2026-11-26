# PI Plugin Market vendor cache

See `CATALOG.md` for every plugin id, description, upstream source and source status.

This directory is populated by `scripts/vendor-plugin-market.mjs`.

- `packages/` and `extracted/` are tracked in this repository as a vendored
  third-party corpus for inspection and comparison. They are compiled `.piplug`
  artifacts plus their extracted contents, not first-party source.
- `manifest.json` records the catalog version, artifact URL, SHA-256, declared
  permissions, trust label, and any repository/homepage metadata.
- The catalog does **not** publish a license field for most entries. Tracking
  them here is not a redistribution grant; verify the upstream license before
  repackaging or shipping them.
- Downloaded code is untrusted data: review it before enabling or reading it in
  a privileged context.

## Why this is a mirror, not 130 Git forks

The catalog publishes compiled `.piplug` artifacts. Its metadata exposes a
source repository for only 13 entries, and only one of those is a real Git
repository (`local.pi-markdown` on GitHub). The rest have no upstream source to
fork. This directory therefore mirrors the published artifacts and records
their provenance per plugin in `extracted/<id>/UPSTREAM.json`.

If an upstream repository appears later, add it to the catalog; the next sync
records it in `UPSTREAM.json` and the artifact can be compared against source.

## Sync

```bash
pnpm vendor:plugins                  # fetch/update latest non-yanked versions
pnpm check:plugins-vendor            # report new/updated/removed versions only
node scripts/vendor-plugin-market.mjs --only id1,id2
node scripts/vendor-plugin-market.mjs --no-extract
```

`check:plugins-vendor` fetches the live catalog, falls back to the local market
cache when GitHub is unreachable, and exits non-zero when a pinned version has
moved. `vendor:plugins` verifies SHA-256 and size before replacing anything; it
does not apply local patches, so re-apply any intentional patch after syncing.

## Local snapshot (2026-11-25)

- 130 latest non-yanked versions downloaded and extracted.
- 140,268,751 bytes of `.piplug` artifacts; about 267 MB extracted.
- 2,957 extracted files; 1,123 JS/TS files.
- 73 packages contain a LICENSE/COPYING file; 13 catalog entries expose a
  repository URL; no catalog entry declares a license field.
- One package (`io.github.akshayxkill.nexus-scenic-themes`) needed a retry after
  a network timeout and is included.
- `local.pi-markdown` extracts without a root `manifest.json`; inspect its
  package layout before using it.

Redistribution and production use still require per-plugin license review.
