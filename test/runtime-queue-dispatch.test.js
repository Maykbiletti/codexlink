import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindRuntimeTurnFromUserMessage,
  completeRuntimeTurnFromEvent,
  enqueueRuntimeMessage,
  injectNext
} from "../telegram-plugin/lib/bridge.js";
import { setRuntimeComposerInjector, setRuntimeTurnStarter } from "../telegram-plugin/lib/codex.js";

test("runtime queue submits consecutive messages through the visible composer even while a turn is active", async (t) => {
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
  const composerSubmissions = [];
  setRuntimeTurnStarter(() => {
    throw new Error("turn/start must not be used by the default TUI transport");
  });
  setRuntimeComposerInjector(async (_config, message, options) => {
    composerSubmissions.push({ id: message.id, threadId: options.threadId });
    return { ok: true, frontendPid: 4242 };
  });
  t.after(() => {
    setRuntimeTurnStarter(null);
    setRuntimeComposerInjector(null);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  enqueueRuntimeMessage("first", { messageId: "1", noTelegramReply: false });
  enqueueRuntimeMessage("second", { messageId: "2", noTelegramReply: false });
  const gate = {
    ready: false,
    reason: "active_turn",
    threadStatus: "active",
    activeTurnId: "cli-turn"
  };
  let gateCalls = 0;
  const runtimeDispatchGate = async () => {
    gateCalls += 1;
    return gate;
  };

  const firstResult = await injectNext("thread-1", { auto: true, runtimeDispatchGate });
  assert.equal(firstResult.status, "submitted");
  assert.equal(firstResult.message.messageId, "1");
  const secondResult = await injectNext("thread-1", { auto: true, runtimeDispatchGate });
  assert.equal(secondResult.status, "submitted");
  assert.equal(secondResult.message.messageId, "2");

  assert.equal(gateCalls, 0);
  assert.deepEqual(composerSubmissions, [
    { id: "runtime:1", threadId: "thread-1" },
    { id: "runtime:2", threadId: "thread-1" }
  ]);
  let state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.deepEqual(state.queue.map((item) => item.status), ["submitted", "submitted"]);
  assert.deepEqual(state.queue.map((item) => item.inputTransport), ["tui_composer", "tui_composer"]);
  assert.equal(state.pendingReplies.length, 2);
  assert.deepEqual(state.pendingReplies.map((item) => item.turnId), ["", ""]);

  const manualCompletion = await completeRuntimeTurnFromEvent({
    threadId: "thread-1",
    turnId: "manual-cli-turn",
    status: "completed",
    finalText: "This belongs to a manual CLI prompt."
  });
  assert.equal(manualCompletion.matched, false);

  const bound = bindRuntimeTurnFromUserMessage({
    queueItemId: "runtime:1",
    threadId: "thread-1",
    turnId: "turn-telegram-1"
  });
  assert.equal(bound.matched, true);
  state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(state.queue[0].status, "running");
  assert.equal(state.queue[0].turnId, "turn-telegram-1");
  assert.equal(state.pendingReplies[0].turnId, "turn-telegram-1");
  assert.equal(state.pendingReplies[1].turnId, "");
});
