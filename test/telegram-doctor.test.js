import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctorStateTransition, inspectTelegramDoctor, runTelegramDoctor } from "../telegram-plugin/lib/doctor.js";
import { callRuntimeRpc, createRuntimeRpcServer } from "../telegram-plugin/lib/runtime-rpc.js";
import { currentProcessInstanceId, inspectStateLock } from "../telegram-plugin/lib/state-lock.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codexlink-doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    agentName: "doctor-test",
    appServerWsUrl: "",
    currentThreadId: "",
    doctorWatchEnabled: false,
    doctorRpcTimeoutMs: 1000,
    doctorQueueStallMs: 10000,
    pendingReplyTimeoutMs: 1000,
    runtimePort: 0,
    runtimeRpcTimeoutMs: 1000,
    paths: {
      root,
      runtimeDir: join(root, "runtime"),
      stateFile: join(root, "state.json"),
      activityFile: join(root, "activity.log"),
      runtimeEndpointFile: join(root, "runtime-endpoint.json"),
      runtimePidFile: join(root, "runtime-daemon.pid"),
      runtimeStdoutFile: join(root, "runtime-daemon.stdout.log"),
      runtimeStderrFile: join(root, "runtime-daemon.stderr.log"),
      doctorPidFile: join(root, "telegram-doctor.pid"),
      doctorStateFile: join(root, "telegram-doctor-state.json")
    }
  };
}

async function waitFor(operation, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error(`condition not met within ${timeoutMs}ms`);
}

test("doctor quarantines an orphaned state lock and repairs stale PID ownership from RPC", async (t) => {
  const config = fixture(t);
  writeFileSync(config.paths.stateFile, JSON.stringify({ offset: 1, queue: [], pendingReplies: [] }), "utf8");
  writeFileSync(`${config.paths.stateFile}.lock`, `${JSON.stringify({
    version: 1,
    pid: 999999999,
    instanceId: "dead-instance",
    lockId: "dead-lock",
    acquiredAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 60000).toISOString(),
    stateFile: config.paths.stateFile
  })}\n`, "utf8");
  writeFileSync(config.paths.runtimePidFile, "123456789\n", "utf8");
  writeFileSync(`${config.paths.runtimePidFile}.meta.json`, JSON.stringify({
    pid: 123456789,
    scriptName: "runtime-daemon.js",
    agentName: "doctor-test",
    stateDir: config.paths.root,
    instanceId: "stale-instance"
  }), "utf8");

  const startedAt = new Date().toISOString();
  const rpc = await createRuntimeRpcServer(config, async (method) => {
    assert.equal(method, "runtime_health");
    return {
      ok: true,
      pid: process.pid,
      instanceId: currentProcessInstanceId(),
      startedAt,
      lastTickAt: new Date().toISOString(),
      appServerEvents: null
    };
  });
  t.after(() => rpc.close());

  const report = await runTelegramDoctor(config, { repair: true });

  assert.equal(report.ok, true);
  assert.equal(report.signature, "healthy");
  assert.equal(report.actions.some((entry) => entry.startsWith("state_lock_quarantined")), true);
  assert.equal(report.actions.some((entry) => entry.startsWith("runtime_pid_record_repaired")), true);
  assert.equal(inspectStateLock(config.paths.stateFile).locked, false);
  assert.equal(Number.parseInt(readFileSync(config.paths.runtimePidFile, "utf8"), 10), process.pid);
  const metadata = JSON.parse(readFileSync(`${config.paths.runtimePidFile}.meta.json`, "utf8"));
  assert.equal(metadata.instanceId, currentProcessInstanceId());
  assert.equal(metadata.repairedBy, "telegram-doctor");
});

