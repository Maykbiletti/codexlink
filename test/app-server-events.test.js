import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppServerEventBridge } from "../telegram-plugin/lib/app-server-events.js";

test("approval decisions are scoped to known runtime requests", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  };
  const bridge = new AppServerEventBridge(config);
  let response = null;
  bridge.pendingApprovals.set("7", {
    requestId: "7",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {},
    createdAt: new Date().toISOString(),
    respond: async (value) => { response = value; }
  });

  assert.equal(bridge.listApprovals().length, 1);
  await bridge.decideApproval("7", "decline");
  assert.deepEqual(response, { decision: "decline" });
  assert.equal(bridge.listApprovals().length, 0);
  await assert.rejects(bridge.decideApproval("missing", "accept"), /Unknown or resolved/);
});

test("non-approval server requests reject decision-shaped responses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  });
  bridge.pendingApprovals.set("8", {
    requestId: "8",
    method: "item/tool/requestUserInput",
    threadId: "thread-1",
    turnId: "turn-1",
    params: {},
    createdAt: new Date().toISOString(),
    respond: async () => {}
  });

  await assert.rejects(bridge.decideApproval("8", "accept"), /cannot be resolved with an approval decision/);
  assert.equal(bridge.listApprovals().length, 1);
});

test("completed app-server items are correlated with their turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completions = [];
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  }, {
    onTurnCompleted: async (event) => {
      completions.push(event);
      return { matched: true };
    }
  });

  await bridge._handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "agentMessage", phase: "final_answer", text: "Fertig." }
    }
  });
  await bridge._handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    }
  });

  assert.equal(completions.length, 1);
  assert.equal(completions[0].finalText, "Fertig.");
  assert.equal(completions[0].turnId, "turn-1");
});

test("a late final-answer item is delivered after turn completion instead of being lost", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-late-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completions = [];
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  }, {
    onTurnCompleted: async (event) => {
      completions.push(event);
      return event.finalText
        ? { matched: true, delivered: true }
        : { matched: true, awaitingFinal: true };
    }
  });
  t.after(() => bridge.close());

  await bridge._handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: { id: "turn-late", status: "completed" }
    }
  });
  assert.equal(completions.length, 1);
  assert.equal(completions[0].finalText, "");

  await bridge._handleNotification({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-late",
      item: { type: "agentMessage", phase: "final_answer", text: "Jetzt auch auf Telegram." }
    }
  });

  assert.equal(completions.length, 2);
  assert.equal(completions[1].finalText, "Jetzt auch auf Telegram.");
  assert.equal(bridge.pendingFinalCompletions.size, 0);
});

test("turn completion uses an embedded final answer when the item event was missed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-embedded-final-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completions = [];
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  }, {
    onTurnCompleted: async (event) => completions.push(event)
  });

  await bridge._handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turn: {
        id: "turn-embedded",
        status: "completed",
        items: [{ type: "agentMessage", phase: "final_answer", text: "Persistierte Antwort." }]
      }
    }
  });

  assert.equal(completions.length, 1);
  assert.equal(completions[0].finalText, "Persistierte Antwort.");
});

test("visible-composer user messages bind their CodexLink queue id to the app-server turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observed = [];
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  }, {
    onUserMessageObserved: async (event) => observed.push(event)
  });

  await bridge._handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "userMessage",
        content: [{
          type: "text",
          text: "Mayk schrieb:\nBitte prüfen.\n\n[CodexLink Queue ID: telegram:-1001:42]",
          text_elements: []
        }]
      }
    }
  });

  assert.equal(observed.length, 1);
  assert.equal(observed[0].queueItemId, "telegram:-1001:42");
  assert.equal(observed[0].turnId, "turn-1");
});

test("runtime dispatch waits for an authoritative idle thread event", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  });
  bridge.connected = true;
  bridge.threadId = "thread-1";
  bridge.client = {};

  assert.equal(bridge.getDispatchState("thread-1").ready, false);
  assert.equal(bridge.getDispatchState("thread-1").reason, "status_unknown");

  await bridge._handleNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "active" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").reason, "active_turn");

  await bridge._handleNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "idle" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  await bridge._handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-cli-1", status: "completed" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").ready, true);
});

test("one started runtime turn locks dispatch until its matching completion and idle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let releaseStart;
  const startBarrier = new Promise((resolve) => { releaseStart = resolve; });
  let markStartEntered;
  const startEntered = new Promise((resolve) => { markStartEntered = resolve; });
  let starts = 0;
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  });
  bridge.connected = true;
  bridge.threadId = "thread-1";
  bridge.threadStatus = "idle";
  bridge.client = {
    startTurn: async () => {
      starts += 1;
      markStartEntered();
      await startBarrier;
      return { ok: true, busy: false, turnId: "turn-runtime-1" };
    }
  };

  const first = bridge.startTurn({ threadId: "thread-1", text: "first" });
  await startEntered;
  const competing = await bridge.startTurn({ threadId: "thread-1", text: "second" });
  assert.equal(competing.ok, false);
  assert.equal(competing.reason, "dispatch_in_flight");
  assert.equal(starts, 1);

  releaseStart();
  const started = await first;
  assert.equal(started.turnId, "turn-runtime-1");
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  await bridge._handleNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "idle" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  await bridge._handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-runtime-1", status: "completed" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").ready, true);
});

