import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listQueue, pollOnce } from "../telegram-plugin/lib/bridge.js";
import { defaultState } from "../telegram-plugin/lib/storage.js";

function stateFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codexlink-state-recovery-"));
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_TELEGRAM_AGENT_NAME: "state-test",
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz123456",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "-1001",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
    BLUN_MNEMO_SYNC_ENABLED: "0"
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

for (const [label, content] of [["empty", ""], ["corrupt", "{broken"]]) {
  test(`${label} runtime state stops intake instead of replaying from offset zero`, async (t) => {
    const root = stateFixture(t);
    const oldInbox = `${JSON.stringify({ messageId: "9", text: "[Health Smoke] old probe", status: "queued" })}\n`;
    writeFileSync(join(root, "state.json"), content, "utf8");
    writeFileSync(join(root, "inbox.jsonl"), oldInbox, "utf8");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    };
    t.after(() => { globalThis.fetch = originalFetch; });

    await assert.rejects(
      pollOnce(),
      (error) => error?.code === "STATE_RECOVERY_REQUIRED" && /intake is stopped/i.test(error.message)
    );

    assert.equal(fetchCalls, 0);
    assert.equal(readFileSync(join(root, "inbox.jsonl"), "utf8"), oldInbox);
    const marker = JSON.parse(readFileSync(join(root, "state-recovery-required.json"), "utf8"));
    assert.equal(marker.intakeStopped, true);
    assert.equal(marker.status, "recovery_required");
  });
}

test("invalid primary state recovers from the last valid backup", (t) => {
  const root = stateFixture(t);
  const recovered = {
    ...defaultState(),
    offset: 4243,
    intakeCursorInitialized: true,
    queue: [{ id: "telegram:-1001:44", chatId: "-1001", messageId: "44", status: "queued" }]
  };
  writeFileSync(join(root, "state.json"), "{broken", "utf8");
  writeFileSync(join(root, "state.json.bak"), JSON.stringify(recovered), "utf8");

  const queue = listQueue(10);

  assert.equal(queue.length, 1);
  assert.equal(queue[0].messageId, "44");
  assert.equal(JSON.parse(readFileSync(join(root, "state.json"), "utf8")).offset, 4243);
  assert.equal(existsSync(join(root, "state-recovery-required.json")), false);
});

test("a new state tails Telegram once and discards pending history", async (t) => {
  const root = stateFixture(t);
  const originalFetch = globalThis.fetch;
  let requestBody = null;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      ok: true,
      result: [{
        update_id: 700,
        message: {
          message_id: 99,
          text: "old message that must not be replayed",
          chat: { id: -1001, type: "supergroup", title: "Test" },
          from: { id: 7, username: "tester" }
        }
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await pollOnce();

  assert.equal(requestBody.offset, -1);
  assert.equal(result.status, "tail_initialized");
  assert.equal(result.captured, 0);
  assert.equal(result.nextOffset, 701);
  assert.equal(existsSync(join(root, "inbox.jsonl")), false);
  const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(state.intakeCursorInitialized, true);
  assert.equal(state.offset, 701);
  assert.equal(existsSync(join(root, "state.json.bak")), true);
});
