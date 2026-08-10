import assert from "node:assert/strict";
import test from "node:test";
import { mergeQueueEntry } from "../telegram-plugin/lib/bridge.js";

test("a stale submitted snapshot cannot overwrite a replied queue item", () => {
  const replied = {
    id: "telegram:1:2",
    status: "replied",
    turnId: "turn-1",
    injectFinishedAt: "2026-01-01T00:00:01.000Z",
    deliveredAt: "2026-01-01T00:00:03.000Z",
    responsePreview: "Done"
  };
  const stale = {
    id: "telegram:1:2",
    status: "submitted",
    turnId: "turn-1",
    injectFinishedAt: "2026-01-01T00:00:02.000Z",
    responsePreview: "turn_queued thread=thread-1 app_server=turn_start"
  };

  const merged = mergeQueueEntry(replied, stale);
  assert.equal(merged.status, "replied");
  assert.equal(merged.responsePreview, "Done");
});

test("intentional stale-lease recovery wins over an injecting snapshot", () => {
  const injecting = {
    id: "telegram:1:3",
    status: "injecting",
    lastAttemptAt: "2026-01-01T00:00:01.000Z"
  };
  const recovered = {
    ...injecting,
    status: "queued",
    requeuedAt: "2026-01-01T00:10:00.000Z",
    requeueReason: "stale_injecting_lease",
    leaseUntil: null
  };

  assert.equal(mergeQueueEntry(injecting, recovered).status, "queued");
});
