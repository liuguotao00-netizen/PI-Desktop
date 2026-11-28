import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionForSession,
  SHARED_BROWSER_PARTITION,
} from "../electron/main/browser/partition.ts";

test("sessions never share a browser profile", () => {
  const a = partitionForSession("session-a");
  const b = partitionForSession("session-b");
  assert.notEqual(a, b);
  assert.match(a, /^persist:work-browser-[0-9a-f]{20}$/);
  assert.equal(partitionForSession("session-a"), a);
});

test("panes without a session keep the legacy partition", () => {
  assert.equal(partitionForSession(), SHARED_BROWSER_PARTITION);
  assert.equal(partitionForSession("  "), SHARED_BROWSER_PARTITION);
});