test("one composer submission owns the FIFO lock until its matching completion and idle", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  });
  bridge.connected = true;
  bridge.threadId = "thread-1";
  bridge.threadStatus = "idle";
  bridge.client = {};

  const claimed = await bridge.claimComposerDispatch("thread-1", "runtime:1");
  assert.equal(claimed.ready, true);
  assert.equal(bridge.getDispatchState("thread-1").reason, "dispatch_in_flight");
  bridge.settleComposerDispatch("thread-1", "runtime:1", { ok: true, queuedInComposer: true });
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  await bridge._handleNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-runtime-1" } }
  });
  await bridge._handleNotification({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-runtime-1",
      item: {
        type: "userMessage",
        content: [{
          type: "text",
          text: "first\n\n[CodexLink Queue ID: runtime:1]",
          text_elements: []
        }]
      }
    }
  });
  assert.equal(bridge.getDispatchState("thread-1").ownedTurnId, "turn-runtime-1");

  await bridge._handleNotification({
    method: "thread/status/changed",
    params: { threadId: "thread-1", status: { type: "idle" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  await bridge._handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "manual-cli-turn", status: "completed" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  await bridge._handleNotification({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-runtime-1", status: "completed" } }
  });
  assert.equal(bridge.getDispatchState("thread-1").ready, true);

  const failedClaim = await bridge.claimComposerDispatch("thread-1", "runtime:2");
  assert.equal(failedClaim.ready, true);
  bridge.settleComposerDispatch("thread-1", "runtime:2", { ok: false });
  assert.equal(bridge.getDispatchState("thread-1").ready, true);
});

test("doctor reconciliation recovers a missed matching completion without releasing another turn", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observed = [];
  const completed = [];
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  }, {
    onUserMessageObserved: async (event) => observed.push(event),
    onTurnCompleted: async (event) => {
      completed.push(event);
      return { matched: true };
    }
  });
  bridge.connected = true;
  bridge.threadId = "thread-1";
  bridge.threadStatus = "idle";
  bridge.client = {
    request: async (method) => {
      assert.equal(method, "thread/read");
      return {
        result: {
          thread: {
            status: { type: "idle" },
            turns: [{
              id: "turn-runtime-1",
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "first\n\n[CodexLink Queue ID: runtime:1]" }]
                },
                { type: "agentMessage", phase: "final_answer", text: "Fertig." }
              ]
            }]
          }
        }
      };
    }
  };

  const claimed = await bridge.claimComposerDispatch("thread-1", "runtime:1");
  assert.equal(claimed.ready, true);
  bridge.settleComposerDispatch("thread-1", "runtime:1", { ok: true, queuedInComposer: true });
  assert.equal(bridge.getDispatchState("thread-1").reason, "turn_completion_pending");

  const reconciled = await bridge.reconcileThread("thread-1");

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.ready, true);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].queueItemId, "runtime:1");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].turnId, "turn-runtime-1");
});

test("authoritative idle recovers a stale active turn whose completion event was missed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-events-stale-active-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const observed = [];
  const completions = [];
  const bridge = new AppServerEventBridge({
    appServerWsUrl: "ws://127.0.0.1:1",
    paths: {
      runtimeEventsFile: join(root, "events.jsonl"),
      activityFile: join(root, "activity.log")
    }
  }, {
    onUserMessageObserved: async (event) => observed.push(event),
    onTurnCompleted: async (event) => {
      completions.push(event);
      return { matched: true, delivered: true };
    }
  });
  bridge.connected = true;
  bridge.threadId = "thread-1";
  bridge.threadStatus = "active";
  bridge.activeTurnId = "turn-stale-active";
  bridge.ownedTurnId = "turn-stale-active";
  bridge.ownedQueueItemId = "runtime:stale-active";
  bridge.awaitingTurnCompletion = true;
  bridge.statusUpdatedAt = new Date(Date.now() - 120000).toISOString();
  bridge.client = {
    request: async (method) => {
      assert.equal(method, "thread/read");
      return {
        result: {
          thread: {
            status: { type: "idle" },
            turns: [{
              id: "turn-stale-active",
              status: "inProgress",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Auftrag\n\n[CodexLink Queue ID: runtime:stale-active]" }]
                },
                { type: "agentMessage", phase: "final_answer", text: "Nachgeholte Antwort." }
              ]
            }]
          }
        }
      };
    }
  };

  const result = await bridge.reconcileThread("thread-1");

  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].synthesizedFromIdle, true);
  assert.equal(completions[0].finalText, "Nachgeholte Antwort.");
  assert.equal(observed[0].queueItemId, "runtime:stale-active");
  assert.equal(bridge.activeTurnId, "");
  assert.equal(bridge.ownedTurnId, "");
  assert.equal(bridge.awaitingTurnCompletion, false);
});
