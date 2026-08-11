import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeRuntimeTurnFromEvent, reconcileRuntimePendingReplies } from "../telegram-plugin/lib/bridge.js";
import { defaultState } from "../telegram-plugin/lib/storage.js";

test("pending-reply timeout is marked and safely retried without deleting history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-pending-recovery-"));
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_AGENT_NAME: "pending-recovery-test",
    BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS: "1000",
    BLUN_TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz123456",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "1",
    BLUN_TELEGRAM_APP_SERVER_WS_URL: "",
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
    result: { message_id: 9001, chat: { id: 1 } }
  }), { status: 200, headers: { "content-type": "application/json" } });
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const old = new Date(Date.now() - 60000).toISOString();
  const fresh = new Date().toISOString();
  const state = {
    ...defaultState(),
    offset: 10,
    intakeCursorInitialized: true,
    queue: [
      {
        id: "telegram:1:101",
        chatId: "1",
        messageId: "101",
        conversationKey: "1:same-chat",
        status: "running",
        turnId: "turn-stale"
      },
      {
        id: "telegram:1:102",
        chatId: "1",
        messageId: "102",
        conversationKey: "1:same-chat",
        status: "replied",
        turnId: "turn-finished"
      }
    ],
    pendingReplies: [
      {
        queueItemId: "telegram:1:101",
        chatId: "1",
        messageId: "101",
        conversationKey: "1:same-chat",
        status: "pending",
        turnId: "turn-stale",
        createdAt: old,
        lastSignalAt: old,
        sentAt: null,
        responseMessageIds: []
      },
      {
        queueItemId: "telegram:1:102",
        chatId: "1",
        messageId: "102",
        conversationKey: "1:same-chat",
        status: "pending",
        turnId: "turn-finished",
        createdAt: fresh,
        lastSignalAt: fresh,
        sentAt: null,
        responseMessageIds: []
      }
    ]
  };
  writeFileSync(join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const result = reconcileRuntimePendingReplies();

  assert.deepEqual(result, {
    ok: true,
    retrying: 1,
    timedOut: 0,
    orphaned: 1,
    superseded: 0,
    retained: 2,
    open: 1
  });
  let saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(saved.pendingReplies.length, 2);
  assert.equal(saved.pendingReplies[0].status, "timeout_retry");
  assert.equal(saved.pendingReplies[0].replyRetryAttempts, 1);
  assert.equal(saved.pendingReplies[1].status, "orphaned");
  assert.equal(saved.queue.length, 2);
  assert.equal(saved.queue[0].status, "running");
  assert.equal(saved.queue[1].status, "replied");

  const delivery = await completeRuntimeTurnFromEvent({
    threadId: "thread-1",
    turnId: "turn-stale",
    status: "completed",
    finalText: "Diese Antwort wird nach dem Timeout erneut zugestellt."
  });

  assert.equal(delivery.delivered, true);
  assert.deepEqual(delivery.messageIds, ["9001"]);
  saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(saved.pendingReplies.length, 2);
  assert.equal(saved.pendingReplies[0].status, "sent");
  assert.deepEqual(saved.pendingReplies[0].responseMessageIds, ["9001"]);
  assert.equal(saved.queue[0].status, "replied");
});

test("a turn completion claims one human reply target before concurrent delivery", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-reply-claim-"));
  const previous = new Map();
  const values = {
    BLUN_TELEGRAM_STATE_DIR: root,
    BLUN_CODEX_RUNTIME_DIR: join(root, "runtime"),
    BLUN_TELEGRAM_AGENT_NAME: "reply-claim-test",
    BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS: "60000",
    BLUN_TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz123456",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: "1",
    BLUN_TELEGRAM_APP_SERVER_WS_URL: "",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: "off",
    BLUN_MNEMO_SYNC_ENABLED: "0"
  };
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  let fetchCalls = 0;
  const requestBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    fetchCalls += 1;
    requestBodies.push(JSON.parse(String(options?.body || "{}")));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(JSON.stringify({
      ok: true,
      result: { message_id: 9100, chat: { id: 1 } }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
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
    offset: 10,
    intakeCursorInitialized: true,
    queue: [
      {
        id: "telegram:1:201",
        chatId: "1",
        messageId: "201",
        conversationKey: "1:dm",
        status: "running",
        turnId: "turn-shared"
      },
      {
        id: "telegram:-100:301",
        chatId: "-100",
        messageId: "301",
        conversationKey: "-100:root",
        status: "running",
        turnId: "turn-shared"
      }
    ],
    pendingReplies: [
      {
        queueItemId: "telegram:1:201",
        chatId: "1",
        messageId: "201",
        replyToMessageId: "201",
        chatType: "private",
        conversationKey: "1:dm",
        user: "Mayk",
        senderIsBot: false,
        status: "running",
        turnId: "turn-shared",
        threadId: "thread-1",
        createdAt: "2026-08-11T10:00:00.000Z",
        sentAt: null,
        responseMessageIds: []
      },
      {
        queueItemId: "telegram:-100:301",
        chatId: "-100",
        messageId: "301",
        replyToMessageId: "301",
        chatType: "supergroup",
        conversationKey: "-100:root",
        user: "Dieterthe_bot",
        senderIsBot: true,
        status: "running",
        turnId: "turn-shared",
        threadId: "thread-1",
        createdAt: "2026-08-11T10:00:01.000Z",
        sentAt: null,
        responseMessageIds: []
      }
    ]
  };
  writeFileSync(join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const event = {
    threadId: "thread-1",
    turnId: "turn-shared",
    status: "completed",
    finalText: "Genau einmal an Mayk."
  };
  const results = await Promise.all([
    completeRuntimeTurnFromEvent(event),
    completeRuntimeTurnFromEvent(event)
  ]);

  assert.equal(fetchCalls, 1);
  assert.equal(requestBodies[0].chat_id, "1");
  assert.equal(results.filter((item) => item.delivered).length, 1);
  const saved = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
  assert.equal(saved.pendingReplies.find((item) => item.queueItemId === "telegram:1:201")?.status, "sent");
  assert.equal(saved.pendingReplies.find((item) => item.queueItemId === "telegram:-100:301")?.status, "superseded");
  assert.deepEqual(saved.pendingReplies.find((item) => item.queueItemId === "telegram:1:201")?.responseMessageIds, ["9100"]);
});