test("doctor reports but does not remove a lock owned by a live runtime", async (t) => {
  const config = fixture(t);
  writeFileSync(config.paths.stateFile, JSON.stringify({ offset: 1, queue: [], pendingReplies: [] }), "utf8");
  writeFileSync(config.paths.runtimePidFile, `${process.pid}\n`, "utf8");
  writeFileSync(`${config.paths.runtimePidFile}.meta.json`, JSON.stringify({
    pid: process.pid,
    scriptName: "runtime-daemon.js",
    agentName: config.agentName,
    stateDir: config.paths.root,
    instanceId: currentProcessInstanceId()
  }), "utf8");
  writeFileSync(`${config.paths.stateFile}.lock`, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    instanceId: currentProcessInstanceId(),
    lockId: "live-lock",
    acquiredAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 60000).toISOString(),
    stateFile: config.paths.stateFile
  })}\n`, "utf8");

  const report = await runTelegramDoctor(config, { repair: true, rpcTimeoutMs: 100 });

  assert.equal(report.stateLock.locked, true);
  assert.equal(report.stateLock.recoverable, false);
  assert.equal(report.actions.some((entry) => entry.startsWith("state_lock_quarantined")), false);
});

test("doctor reports only failure and recovery state changes", () => {
  assert.equal(doctorStateTransition("", "healthy"), null);
  assert.deepEqual(doctorStateTransition("healthy", "runtime_daemon_down"), {
    type: "alert",
    previous: "healthy",
    next: "runtime_daemon_down"
  });
  assert.equal(doctorStateTransition("runtime_daemon_down", "runtime_daemon_down"), null);
  assert.deepEqual(doctorStateTransition("runtime_daemon_down", "stale_state_lock"), {
    type: "changed",
    previous: "runtime_daemon_down",
    next: "stale_state_lock"
  });
  assert.deepEqual(doctorStateTransition("stale_state_lock", "healthy"), {
    type: "recovered",
    previous: "stale_state_lock",
    next: "healthy"
  });
});

test("doctor reports a stale active turn even before the runtime claims idle", async (t) => {
  const config = fixture(t);
  config.appServerWsUrl = "ws://127.0.0.1:1";
  config.currentThreadId = "thread-active";
  writeFileSync(config.paths.stateFile, JSON.stringify({ offset: 1, queue: [], pendingReplies: [] }), "utf8");
  writeFileSync(config.paths.runtimePidFile, `${process.pid}\n`, "utf8");
  writeFileSync(`${config.paths.runtimePidFile}.meta.json`, JSON.stringify({
    pid: process.pid,
    scriptName: "runtime-daemon.js",
    agentName: config.agentName,
    stateDir: config.paths.root,
    instanceId: currentProcessInstanceId(),
    startedAt: new Date().toISOString()
  }), "utf8");
  const rpc = await createRuntimeRpcServer(config, async () => ({
    ok: true,
    pid: process.pid,
    instanceId: currentProcessInstanceId(),
    startedAt: new Date().toISOString(),
    lastTickAt: new Date().toISOString(),
    appServerEvents: {
      connected: true,
      threadId: "thread-active",
      reason: "turn_completion_pending",
      threadStatus: "active",
      activeTurnId: "turn-stale",
      statusUpdatedAt: new Date(Date.now() - 120000).toISOString()
    }
  }));
  t.after(() => rpc.close());

  const report = await inspectTelegramDoctor(config);

  assert.equal(report.ok, false);
  assert.equal(report.issues.some((entry) => entry.code === "active_turn_stalled"), true);
});

test("doctor reconciles a stale pending reply through runtime RPC without deleting history", async (t) => {
  const config = fixture(t);
  const old = new Date(Date.now() - 60000).toISOString();
  writeFileSync(config.paths.stateFile, JSON.stringify({
    offset: 1,
    queue: [{
      id: "telegram:1:77",
      chatId: "1",
      messageId: "77",
      status: "running",
      turnId: "turn-77"
    }],
    pendingReplies: [{
      queueItemId: "telegram:1:77",
      chatId: "1",
      messageId: "77",
      status: "pending",
      turnId: "turn-77",
      createdAt: old,
      lastSignalAt: old,
      sentAt: null,
      responseMessageIds: []
    }]
  }), "utf8");
  writeFileSync(config.paths.runtimePidFile, `${process.pid}\n`, "utf8");
  writeFileSync(`${config.paths.runtimePidFile}.meta.json`, JSON.stringify({
    pid: process.pid,
    scriptName: "runtime-daemon.js",
    agentName: config.agentName,
    stateDir: config.paths.root,
    instanceId: currentProcessInstanceId(),
    startedAt: new Date().toISOString()
  }), "utf8");

  const methods = [];
  const rpc = await createRuntimeRpcServer(config, async (method) => {
    methods.push(method);
    if (method === "runtime_health") {
      return {
        ok: true,
        pid: process.pid,
        instanceId: currentProcessInstanceId(),
        startedAt: new Date().toISOString(),
        lastTickAt: new Date().toISOString(),
        appServerEvents: null
      };
    }
    if (method === "runtime_events_reconcile") {
      const state = JSON.parse(readFileSync(config.paths.stateFile, "utf8"));
      state.pendingReplies[0].status = "sent";
      state.pendingReplies[0].sentAt = new Date().toISOString();
      state.pendingReplies[0].responseMessageIds = ["7001"];
      state.queue[0].status = "replied";
      writeFileSync(config.paths.stateFile, JSON.stringify(state), "utf8");
      return { ok: true, reason: "idle_completion_recovered" };
    }
    if (method === "runtime_pending_replies_reconcile") {
      const state = JSON.parse(readFileSync(config.paths.stateFile, "utf8"));
      state.pendingReplies[0].status = "timeout_retry";
      state.pendingReplies[0].sentAt = null;
      state.pendingReplies[0].lastSignalAt = new Date().toISOString();
      state.pendingReplies[0].replyRetryAttempts = 1;
      writeFileSync(config.paths.stateFile, JSON.stringify(state), "utf8");
      return { ok: true, retrying: 1, timedOut: 0, orphaned: 0, superseded: 0, open: 1 };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  t.after(() => rpc.close());

  const report = await runTelegramDoctor(config, { repair: true });

  assert.equal(report.ok, true);
  assert.equal(methods.includes("runtime_events_reconcile"), true);
  assert.equal(methods.includes("runtime_pending_replies_reconcile"), true);
  assert.equal(methods.indexOf("runtime_pending_replies_reconcile") < methods.indexOf("runtime_events_reconcile"), true);
  assert.equal(report.actions.some((entry) => entry.startsWith("pending_replies_reconciled retrying=1")), true);
  const saved = JSON.parse(readFileSync(config.paths.stateFile, "utf8"));
  assert.equal(saved.pendingReplies.length, 1);
  assert.equal(saved.pendingReplies[0].status, "sent");
  assert.deepEqual(saved.pendingReplies[0].responseMessageIds, ["7001"]);
  assert.equal(saved.queue.length, 1);
  assert.equal(saved.queue[0].status, "replied");
});

test("doctor restarts a missing runtime daemon with the same profile", async (t) => {
  const config = fixture(t);
  let runtimePid = 0;
  t.after(async () => {
    if (runtimePid > 0) {
      try { process.kill(runtimePid, "SIGTERM"); } catch {}
      await waitFor(() => {
        try {
          process.kill(runtimePid, 0);
          return false;
        } catch {
          return true;
        }
      }, 3000).catch(() => false);
    }
  });

  const report = await runTelegramDoctor(config, { repair: true, rpcTimeoutMs: 100 });
  const spawnAction = report.actions.find((entry) => entry.startsWith("runtime_daemon_spawned"));
  assert.ok(spawnAction, `expected a runtime spawn action, got: ${report.actions.join(", ")}`);

  const health = await waitFor(
    () => callRuntimeRpc(config, "runtime_health", {}, { timeoutMs: 250 }),
    5000
  );
  runtimePid = Number(health.pid || 0);
  assert.ok(runtimePid > 0);
  assert.equal(health.profile, config.agentName);
  assert.equal(health.stateDir, config.paths.root);
  assert.equal(health.instanceId.length > 0, true);
});
