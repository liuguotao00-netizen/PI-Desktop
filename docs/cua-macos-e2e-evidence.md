# macOS CUA live E2E evidence

Date: 2026-11-26
Host: macOS Darwin 25.4.0 (arm64)
Binary: `target/debug/pi-desktop-host-core`
Command: `pnpm test:e2e:cua-macos-input`

Result: PASS

```text
capabilities {"accessibility":"granted","backend":"macos-ax",...}
session 94345ff1-5e51-434a-970c-270c1422b5d8
target 文本编辑 note.txt
grant cug_cc537bff955947c4870d33bf201c93dd budget 40
editable AXTextArea 0.0#a5952606
set_value {"dispatched":"accessibility-action","remainingBudget":39}
text "PI-Desktop CUA E2E"
click {"dispatched":"accessibility-action","remainingBudget":38}
revoked
```

The test launches TextEdit with a temporary file, creates an Agent-mode
session, grants desktop scope, inspects the AX tree, writes into the text area,
reads the text back through TextEdit, clicks a menu button, and revokes the
grant. The temporary file and document are removed afterwards.

## App-spawned host-core (TCC responsibility fix)

After adding `crates/host-launcher`, the Electron dev process spawns host-core
through the launcher, which calls `responsibility_spawnattrs_setdisclaim`
before `posix_spawn(POSIX_SPAWN_SETEXEC)`. The OS then evaluates the
`pi-desktop-host-core` Accessibility grant instead of the Electron app's.

`PI_CUA_SELF_TEST=1 pnpm dev` at 2026-11-26T08:36:55Z:

```text
cua self-test capabilities {"accessibility":"granted",...}
cua self-test targets {"count":6}
cua self-test grant {"targetId":"915:93","budget":40}
cua self-test inspect ok {"nodes":69,"truncated":false}
```
