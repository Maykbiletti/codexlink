#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { bindCurrentThread, bridgeStatus, consumeTeamRelayOnce, injectNext, listQueue, pollOnce, relayRepliesOnce, reply, tailActivity } from "./lib/bridge.js";
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout } from "./lib/paths.js";
import { ensureBackgroundSidecars } from "./lib/sidecars.js";

ensureStateLayout();
ensureBackgroundSidecars(loadConfig());

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

const server = new Server(
  {
    name: "codexlink-telegram",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "bridge_status",
      description: "Show BLUN Telegram bridge status, bound thread, queue depth, and recent activity pointers.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "bridge_bind_current_thread",
      description: "Bind the real Codex thread id that queued Telegram messages should inject into. If omitted, CODEX_THREAD_ID is used.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Explicit Codex thread UUID to bind." }
        }
      }
    },
    {
      name: "bridge_poll_once",
      description: "Poll Telegram one time and append any allowed inbound messages to the BLUN queue.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "bridge_list_queue",
      description: "List the most recent queued or processed bridge messages.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many queue items to return. Default 10." }
        }
      }
    },
    {
      name: "bridge_inject_next",
      description: "Inject the next queued Telegram message into the bound real Codex thread. If that thread is busy, the message remains queued.",
      inputSchema: {
        type: "object",
        properties: {
          thread_id: { type: "string", description: "Optional explicit thread id override for this injection." }
        }
      }
    },
    {
      name: "bridge_reply",
      description: "Send an explicit manual Telegram reply from the real operator/CLI.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Reply text to send." },
          chat_id: { type: "string", description: "Optional chat id override. Defaults to the latest inbound chat." },
          reply_to_message_id: { type: "string", description: "Optional Telegram message id to reply under." },
          telegram_thread_id: { type: "string", description: "Optional Telegram topic/thread id for forum-style group topics." },
          allow_private_to_group: { type: "boolean", description: "First confirmation for sending a private-DM-context reply into another chat." },
          confirm_group_broadcast: { type: "boolean", description: "Second confirmation that the user explicitly requested a group broadcast from private context." }
        },
        required: ["text"]
      }
    },
    {
      name: "bridge_relay_once",
      description: "Read the active Codex session file and relay any completed Telegram-originated final answers back to Telegram.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "bridge_team_relay_once",
      description: "Consume the shared team relay file once and queue relevant group messages that this bot did not receive raw from Telegram.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "bridge_tail_activity",
      description: "Read the last lines from the local BLUN Telegram bridge activity log.",
      inputSchema: {
        type: "object",
        properties: {
          lines: { type: "number", description: "Number of lines to read. Default 20." }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments || {};
  switch (request.params.name) {
    case "bridge_status":
      return textResult(bridgeStatus());
    case "bridge_bind_current_thread":
      return textResult(bindCurrentThread(args.thread_id || ""));
    case "bridge_poll_once":
      return textResult(await pollOnce());
    case "bridge_list_queue":
      return textResult(listQueue(Number(args.limit || 10)));
    case "bridge_inject_next":
      return textResult(await injectNext(args.thread_id || ""));
    case "bridge_reply":
      return textResult(
        await reply(String(args.text || ""), {
          chatId: args.chat_id || "",
          replyToMessageId: args.reply_to_message_id || "",
          telegramThreadId: args.telegram_thread_id || "",
          allowPrivateToGroup: args.allow_private_to_group === true,
          confirmGroupBroadcast: args.confirm_group_broadcast === true
        })
      );
    case "bridge_relay_once":
      return textResult(await relayRepliesOnce());
    case "bridge_team_relay_once":
      return textResult(await consumeTeamRelayOnce());
    case "bridge_tail_activity":
      return textResult(tailActivity(Number(args.lines || 20)));
    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
