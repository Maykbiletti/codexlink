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

test("new visible-composer input steers an active turn ahead of legacy backlog", async (t) => {
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

  enqueueRuntimeMessage("legacy backlog", { messageId: "1", noTelegramReply: false });
  const statePath = join(root, "state.json");
  const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
  delete legacyState.queue[0].activeTurnSubmit;
  writeFileSync(statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");
  enqueueRuntimeMessage("new steering input", { messageId: "2", noTelegramReply: false });

  let gate = {
    ready: false,
    reason: "active_turn",
    threadStatus: "active",
    activeTurnId: "cli-turn"
  };
  let claimCalls = 0;
  const runtimeDispatchGate = async () => gate;
  const runtimeDispatchClaim = async ({ queueItemId }) => {
    claimCalls += 1;
    if (!gate.ready) return gate;
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

  const steered = await injectNext("thread-1", dispatchOptions);
  assert.equal(steered.status, "submitted");
  assert.equal(steered.message.messageId, "2");
  assert.equal(steered.message.steeredActiveTurn, true);
  assert.equal(steered.message.turnId, "cli-turn");
  assert.equal(claimCalls, 0, "steering must not claim a new-turn composer lock");
  assert.deepEqual(composerSubmissions, [
    { id: "runtime:2", threadId: "thread-1" }
  ]);

  let state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(state.queue.map((item) => item.status), ["parked", "submitted"]);
  assert.equal(state.pendingReplies.length, 1);
  assert.equal(state.pendingReplies[0].turnId, "cli-turn");

  const bound = bindRuntimeTurnFromUserMessage({
    queueItemId: "runtime:2",
    threadId: "thread-1",
    turnId: "cli-turn"
  });
  assert.equal(bound.matched, true);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.queue[1].status, "running");

  enqueueRuntimeMessage("follow-up while completion is pending", { messageId: "3", noTelegramReply: false });
  gate = {
    ready: false,
    reason: "turn_completion_pending",
    threadStatus: "active",
    activeTurnId: "cli-turn"
  };
  const steeredPending = await injectNext("thread-1", dispatchOptions);
  assert.equal(steeredPending.status, "submitted");
  assert.equal(steeredPending.message.messageId, "3");
  assert.equal(steeredPending.message.steeredActiveTurn, true);
  assert.equal(steeredPending.message.turnId, null);
  assert.equal(claimCalls, 0, "follow-up steering must not claim a new-turn composer lock");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(state.queue.map((item) => item.status), ["parked", "running", "submitted"]);
  assert.equal(state.pendingReplies.find((item) => item.queueItemId === "runtime:2")?.status, "running");
  assert.equal(state.pendingReplies.find((item) => item.queueItemId === "runtime:3")?.turnId, "");

  const followUpBound = bindRuntimeTurnFromUserMessage({
    queueItemId: "runtime:3",
    threadId: "thread-1",
    turnId: "next-turn"
  });
  assert.equal(followUpBound.matched, true);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.queue[2].status, "running");
  assert.equal(state.pendingReplies.find((item) => item.queueItemId === "runtime:3")?.turnId, "next-turn");

  const unrelated = await completeRuntimeTurnFromEvent({
    threadId: "thread-1",
    turnId: "manual-other-turn",
    status: "completed",
    finalText: "Not the Telegram turn."
  });
  assert.equal(unrelated.matched, false);

  const completed = await completeRuntimeTurnFromEvent({
    threadId: "thread-1",
    turnId: "cli-turn",
    status: "completed",
    finalText: ""
  });
  assert.equal(completed.matched, true);
  assert.equal(completed.awaitingFinal, true);

  gate = { ready: false, reason: "status_unknown", threadStatus: "unknown", activeTurnId: "" };
  const blockedUntilIdle = await injectNext("thread-1", dispatchOptions);
  assert.equal(blockedUntilIdle.status, "deferred");
  assert.equal(blockedUntilIdle.reason, "no_eligible_message");
  assert.equal(composerSubmissions.length, 2);

  gate = { ready: true, reason: "ready", threadStatus: "idle", activeTurnId: "" };
  const backlogResult = await injectNext("thread-1", dispatchOptions);
  assert.equal(backlogResult.status, "deferred");
  assert.equal(backlogResult.reason, "no_eligible_message");
  assert.equal(claimCalls, 0);
  assert.deepEqual(composerSubmissions, [
    { id: "runtime:2", threadId: "thread-1" },
    { id: "runtime:3", threadId: "thread-1" }
  ]);
});
