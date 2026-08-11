import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pollOnce } from "../telegram-plugin/lib/bridge.js";
import { inspectStateLock, withStateFileLock } from "../telegram-plugin/lib/state-lock.js";
import { defaultState } from "../telegram-plugin/lib/storage.js";

function lockConfig(root) {
  return {
    paths: {
      root,
      stateFile: join(root, "state.json"),
      activityFile: join(root, "activity.log")
    }
  };
}

function writeDeadOwnerLock(stateFile) {
  writeFileSync(`${stateFile}.lock`, `${JSON.stringify({
    version: 1,
    pid: 999999999,
    instanceId: "dead-runtime",
    lockId: "orphaned-lock",
    acquiredAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 60000).toISOString(),
    stateFile
  })}\n`, "utf8");
}

test("a dead owner's state lock is quarantined before the next write", (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = lockConfig(root);
  writeDeadOwnerLock(config.paths.stateFile);

  let entered = false;
  withStateFileLock(config, () => { entered = true; });

  assert.equal(entered, true);
  assert.equal(inspectStateLock(config.paths.stateFile).locked, false);
  const quarantined = readdirSync(root).filter((name) => name.startsWith("state.json.lock.stale-"));
  assert.equal(quarantined.length, 1);
  assert.match(readFileSync(config.paths.activityFile, "utf8"), /STATE_LOCK_QUARANTINED reason=owner_process_dead/);
});

test("an active lock owner is never removed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-lock-live-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const config = lockConfig(root);
  writeFileSync(`${config.paths.stateFile}.lock`, `${JSON.stringify({
    version: 1,
    pid: child.pid,
    instanceId: "live-runtime",
    lockId: "active-lock",
    acquiredAt: new Date().toISOString(),
    leaseUntil: new Date(Date.now() + 10000).toISOString(),
    stateFile: config.paths.stateFile
  })}\n`, "utf8");

  assert.throws(
    () => withStateFileLock(config, () => {}, { timeoutMs: 300, staleAfterMs: 5000 }),
    (error) => error?.code === "STATE_LOCK_TIMEOUT"
  );
  assert.equal(inspectStateLock(config.paths.stateFile).locked, true);
  assert.equal(readdirSync(root).some((name) => name.startsWith("state.json.lock.stale-")), false);
});

test("Telegram intake recovers automatically from an orphaned state lock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-lock-intake-"));
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_AGENT_NAME: "lock-test",
    BLUN_TELEGRAM_BOT_TOKEN: "999999:abcdefghijklmnopqrstuvwxyz123456",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "-1001",
    BLUN_TELEGRAM_GROUP_DELIVERY: "all",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
    BLUN_MNEMO_SYNC_ENABLED: "0"
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    result: [{
      update_id: 5060,
      message: {
        message_id: 5060,
        text: "Neue Nachricht nach Lock-Recovery",
        chat: { id: -1001, type: "supergroup", title: "Testgruppe" },
        from: { id: 7, username: "mayk", is_bot: false }
      }
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const state = {
    ...defaultState(),
    offset: 5060,
    intakeCursorInitialized: true,
    intakeInitializedAt: new Date().toISOString()
  };
  writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");
  writeFileSync(join(root, "state.json.bak"), JSON.stringify(state), "utf8");
  writeDeadOwnerLock(join(root, "state.json"));

  const result = await pollOnce();

  assert.equal(result.captured, 1);
  const persisted = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(persisted.lastInbound.messageId, "5060");
  assert.equal(persisted.queue.some((item) => item.messageId === "5060"), true);
  assert.equal(inspectStateLock(join(root, "state.json")).locked, false);
});
