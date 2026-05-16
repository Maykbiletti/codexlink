#!/usr/bin/env node
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./lib/env.js";
import { appendJsonl, appendLog, loadJson, nowIso, saveJson } from "./lib/storage.js";
import { isCurrentSidecarPid } from "./lib/singleton.js";

const intervalMs = Number.parseInt(process.env.BLUN_TELEGRAM_CLAUDE_RELAY_INTERVAL_MS || "1000", 10) || 1000;
const once = process.argv.includes("--once");
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => {
  stopping = true;
});

process.on("SIGTERM", () => {
  stopping = true;
});

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function claudeProjectDirName(cwd) {
  return String(cwd || homedir()).replace(/[:\\/]/g, "-");
}

function findClaudeJsonlBySessionId(sessionId, cwd) {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const direct = join(projectsRoot, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
  if (existsSync(direct)) {
    return direct;
  }
  try {
    for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = join(projectsRoot, entry.name, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // Best effort discovery only.
  }
  return "";
}

function discoverClaudeSessionFile() {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  try {
    const files = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const path = join(sessionsDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of files) {
      const meta = readJson(file.path, null);
      const sessionId = String(meta?.sessionId || "").trim();
      if (!sessionId) {
        continue;
      }
      const sessionFile = findClaudeJsonlBySessionId(sessionId, meta?.cwd);
      if (sessionFile) {
        return sessionFile;
      }
    }
  } catch {
    // Best effort discovery only.
  }
  return "";
}

function resolveSessionFile(config) {
  const configured = String(config.claudeRelaySessionFile || "").trim();
  if (configured && existsSync(configured)) {
    return configured;
  }
  return discoverClaudeSessionFile();
}

function readJsonlDelta(path, cursor, backfillBytes) {
  if (!path || !existsSync(path)) {
    return { lines: [], nextOffset: 0, carry: "" };
  }

  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    let offset = 0;
    let carry = "";
    let skipFirstLine = false;
    if (cursor?.path === path && Number.isFinite(Number(cursor.offset))) {
      offset = Math.max(0, Math.min(Number(cursor.offset), stat.size));
      carry = String(cursor.carry || "");
      if (Number(cursor.offset) > stat.size) {
        offset = Math.max(0, stat.size - backfillBytes);
        carry = "";
        skipFirstLine = offset > 0;
      }
    } else {
      offset = Math.max(0, stat.size - backfillBytes);
      skipFirstLine = offset > 0;
    }

    const byteLength = Math.max(0, stat.size - offset);
    if (byteLength <= 0) {
      return { lines: [], nextOffset: stat.size, carry };
    }

    const buffer = Buffer.alloc(byteLength);
    readSync(fd, buffer, 0, byteLength, offset);
    const combined = `${carry}${buffer.toString("utf8")}`;
    const lines = combined.split(/\r?\n/);
    const nextCarry = combined.endsWith("\n") ? "" : (lines.pop() || "");
    if (skipFirstLine && lines.length > 0) {
      lines.shift();
    }
    return { lines, nextOffset: stat.size, carry: nextCarry };
  } finally {
    closeSync(fd);
  }
}

function isTelegramReplyTool(name) {
  const value = String(name || "");
  return value === "mcp__plugin_telegram_telegram__reply"
    || value === "mcp__plugin_telegram_telegram__send_message"
    || value === "mcp__plugin_telegram_telegram__send";
}

function flattenContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => flattenContentText(item)).filter(Boolean).join("\n");
  }
  if (content && typeof content === "object") {
    if (typeof content.text === "string") {
      return content.text;
    }
    if (content.content) {
      return flattenContentText(content.content);
    }
  }
  return "";
}

function getContentItems(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content) ? content : [];
}

function normalizeReplyTo(input) {
  const raw = input?.reply_to ?? input?.replyTo ?? input?.reply_to_message_id ?? input?.replyToMessageId ?? "";
  if (raw && typeof raw === "object") {
    return String(raw.message_id || raw.messageId || "").trim();
  }
  return String(raw || "").trim();
}

function collectToolUses(entry, pending) {
  if (entry?.type !== "assistant") {
    return;
  }
  for (const item of getContentItems(entry)) {
    if (item?.type !== "tool_use" || !isTelegramReplyTool(item.name)) {
      continue;
    }
    const input = item.input || {};
    const toolUseId = String(item.id || "").trim();
    const chatId = String(input.chat_id || input.chatId || "").trim();
    const text = String(input.text || input.message || "").trim();
    if (!toolUseId || !chatId || !text) {
      continue;
    }
    pending.set(toolUseId, {
      toolUseId,
      ts: String(entry.timestamp || "").trim() || nowIso(),
      chatId,
      text,
      replyToMessageId: normalizeReplyTo(input),
      telegramThreadId: String(input.message_thread_id || input.threadId || "").trim()
    });
  }
}

