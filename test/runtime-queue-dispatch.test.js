import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("runtime queue keeps visible-composer delivery strict FIFO until completion and idle", async (t) => {
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
  const statePath = join(root, "state.json");
  const reorderedByOldPriority = JSON.parse(readFileSync(statePath, "utf8"));
  reorderedByOldPriority.queue[1].relevance = "escalation";
  writeFileSync(statePath, `${JSON.stringify(reorderedByOldPriority, null, 2)}\n`, "utf8");

  let gate = {
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
  let claimCalls = 0;
  const runtimeDispatchClaim = async ({ queueItemId }) => {
    claimCalls += 1;
    if (!gate.ready) {
      return gate;
    }
    gate = {
      ready: false,
      reason: "turn_completion_pending",
      threadStatus: "active",
      activeTurnId: "pending-turn-id",
      queueItemId
    };
    return {
      ready: true,
      reason: "claimed",
      threadStatus: "active",
      activeTurnId: "pending-turn-id",
      queueItemId
    };
  };
  const runtimeDispatchSettled = async ({ result }) => {
    if (!result.ok) {
      gate = { ready: true, reason: "ready", threadStatus: "idle", activeTurnId: "" };
    }
  };
  const dispatchOptions = {
    auto: true,
    runtimeDispatchGate,
    runtimeDispatchClaim,
    runtimeDispatchSettled
  };

  const blockedByActiveTurn = await injectNext("thread-1", dispatchOptions);
  assert.equal(blockedByActiveTurn.status, "deferred");
  assert.equal(blockedByActiveTurn.reason, "runtime_active_turn");
  assert.deepEqual(composerSubmissions, []);

  gate = { ready: true, reason: "ready", threadStatus: "idle", activeTurnId: "" };
  const blockedWithoutAtomicLock = await injectNext("thread-1", {
    auto: true,
    runtimeDispatchGate
  });
  assert.equal(blockedWithoutAtomicLock.status, "deferred");
  assert.equal(blockedWithoutAtomicLock.reason, "runtime_composer_lock_unavailable");
  assert.deepEqual(composerSubmissions, []);

  const firstResult = await injectNext("thread-1", dispatchOptions);
  assert.equal(firstResult.status, "submitted");
  assert.equal(firstResult.message.messageId, "1");
  const blockedUntilCompletion = await injectNext("thread-1", dispatchOptions);
  assert.equal(blockedUntilCompletion.status, "deferred");
  assert.equal(blockedUntilCompletion.reason, "runtime_turn_completion_pending");

  assert.deepEqual(composerSubmissions, [
    { id: "runtime:1", threadId: "thread-1" }
  ]);
  let state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(state.queue.map((item) => item.status), ["submitted", "queued"]);
  assert.equal(state.queue[0].inputTransport, "tui_composer");
  assert.equal(state.queue[1].inputTransport, undefined);
  assert.equal(state.pendingReplies.length, 1);
  assert.equal(state.pendingReplies[0].turnId, "");

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

  const completed = await completeRuntimeTurnFromEvent({
    threadId: "thread-1",
    turnId: "turn-telegram-1",
    status: "completed",
    finalText: ""
  });
  assert.equal(completed.matched, true);
  assert.equal(completed.awaitingFinal, true);
  state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(state.pendingReplies[0].status, "completed_waiting_final");
  assert.equal(state.pendingReplies[0].sentAt, null);
  gate = { ready: false, reason: "status_unknown", threadStatus: "unknown", activeTurnId: "" };
  const blockedUntilIdle = await injectNext("thread-1", dispatchOptions);
  assert.equal(blockedUntilIdle.status, "deferred");
  assert.equal(blockedUntilIdle.reason, "runtime_status_unknown");
  assert.equal(composerSubmissions.length, 1);

  gate = { ready: true, reason: "ready", threadStatus: "idle", activeTurnId: "" };
  const secondResult = await injectNext("thread-1", dispatchOptions);
  assert.equal(secondResult.status, "submitted");
  assert.equal(secondResult.message.messageId, "2");
  assert.deepEqual(composerSubmissions, [
    { id: "runtime:1", threadId: "thread-1" },
    { id: "runtime:2", threadId: "thread-1" }
  ]);
  assert.equal(gateCalls, 6);
  assert.equal(claimCalls, 2);
});
