#!/usr/bin/env node
import { createServer } from "node:http";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendJsonl, nowIso } from "./lib/storage.js";
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout, getPaths } from "./lib/paths.js";
import { buildTeamRelayEventId } from "./lib/team-relay.js";

const MAX_BODY_BYTES = Number.parseInt(process.env.BLUN_TELEGRAM_TEAM_RELAY_MAX_BODY_BYTES || "1048576", 10) || 1048576;

function relayFilePath(config) {
  const explicit = String(config?.teamRelayFile || "").trim();
  if (explicit) {
    return explicit;
  }
  if (process.platform === "win32") {
    const programData = process.env.ProgramData?.trim() || "C:\\ProgramData";
    return join(programData, "Blun", "codexlink", "blun-team-relay.jsonl");
  }
  return join(getPaths().codexHome, "channels", "blun-team-relay.jsonl");
}

function jsonResponse(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text)
  });
  res.end(text);
}

function checkAuth(req, config) {
  const secret = String(config?.teamRelaySecret || "").trim();
  if (!secret) {
    return true;
  }
  const header = String(req.headers.authorization || "").trim();
  return header === `Bearer ${secret}`;
}

function readJsonlDelta(path, after) {
  if (!path || !existsSync(path)) {
    return { offset: 0, events: [] };
  }
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (String(after || "").trim().toLowerCase() === "tail") {
      return { offset: stat.size, events: [] };
    }
    const safeOffset = Math.max(0, Math.min(Number(after || 0), stat.size));
    const byteLength = Math.max(0, stat.size - safeOffset);
    if (byteLength === 0) {
      return { offset: stat.size, events: [] };
    }
    const buffer = Buffer.alloc(byteLength);
    readSync(fd, buffer, 0, byteLength, safeOffset);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (!buffer.toString("utf8").endsWith("\n")) {
      lines.pop();
    }
    const events = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Ignore malformed relay lines; the producer writes one JSON object per line.
      }
    }
    return { offset: stat.size, events };
  } finally {
    closeSync(fd);
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function firstText(...values) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }
    const text = String(value).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function normalizeEvent(config, event) {
  const publisherAgent = firstText(event?.publisherAgent, event?.publisher_agent, event?.agentName, "unknown");
  const sourceAgent = firstText(event?.sourceAgent, event?.source_agent, event?.agentName, publisherAgent);
  const targetAgent = firstText(event?.targetAgent, event?.target_agent);
  const chatId = firstText(event?.chatId, event?.chat_id);
  const messageId = firstText(event?.messageId, event?.message_id);
  const replyToMessageId = firstText(event?.replyToMessageId, event?.reply_to_message_id);
  const telegramThreadId = firstText(event?.telegramThreadId, event?.telegram_thread_id);
  const chatType = firstText(event?.chatType, event?.chat_type).toLowerCase();
  const conversationKey = firstText(event?.conversationKey, event?.conversation_key);
  const groupTitle = firstText(event?.groupTitle, event?.group_title);
  const userId = firstText(event?.userId, event?.user_id);
  const normalized = {
    v: 1,
    ...event,
    id: String(event?.id || event?.eventId || event?.event_id || "").trim(),
    ts: String(event?.ts || "").trim() || nowIso(),
    source: String(event?.source || "codexlink.telegram").trim(),
    publisherAgent,
    publisher_agent: publisherAgent,
    agentName: firstText(event?.agentName, sourceAgent, publisherAgent, "unknown"),
    sourceAgent,
    source_agent: sourceAgent,
    targetAgent,
    target_agent: targetAgent,
    chatId,
    chat_id: chatId,
    messageId,
    message_id: messageId,
    replyToMessageId,
    reply_to_message_id: replyToMessageId,
    telegramThreadId,
    telegram_thread_id: telegramThreadId,
    chatType,
    chat_type: chatType,
    conversationKey,
    conversation_key: conversationKey,
    groupTitle,
    group_title: groupTitle,
    user: firstText(event?.user, sourceAgent),
    userId,
    user_id: userId,
    scope: firstText(event?.scope),
    priority: firstText(event?.priority, "normal").toLowerCase(),
    text: String(event?.text || "")
  };
  normalized.id = String(normalized.id || "").trim() || buildTeamRelayEventId(normalized);
  normalized.direction = String(normalized.direction || "event").trim().toLowerCase();
  return normalized;
}

async function handleRequest(req, res, config, file) {
  if (!checkAuth(req, config)) {
    jsonResponse(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    jsonResponse(res, 200, { ok: true, service: "codexlink-team-relay", file });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const after = url.searchParams.get("after") || "0";
    const delta = readJsonlDelta(file, after);
    jsonResponse(res, 200, { ok: true, offset: delta.offset, events: delta.events });
    return;
  }

  if (req.method === "POST" && url.pathname === "/events") {
    const body = await readRequestBody(req);
    const raw = JSON.parse(body || "{}");
    const event = normalizeEvent(config, raw);
    if (!event.chatId || !event.messageId || !event.text.trim()) {
      jsonResponse(res, 400, { ok: false, error: "incomplete event" });
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    appendJsonl(file, event);
    jsonResponse(res, 200, { ok: true, id: event.id });
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "not found" });
}

ensureStateLayout();
const config = loadConfig();
const file = relayFilePath(config);
const host = process.env.BLUN_TELEGRAM_TEAM_RELAY_HOST || config.teamRelayHost || "127.0.0.1";
const port = Number.parseInt(process.env.BLUN_TELEGRAM_TEAM_RELAY_PORT || String(config.teamRelayPort || "28787"), 10) || 28787;

const server = createServer((req, res) => {
  handleRequest(req, res, config, file).catch((error) => {
    jsonResponse(res, 500, { ok: false, error: String(error?.message || error) });
  });
});

server.listen(port, host, () => {
  process.stdout.write(JSON.stringify({
    ok: true,
    service: "codexlink-team-relay",
    url: `http://${host}:${port}/events`,
    file,
    auth: config.teamRelaySecret ? "bearer" : "none"
  }) + "\n");
});
