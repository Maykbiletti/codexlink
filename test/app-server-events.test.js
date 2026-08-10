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
