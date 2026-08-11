import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8"));
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("runtime daemon serves authenticated health without a Telegram token", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "codexlink-daemon-"));
  const daemonPath = resolve("telegram-plugin/runtime-daemon.js");
  const child = spawn(process.execPath, [daemonPath], {
    cwd: resolve("."),
    env: {
      ...process.env,
      BLUN_TELEGRAM_STATE_DIR: stateDir,
      BLUN_CODEX_RUNTIME_DIR: join(stateDir, "runtime"),
      BLUN_TELEGRAM_AGENT_NAME: "runtime-test",
      BLUN_TELEGRAM_BOT_TOKEN: "",
      BLUN_TELEGRAM_ALLOWED_CHAT_ID: "",
      BLUN_TELEGRAM_APP_SERVER_WS_URL: "",
      BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
      BLUN_CODEXLINK_DOCTOR_WATCH: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  const endpoint = await waitForFile(join(stateDir, "runtime-endpoint.json"));
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${endpoint.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ method: "runtime_health", params: {} })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.pid, child.pid);
  assert.ok(payload.result.instanceId);
  assert.equal(payload.result.paused, false);
});
