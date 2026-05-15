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

function normalizeEvent(config, event) {
  const normalized = {
    v: 1,
    id: String(event?.id || "").trim() || buildTeamRelayEventId(event),
    ts: String(event?.ts || "").trim() || nowIso(),
    source: String(event?.source || "codexlink.telegram").trim(),
    publisherAgent: String(event?.publisherAgent || event?.agentName || "unknown").trim() || "unknown",
    ...event
  };
  normalized.id = String(normalized.id || "").trim() || buildTeamRelayEventId(normalized);
  normalized.chatId = String(normalized.chatId || "").trim();
  normalized.messageId = String(normalized.messageId || "").trim();
  normalized.text = String(normalized.text || "");
  normalized.direction = String(normalized.direction || "event").trim().toLowerCase();
  normalized.agentName = String(normalized.agentName || normalized.publisherAgent || "unknown").trim() || "unknown";
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
const host = process.env.BLUN_TELEGRAM_TEAM_RELAY_HOST || "127.0.0.1";
const port = Number.parseInt(process.env.BLUN_TELEGRAM_TEAM_RELAY_PORT || "28787", 10) || 28787;

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
