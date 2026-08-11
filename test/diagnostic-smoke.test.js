import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pollOnce } from "../telegram-plugin/lib/bridge.js";
import { diagnosticSmokeKind, isDiagnosticSmokeEntry } from "../telegram-plugin/lib/diagnostic-smoke.js";
import { defaultState } from "../telegram-plugin/lib/storage.js";
import { publishTeamRelayEvent } from "../telegram-plugin/lib/team-relay.js";

test("health and manual diagnostics are classified without matching normal text", () => {
  assert.equal(diagnosticSmokeKind({ text: "[Health Smoke] agent check" }), "health-smoke");
  assert.equal(diagnosticSmokeKind({ text: "manualtest: queue probe" }), "manualtest");
  assert.equal(isDiagnosticSmokeEntry({ scope: "transport-smoke", text: "probe" }), true);
  assert.equal(isDiagnosticSmokeEntry({ text: "Please document how manual tests work" }), false);
});

test("diagnostic messages are marked before queue, Mnemo, and relay", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-diagnostic-smoke-"));
  const relayFile = join(root, "relay.jsonl");
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_TELEGRAM_AGENT_NAME: "smoke-test",
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz123456",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "-1001",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: "both",
    BLUN_TELEGRAM_TEAM_RELAY_FILE: relayFile,
    BLUN_MNEMO_SYNC_ENABLED: "0"
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const state = {
    ...defaultState(),
    offset: 50,
    intakeCursorInitialized: true
  };
  writeFileSync(join(root, "state.json"), JSON.stringify(state), "utf8");
  writeFileSync(join(root, "state.json.bak"), JSON.stringify(state), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    result: [
      {
        update_id: 50,
        message: {
          message_id: 1,
          text: "[Health Smoke] daemon probe",
          chat: { id: -1001, type: "supergroup", title: "Test" },
          from: { id: 7, username: "health_bot", is_bot: true }
        }
      },
      {
        update_id: 51,
        message: {
          message_id: 2,
          text: "manualtest: queue probe",
          chat: { id: -1001, type: "supergroup", title: "Test" },
          from: { id: 8, username: "tester" }
        }
      }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const result = await pollOnce();

  assert.equal(result.captured, 0);
  assert.equal(result.ignored, 2);
  const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(saved.offset, 52);
  assert.deepEqual(saved.queue, []);
  const inbox = readFileSync(join(root, "inbox.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.deepEqual(inbox.map((entry) => entry.status), ["ignored_diagnostic_smoke", "ignored_diagnostic_smoke"]);
  assert.equal(existsSync(relayFile), false);
});

test("relay publishing independently rejects diagnostic smoke events", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-diagnostic-relay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const relayFile = join(root, "relay.jsonl");
  const result = await publishTeamRelayEvent({
    agentName: "test",
    teamRelayMode: "publish",
    teamRelayFile: relayFile,
    teamRelayUrl: "",
    paths: { activityFile: join(root, "activity.log") }
  }, {
    chatId: "-1001",
    messageId: "8",
    chatType: "supergroup",
    text: "[Health Smoke] independent relay probe"
  });

  assert.equal(result.published, false);
  assert.equal(result.reason, "diagnostic_smoke");
  assert.equal(existsSync(relayFile), false);
});
