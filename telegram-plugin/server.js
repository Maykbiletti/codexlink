#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout } from "./lib/paths.js";
import { callRuntimeRpc, waitForRuntimeRpc } from "./lib/runtime-rpc.js";
import { ensureBackgroundSidecars } from "./lib/sidecars.js";

ensureStateLayout();
let config = loadConfig();
ensureBackgroundSidecars(config, { forceRuntime: true });

function textResult(value) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }]
  };
}

const server = new Server(
  {
    name: "codexlink-runtime",
    version: "0.2.0"
  },
  {
    capabilities: { tools: {} },
    instructions: "CodexLink's durable runtime queue is authoritative. Never bypass it with console injection, hidden Codex sessions, or turn/steer for ordinary inbound work. Telegram intake is persisted by the runtime daemon and the oldest eligible item is dispatched with turn/start only when the bound thread is idle; explicit escalations may move ahead but never interrupt a turn. Use status and queue tools for inspection; use write tools only when the user explicitly requests that action."
  }
);

const tools = [
  {
    name: "runtime_health",
    description: "Check whether the persistent CodexLink runtime daemon and app-server event stream are alive.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "runtime_status",
    description: "Show the bound Codex thread, durable queue depths, runtime state, and Telegram transport status.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "runtime_queue_list",
    description: "List durable runtime queue items and their lifecycle status.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 200, description: "Maximum items to return. Default 20." } }
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: "runtime_queue_enqueue",
    description: "Administratively append work to the durable runtime queue. Telegram messages use the daemon intake path automatically.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 100000, description: "Work item text." },
        message_id: { type: "string", description: "Optional idempotency key." },
        conversation_key: { type: "string", description: "Optional conversation grouping key." },
        user: { type: "string", description: "Optional source label." }
      },
      required: ["text"]
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: "runtime_queue_cancel",
    description: "Cancel a queued, parked, or failed item before it starts. Running turns are not interrupted by this tool.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Runtime id, message id, or chatId:messageId key." } },
      required: ["id"]
    },
    annotations: { readOnlyHint: false, destructiveHint: true }
  },
  {
    name: "runtime_bind_thread",
    description: "Bind the visible Codex thread that receives queued work.",
    inputSchema: {
      type: "object",
      properties: { thread_id: { type: "string", description: "Codex thread id." } },
      required: ["thread_id"]
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: "runtime_reply",
    description: "Send an explicit Telegram reply through the runtime outbox and private-to-group safety guard.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        chat_id: { type: "string" },
        reply_to_message_id: { type: "string" },
        telegram_thread_id: { type: "string" },
        allow_private_to_group: { type: "boolean" },
        confirm_group_broadcast: { type: "boolean" }
      },
      required: ["text"]
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: "runtime_pause",
    description: "Pause FIFO dispatch while Telegram intake continues writing to the durable queue.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false }
  },
  {
    name: "runtime_resume",
    description: "Resume FIFO dispatch from the durable queue.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false }
  },
  {
    name: "runtime_approvals_list",
    description: "List unresolved app-server approval requests owned by the runtime connection.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: "runtime_approval_decide",
    description: "Resolve an app-server approval request received on the persistent runtime connection.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        decision: { type: "string", enum: ["accept", "acceptForSession", "decline", "cancel"] }
      },
      required: ["request_id", "decision"]
    },
    annotations: { readOnlyHint: false }
  },
  {
    name: "runtime_tail_activity",
    description: "Read recent CodexLink runtime activity log entries.",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "number", minimum: 1, maximum: 500 } }
    },
    annotations: { readOnlyHint: true }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

const legacyAliases = new Map([
  ["bridge_status", "runtime_status"],
  ["bridge_bind_current_thread", "runtime_bind_thread"],
  ["bridge_poll_once", "runtime_poll_once"],
  ["bridge_list_queue", "runtime_queue_list"],
  ["bridge_inject_next", "runtime_dispatch_once"],
  ["bridge_reply", "runtime_reply"],
  ["bridge_relay_once", "runtime_relay_once"],
  ["bridge_team_relay_once", "runtime_team_relay_once"],
  ["bridge_tail_activity", "runtime_tail_activity"]
]);

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  const method = legacyAliases.get(request.params.name) || request.params.name;
  config = loadConfig();
  try {
    const result = await callRuntimeRpc(config, method, args);
    return textResult(result);
  } catch (error) {
    if (Number(error?.statusCode || 0) >= 400 && Number(error?.statusCode || 0) < 500) {
      return { ...textResult({ ok: false, error: String(error.message || error) }), isError: true };
    }
    try {
      ensureBackgroundSidecars(config, { forceRuntime: true });
      await waitForRuntimeRpc(config, { timeoutMs: 10000 });
      return textResult(await callRuntimeRpc(config, method, args));
    } catch (retryError) {
      return { ...textResult({ ok: false, error: String(retryError?.message || retryError) }), isError: true };
    }
  }
});

await server.connect(new StdioServerTransport());
