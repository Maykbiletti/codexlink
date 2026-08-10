#!/usr/bin/env node
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  bindCurrentThread,
  bridgeStatus,
  cancelRuntimeQueueItem,
  completeRuntimeTurnFromEvent,
  consumeTeamRelayOnce,
  enqueueRuntimeMessage,
  injectNext,
  listQueue,
  pollOnce,
  relayRepliesOnce,
  reply,
  tailActivity
} from "./lib/bridge.js";
import { AppServerEventBridge } from "./lib/app-server-events.js";
import { setRuntimeTurnStarter } from "./lib/codex.js";
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout } from "./lib/paths.js";
import { RuntimeController } from "./lib/runtime-controller.js";
import { createRuntimeRpcServer } from "./lib/runtime-rpc.js";
import { appendLog, nowIso } from "./lib/storage.js";

ensureStateLayout();
const config = loadConfig();
let stopping = false;
let rpc = null;

const eventBridge = config.appServerWsUrl
  ? new AppServerEventBridge(config, {
    onTurnCompleted: (event) => completeRuntimeTurnFromEvent(event),
    onApproval: (approval) => {
      appendLog(
        config.paths.activityFile,
        `APP_REQUEST_PENDING request=${approval.requestId} method=${approval.method} thread=${approval.threadId || "-"} turn=${approval.turnId || "-"}`
      );
    }
  })
  : null;

if (eventBridge) {
  setRuntimeTurnStarter((options) => eventBridge.startTurn(options));
}

const controller = new RuntimeController(config, {
  status: bridgeStatus,
  listQueue,
  enqueue: enqueueRuntimeMessage,
  cancel: cancelRuntimeQueueItem,
  bindThread: bindCurrentThread,
  poll: pollOnce,
  dispatch: injectNext,
  reply,
  relayReplies: relayRepliesOnce,
  teamRelay: consumeTeamRelayOnce,
  tailActivity
}, eventBridge);

const inFlight = new Map();

function runExclusive(name, operation) {
  if (inFlight.has(name)) {
    return inFlight.get(name);
  }
  const task = Promise.resolve()
    .then(operation)
    .catch((error) => {
      appendLog(config.paths.activityFile, `RUNTIME_${name.toUpperCase()}_ERROR ${String(error?.message || error).replace(/\s+/g, " ").slice(0, 500)}`);
      return null;
    })
    .finally(() => inFlight.delete(name));
  inFlight.set(name, task);
  return task;
}

const schedule = {
  poll: 0,
  dispatch: 0,
  replyRecovery: 0,
  teamRelay: 0,
  eventStream: 0
};

async function tick() {
  if (stopping) {
    return;
  }
  const now = Date.now();
  controller.lastTickAt = nowIso();
  const current = loadConfig();

  if (now >= schedule.poll && current.botToken && current.allowedChatIds.length > 0) {
    schedule.poll = now + Math.max(250, current.pollIntervalMs);
    void runExclusive("poll", pollOnce);
  }

  if (now >= schedule.dispatch && !controller.paused && current.appServerWsUrl) {
    schedule.dispatch = now + Math.max(250, current.injectIntervalMs);
    void runExclusive("dispatch", () => injectNext("", { auto: true }));
  }

  if (now >= schedule.teamRelay) {
    schedule.teamRelay = now + 1000;
    void runExclusive("team_relay", consumeTeamRelayOnce);
  }

  // App-server events are authoritative. This slower pass only recovers a reply
  // if the runtime was offline while a turn completed.
  if (now >= schedule.replyRecovery) {
    schedule.replyRecovery = now + 30000;
    void runExclusive("reply_recovery", relayRepliesOnce);
  }

  if (eventBridge && now >= schedule.eventStream) {
    schedule.eventStream = now + 1500;
    const threadId = String(current.currentThreadId || bridgeStatus().boundThreadId || "").trim();
    if (threadId) {
      void runExclusive("event_stream", () => eventBridge.ensureConnected(threadId));
    }
  }
}

async function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  appendLog(config.paths.activityFile, `RUNTIME_STOP signal=${signal}`);
  setRuntimeTurnStarter(null);
  await Promise.allSettled(Array.from(inFlight.values()));
  await eventBridge?.close?.();
  await rpc?.close?.();
  try {
    if (Number.parseInt(readFileSync(config.paths.runtimePidFile, "utf8").trim(), 10) === process.pid) {
      unlinkSync(config.paths.runtimePidFile);
    }
  } catch {
    // A stale pid file is harmless; the sidecar manager validates liveness.
  }
}

process.on("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

writeFileSync(config.paths.runtimePidFile, `${process.pid}\n`, "utf8");
rpc = await createRuntimeRpcServer(config, (method, params) => controller.invoke(method, params));
appendLog(config.paths.activityFile, `RUNTIME_START pid=${process.pid}`);

const timer = setInterval(() => void tick(), 100);
await tick();

await new Promise((resolve) => {
  const finish = () => {
    clearInterval(timer);
    resolve();
  };
  process.once("beforeExit", finish);
});
