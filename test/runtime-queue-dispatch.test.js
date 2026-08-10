import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enqueueRuntimeMessage, injectNext } from "../telegram-plugin/lib/bridge.js";
import { setRuntimeTurnStarter } from "../telegram-plugin/lib/codex.js";

test("runtime queue keeps later messages queued until the event gate becomes idle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-runtime-dispatch-"));
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_AGENT_NAME: "queue-test",
    BLUN_TELEGRAM_BOT_TOKEN: "",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "",
    BLUN_TELEGRAM_APP_SERVER_WS_URL: "ws://127.0.0.1:1",
    BLUN_TELEGRAM_THREAD_ID: "thread-1",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
    BLUN_MNEMO_SYNC_ENABLED: "0"
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  let starts = 0;
  setRuntimeTurnStarter(async () => ({
    ok: true,
    busy: false,
    turnId: `turn-${++starts}`
  }));
  t.after(() => {
    setRuntimeTurnStarter(null);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  enqueueRuntimeMessage("first", { messageId: "1" });
  enqueueRuntimeMessage("second", { messageId: "2" });
  let gate = {
    ready: false,
    reason: "active_turn",
    threadStatus: "active",
    activeTurnId: "cli-turn"
  };
  const runtimeDispatchGate = async () => gate;

  const activeResult = await injectNext("thread-1", { auto: true, runtimeDispatchGate });
  assert.equal(activeResult.status, "deferred");
  assert.equal(activeResult.reason, "runtime_active_turn");
  assert.equal(starts, 0);
  let state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.deepEqual(state.queue.map((item) => item.status), ["queued", "queued"]);
  assert.deepEqual(state.queue.map((item) => item.attempts), [0, 0]);

  gate = { ready: true, reason: "ready", threadStatus: "idle", activeTurnId: "" };
  const firstResult = await injectNext("thread-1", { auto: true, runtimeDispatchGate });
  assert.equal(firstResult.status, "delivered");
  assert.equal(firstResult.message.messageId, "1");
  assert.equal(starts, 1);

  gate = {
    ready: false,
    reason: "turn_completion_pending",
    threadStatus: "idle",
    activeTurnId: "turn-1"
  };
  const lockedResult = await injectNext("thread-1", { auto: true, runtimeDispatchGate });
  assert.equal(lockedResult.status, "deferred");
  assert.equal(lockedResult.reason, "runtime_turn_completion_pending");
  assert.equal(starts, 1);
  state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(state.queue.find((item) => item.messageId === "2").status, "queued");
});
