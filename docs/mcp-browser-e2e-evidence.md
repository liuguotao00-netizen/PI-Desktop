# Real MCP browser E2E evidence

Date: 2026-11-26
Server: `@playwright/mcp` on `http://127.0.0.1:8931/mcp`
Command:

```bash
npx --yes @playwright/mcp@latest --port 8931 --host 127.0.0.1 --headless --isolated
MCP_BROWSER_URL=http://127.0.0.1:8931/mcp pnpm test:e2e:mcp-browser
```

Result:

```text
ok: true
tabs: 1
snapshotChars: 269
screenshotBytes: 7104
```

Covered:

- `browser_navigate` via `openTab`
- `browser_snapshot` + refs
- `browser_take_screenshot` image content
- `browser_type` fill
- `browser_click`
- `browser_evaluate` result unwrapping
- MCP `isError` -> `TOOL_FAILED`

## Re-run (2026-11-27)

Server: `@playwright/mcp@0.0.86 --port 8931 --headless --isolated` without
`--host`; it binds `localhost` (on macOS that is `::1`), so the endpoint uses
`http://localhost:8931/mcp` instead of `127.0.0.1`. The E2E default was changed
to `localhost` for that reason.

```text
ok: true
endpoint: http://localhost:8931/mcp
tabs: 1
snapshotChars: 573
screenshotBytes: 7104
```

The backend discovery path (`tools/list` → capabilities) and the tool calls now
run against the real Playwright MCP server, not a stub.
