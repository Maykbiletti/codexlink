import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { injectNext, pollOnce } from "../telegram-plugin/lib/bridge.js";
import { setRuntimeComposerInjector, setRuntimeTurnStarter } from "../telegram-plugin/lib/codex.js";
import { defaultState } from "../telegram-plugin/lib/storage.js";

test("an allowed group bot reaches the observe queue while the own bot is rejected", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-group-bot-"));
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_AGENT_NAME: "alfred",
    BLUN_TELEGRAM_BOT_TOKEN: "999999:abcdefghijklmnopqrstuvwxyz1234567890",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "-1001",
    BLUN_TELEGRAM_GROUP_DELIVERY: "observe",
    BLUN_TELEGRAM_APP_SERVER_WS_URL: "ws://127.0.0.1:1",
    BLUN_TELEGRAM_THREAD_ID: "thread-1",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
    BLUN_MNEMO_SYNC_ENABLED: "0"
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  const statePath = join(root, "state.json");
  writeFileSync(statePath, `${JSON.stringify({
    ...defaultState(),
    offset: 100,
    intakeCursorInitialized: true
  }, null, 2)}\n`, "utf8");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    result: [
      {
        update_id: 100,
        message: {
          message_id: 13036,
          text: "Dieter Status: Die Tests sind fertig.",
          chat: { id: -1001, type: "supergroup", title: "Agent Team" },
          from: { id: 777777, is_bot: true, username: "Dieterthe_bot" }
        }
      },
      {
        update_id: 101,
        message: {
          message_id: 13037,
          text: "Eigene gesendete Bot-Antwort.",
          chat: { id: -1001, type: "supergroup", title: "Agent Team" },
          from: { id: 999999, is_bot: true, username: "Alfred_bot" }
        }
      }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });

  const composerSubmissions = [];
  setRuntimeTurnStarter(() => {
    throw new Error("turn/start must not be used by the default TUI transport");
  });
  setRuntimeComposerInjector(async (_config, message, options) => {
    composerSubmissions.push({ id: message.id, threadId: options.threadId });
    return { ok: true, frontendPid: 4242 };
  });

  t.after(() => {
    globalThis.fetch = originalFetch;
    setRuntimeTurnStarter(null);
    setRuntimeComposerInjector(null);
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const pollResult = await pollOnce();
  assert.equal(pollResult.captured, 1);
  assert.equal(pollResult.ignored, 1);

  let state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].messageId, "13036");
  assert.equal(state.queue[0].user, "Dieterthe_bot");
  assert.equal(state.queue[0].senderIsBot, true);
  assert.equal(state.queue[0].relevance, "observe");
  assert.equal(state.queue[0].status, "queued");

  const activity = readFileSync(join(root, "activity.log"), "utf8");
  assert.match(activity, /IGNORED_OWN_BOT[^\n]*message=13037/);
  assert.doesNotMatch(activity, /IGNORED_BOT_RELAY[^\n]*message=13036/);

  let gate = { ready: true, reason: "ready", threadStatus: "idle", activeTurnId: "" };
  const dispatchResult = await injectNext("thread-1", {
    auto: true,
    runtimeDispatchGate: async () => gate,
    runtimeDispatchClaim: async ({ queueItemId }) => {
      if (!gate.ready) {
        return gate;
      }
      gate = {
        ready: false,
        reason: "turn_completion_pending",
        threadStatus: "active",
        activeTurnId: "pending-turn-id"
      };
      return {
        ready: true,
        reason: "claimed",
        threadStatus: "active",
        activeTurnId: "pending-turn-id",
        queueItemId
      };
    },
    runtimeDispatchSettled: async () => {}
  });

  assert.equal(dispatchResult.ok, true);
  assert.equal(dispatchResult.status, "delivered");
  assert.equal(dispatchResult.message.messageId, "13036");
  assert.deepEqual(composerSubmissions, [{
    id: "telegram:-1001:13036",
    threadId: "thread-1"
  }]);

  state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.queue[0].status, "delivered");
  assert.equal(state.queue[0].inputTransport, "tui_composer");
  assert.equal(state.pendingReplies.length, 0);
});
