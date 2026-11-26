# Changelog

## Unreleased

- Document that the core writes a deterministic first-prompt fallback and that
  this plugin upgrades that automatic title; `expectedTitle` is the derived text.

## 0.1.0

- Initial release of the configurable Session Titles plugin.
- Generate a title after the first completed turn using the configured prompt,
  model, and thinking level.
- Preserve manually renamed session titles.