function collectToolResults(entry) {
  if (entry?.type !== "user") {
    return [];
  }
  const results = [];
  for (const item of getContentItems(entry)) {
    if (item?.type !== "tool_result") {
      continue;
    }
    const resultText = flattenContentText(item.content || entry.toolUseResult || "");
    const match = resultText.match(/sent\s*\(\s*id:\s*([0-9]+)\s*\)/i);
    if (!match) {
      continue;
    }
    results.push({
      toolUseId: String(item.tool_use_id || "").trim(),
      messageId: match[1],
      ts: String(entry.timestamp || "").trim() || nowIso()
    });
  }
  return results;
}

function buildRelayEvent(config, pending, result) {
  const agentName = String(config.claudeRelayAgentName || "claude").trim() || "claude";
  const chatType = pending.chatId.startsWith("-") ? "supergroup" : "private";
  const threadId = String(pending.telegramThreadId || "").trim();
  return {
    v: 1,
    id: `claude-telegram:${agentName}:${result.messageId}`,
    ts: result.ts || pending.ts || nowIso(),
    source: "claude.telegram.transcript",
    publisherAgent: agentName,
    agentName,
    direction: "outbound",
    status: "sent",
    chatId: pending.chatId,
    messageId: String(result.messageId || "").trim(),
    replyToMessageId: String(pending.replyToMessageId || "").trim(),
    telegramThreadId: threadId,
    chatType,
    conversationKey: `${pending.chatId}:${threadId || "root"}`,
    groupTitle: String(config.claudeRelayGroupTitle || "").trim(),
    user: String(config.claudeRelayUser || agentName).trim() || agentName,
    userId: String(config.claudeRelayUserId || "").trim(),
    senderIsBot: true,
    sourceTurnId: pending.toolUseId,
    text: pending.text
  };
}

function publishRelayEvent(config, event, publishedIds) {
  if (!event.chatId || !event.messageId || !event.text.trim()) {
    return false;
  }
  if (publishedIds.has(event.id)) {
    return false;
  }
  const relayFile = String(config.teamRelayFile || "").trim();
  if (!relayFile) {
    return false;
  }
  mkdirSync(dirname(relayFile), { recursive: true });
  appendJsonl(relayFile, event);
  appendLog(config.paths.activityFile, `CLAUDE_RELAY_PUBLISH id=${event.id} chat=${event.chatId} message=${event.messageId} agent=${event.agentName}`);
  publishedIds.add(event.id);
  return true;
}

async function consumeClaudeRelayOnce() {
  const config = loadConfig();
  const sessionFile = resolveSessionFile(config);
  if (!sessionFile) {
    appendLog(config.paths.activityFile, "CLAUDE_RELAY_NO_SESSION");
    return { ok: true, disabled: true, published: 0, sessionFile: null };
  }

  const cursor = loadJson(config.paths.claudeRelayCursorFile, null);
  const pending = new Map(
    Array.isArray(cursor?.pendingToolUses)
      ? cursor.pendingToolUses.map((item) => [String(item.toolUseId || ""), item]).filter(([key]) => key)
      : []
  );
  const publishedIds = new Set(Array.isArray(cursor?.publishedIds) ? cursor.publishedIds : []);
  const delta = readJsonlDelta(sessionFile, cursor, config.claudeRelayBackfillBytes || 262144);
  let published = 0;
  let parsed = 0;

  for (const line of delta.lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry = null;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    parsed += 1;
    collectToolUses(entry, pending);
    for (const result of collectToolResults(entry)) {
      const toolUse = pending.get(result.toolUseId);
      if (!toolUse) {
        continue;
      }
      const event = buildRelayEvent(config, toolUse, result);
      if (publishRelayEvent(config, event, publishedIds)) {
        published += 1;
      }
      pending.delete(result.toolUseId);
    }
  }

  saveJson(config.paths.claudeRelayCursorFile, {
    path: sessionFile,
    offset: delta.nextOffset,
    carry: delta.carry,
    pendingToolUses: Array.from(pending.values()).slice(-100),
    publishedIds: Array.from(publishedIds).slice(-1000),
    updatedAt: nowIso()
  });

  return {
    ok: true,
    published,
    parsed,
    sessionFile
  };
}

async function main() {
  do {
    if (!once && !isCurrentSidecarPid("claudeRelay")) {
      break;
    }
    try {
      const result = await consumeClaudeRelayOnce();
      if (result.published > 0 || once) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), kind: "claude_relay", result }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        kind: "error",
        error: `${error?.stack || error}`
      }));
    }
    if (!once) {
      await sleep(intervalMs);
    }
  } while (!once && !stopping);
}

await main();
