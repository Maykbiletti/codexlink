import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server exposes the runtime control plane and reaches the daemon", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "codexlink-mcp-"));
  const client = new Client({ name: "codexlink-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("telegram-plugin/server.js")],
    cwd: resolve("."),
    env: {
      PATH: process.env.PATH || "",
      BLUN_TELEGRAM_STATE_DIR: stateDir,
      BLUN_CODEX_RUNTIME_DIR: join(stateDir, "runtime"),
      BLUN_TELEGRAM_AGENT_NAME: "mcp-test",
      BLUN_TELEGRAM_BOT_TOKEN: "",
      BLUN_TELEGRAM_ALLOWED_CHAT_ID: "",
      BLUN_TELEGRAM_APP_SERVER_WS_URL: "",
      BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
      BLUN_CODEXLINK_DOCTOR_WATCH: "0"
    },
    stderr: "pipe"
  });

  t.after(async () => {
    await client.close().catch(() => {});
    const pidFile = join(stateDir, "runtime-daemon.pid");
    if (existsSync(pidFile)) {
      const runtimePid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (runtimePid > 0) {
        try { process.kill(runtimePid, "SIGTERM"); } catch {}
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes("runtime_health"));
  assert.ok(names.includes("runtime_queue_enqueue"));
  assert.ok(names.includes("runtime_approval_decide"));
  assert.equal(names.some((name) => name.startsWith("bridge_")), false);

  const health = await client.callTool({ name: "runtime_health", arguments: {} });
  assert.equal(health.isError, undefined);
  const payload = JSON.parse(health.content[0].text);
  assert.equal(payload.ok, true);
  assert.equal(payload.paused, false);
});
