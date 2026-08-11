import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureTelegramLive, runMnemoRuntimeSync } from "../telegram-plugin/lib/mnemo-policy.js";
import { repairMojibake } from "../telegram-plugin/lib/text-encoding.js";

const CORRUPT_TEXT = "179 Ereignisse \u00e2\u20ac\u201d shown 76 (42%) \u00c2\u00b7 aborted 63; erf\u00c3\u00bcllt";
const REPAIRED_TEXT = "179 Ereignisse \u2014 shown 76 (42%) \u00b7 aborted 63; erf\u00fcllt";

test("repairs Windows-1252 UTF-8 mojibake without changing valid Unicode", () => {
  assert.equal(repairMojibake(CORRUPT_TEXT), REPAIRED_TEXT);
  assert.equal(repairMojibake("doppelt: \u00c3\u0192\u00c2\u00bc"), "doppelt: \u00fc");

  const valid = "Schwedisch: \u00e5\u00e4\u00f6 \u2014 50 \u20ac \ud83d\ude00";
  assert.equal(repairMojibake(valid), valid);
});

test("live Telegram capture stores repaired text under the canonical Telegram key", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
    return new Response(JSON.stringify({ result: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await captureTelegramLive({
    agentName: "alfred",
    mnemoHubUrl: "http://mnemo.test",
    mnemoSyncEnabled: true,
    mnemoSyncRetryAttempts: 1,
    mnemoSyncTimeoutMs: 1000
  }, {
    chatId: "-1001",
    messageId: "49556",
    chatType: "supergroup",
    conversationKey: "-1001:root",
    user: "Dieter",
    text: CORRUPT_TEXT
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://mnemo.test/tool/mem_capture_ingest");
  assert.equal(calls[0].body.content, REPAIRED_TEXT);
  assert.equal(calls[0].body.source_ref, "tg:-1001:49556");
  assert.equal(calls[0].body.dedupe_key, "telegram:-1001:49556");
  assert.equal(calls[0].body.promote_transcript, true);
  assert.equal(calls[0].body.promote_memory, false);
  assert.equal(calls[0].body.remember, false);
});

test("runtime turn intake cannot promote a second transport memory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-mnemo-integrity-"));
  const originalFetch = globalThis.fetch;
  const previousFastRecall = process.env.BLUN_MNEMO_FAST_RECALL;
  const calls = [];
  process.env.BLUN_MNEMO_FAST_RECALL = "0";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body || "{}")) });
    return new Response(JSON.stringify({
      result: {
        ok: true,
        status: "ok",
        capture: { ok: true },
        recall: { ok: true, rows: [] },
        hook_status: { ok: true }
      }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousFastRecall === undefined) delete process.env.BLUN_MNEMO_FAST_RECALL;
    else process.env.BLUN_MNEMO_FAST_RECALL = previousFastRecall;
    rmSync(root, { recursive: true, force: true });
  });

  await runMnemoRuntimeSync({
    agentName: "alfred",
    mnemoHubUrl: "http://mnemo.test",
    mnemoSyncEnabled: true,
    mnemoSyncRetryAttempts: 1,
    mnemoSyncTimeoutMs: 1000,
    paths: { mnemoSyncStateFile: join(root, "mnemo-sync-state.json") }
  }, {
    chatId: "-1001",
    messageId: "49556",
    chatType: "supergroup",
    conversationKey: "-1001:root",
    user: "Dieter",
    text: CORRUPT_TEXT
  }, "thread-1");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://mnemo.test/tool/mem_runtime_turn_begin");
  assert.equal(calls[0].body.content, REPAIRED_TEXT);
  assert.equal(calls[0].body.source_ref, "tg:-1001:49556");
  assert.equal(calls[0].body.dedupe_key, "telegram:-1001:49556");
  assert.equal(calls[0].body.promote_transcript, true);
  assert.equal(calls[0].body.promote_memory, false);
  assert.equal(calls[0].body.remember, false);
});
