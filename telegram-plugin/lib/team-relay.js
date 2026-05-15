import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { appendJsonl, appendLog, loadJson, nowIso, saveJson } from "./storage.js";

function normalizeMode(value) {
  const mode = String(value || "off").trim().toLowerCase();
  if (["on", "enabled", "both"].includes(mode)) {
    return "both";
  }
  if (["publish", "publisher", "write"].includes(mode)) {
    return "publish";
  }
  if (["consume", "consumer", "read"].includes(mode)) {
    return "consume";
  }
  return "off";
}

export function getTeamRelayMode(config) {
  return normalizeMode(config?.teamRelayMode);
}

export function isTeamRelayConfigured(config) {
  return Boolean(String(config?.teamRelayFile || "").trim() || String(config?.teamRelayUrl || "").trim());
}

export function teamRelayPublishes(config) {
  const mode = getTeamRelayMode(config);
  return isTeamRelayConfigured(config) && (mode === "publish" || mode === "both");
}

export function teamRelayConsumes(config) {
  const mode = getTeamRelayMode(config);
  return Boolean(String(config?.teamRelayFile || "").trim()) && (mode === "consume" || mode === "both");
}

export function shouldSharePrivateRelay(config) {
  return /^(1|true|yes|on)$/i.test(String(config?.teamRelayPrivate || ""));
}

export function buildTeamRelayEventId(event) {
  const chatId = String(event?.chatId || "").trim();
  const messageId = String(event?.messageId || "").trim();
  if (chatId && messageId) {
    return `telegram:${chatId}:${messageId}`;
  }
  return `relay:${String(event?.direction || "event")}:${String(event?.agentName || "unknown")}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizeRelayEvent(config, event) {
  const normalized = {
    v: 1,
    id: String(event?.id || event?.eventId || "").trim() || buildTeamRelayEventId(event),
    ts: String(event?.ts || "").trim() || nowIso(),
    source: "codexlink.telegram",
    publisherAgent: String(config?.agentName || "default").trim() || "default",
    ...event
  };
  normalized.id = String(normalized.id || "").trim() || buildTeamRelayEventId(normalized);
  normalized.agentName = String(normalized.agentName || config?.agentName || "default").trim() || "default";
  normalized.direction = String(normalized.direction || "event").trim().toLowerCase();
  normalized.chatId = String(normalized.chatId || "").trim();
  normalized.messageId = String(normalized.messageId || "").trim();
  normalized.chatType = String(normalized.chatType || "").trim().toLowerCase();
  normalized.text = String(normalized.text || "");
  return normalized;
}

async function publishRelayUrl(config, event) {
  const url = String(config?.teamRelayUrl || "").trim();
  if (!url) {
    return { ok: true, skipped: true };
  }

  const headers = { "content-type": "application/json" };
  const secret = String(config?.teamRelaySecret || "").trim();
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(event)
  });
  if (!response.ok) {
    throw new Error(`team relay url returned HTTP ${response.status}`);
  }
  return { ok: true, status: response.status };
}

export async function publishTeamRelayEvent(config, event) {
  if (!teamRelayPublishes(config)) {
    return { ok: true, published: false, reason: "disabled" };
  }

  const relayEvent = normalizeRelayEvent(config, event);
  if (!relayEvent.chatId || !relayEvent.messageId || !relayEvent.text.trim()) {
    return { ok: true, published: false, reason: "incomplete" };
  }
  if (relayEvent.chatType === "private" && !shouldSharePrivateRelay(config)) {
    return { ok: true, published: false, reason: "private_skipped" };
  }

  let filePublished = false;
  const file = String(config?.teamRelayFile || "").trim();
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    appendJsonl(file, relayEvent);
    filePublished = true;
  }

  let urlPublished = false;
  try {
    const result = await publishRelayUrl(config, relayEvent);
    urlPublished = Boolean(!result.skipped);
  } catch (error) {
    appendLog(config.paths.activityFile, `TEAM_RELAY_URL_ERROR id=${relayEvent.id}: ${String(error?.message || error)}`);
  }

  if (filePublished || urlPublished) {
    appendLog(config.paths.activityFile, `TEAM_RELAY_PUBLISH id=${relayEvent.id} direction=${relayEvent.direction} chat=${relayEvent.chatId} message=${relayEvent.messageId} agent=${relayEvent.agentName}`);
  }

  return {
    ok: true,
    published: filePublished || urlPublished,
    event: relayEvent
  };
}

function readJsonlDelta(path, offset, carry = "") {
  if (!path || !existsSync(path)) {
    return { nextOffset: 0, carry, items: [] };
  }

  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const safeOffset = Math.max(0, Math.min(Number(offset || 0), stat.size));
    const byteLength = Math.max(0, stat.size - safeOffset);
    let chunk = "";
    if (byteLength > 0) {
      const buffer = Buffer.alloc(byteLength);
      readSync(fd, buffer, 0, byteLength, safeOffset);
      chunk = buffer.toString("utf8");
    }
    const combined = `${carry || ""}${chunk}`;
    const lines = combined.split(/\r?\n/);
    const trailingCarry = combined.endsWith("\n") ? "" : (lines.pop() || "");
    const items = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        items.push(JSON.parse(trimmed));
      } catch {
        // Malformed partial relay lines are skipped; carry handles incomplete tails.
      }
    }
    return {
      nextOffset: stat.size,
      carry: trailingCarry,
      items
    };
  } finally {
    closeSync(fd);
  }
}

export function readTeamRelayDelta(config) {
  const file = String(config?.teamRelayFile || "").trim();
  const cursorFile = String(config?.paths?.teamRelayCursorFile || "").trim();
  if (!teamRelayConsumes(config) || !file || !cursorFile) {
    return { ok: true, disabled: true, cursor: null, items: [] };
  }

  const cursor = loadJson(cursorFile, null);
  if (!cursor) {
    const start = String(config?.teamRelayStart || "tail").trim().toLowerCase();
    if (start !== "beginning" && existsSync(file)) {
      const size = statSync(file).size;
      const initial = { offset: size, carry: "", seenIds: [] };
      saveJson(cursorFile, initial);
      return { ok: true, cursor: initial, items: [], initializedAtTail: true };
    }
  }

  const current = cursor || { offset: 0, carry: "", seenIds: [] };
  const delta = readJsonlDelta(file, current.offset, current.carry);
  const seenIds = Array.isArray(current.seenIds) ? current.seenIds.slice(-400) : [];
  const nextCursor = {
    offset: delta.nextOffset,
    carry: delta.carry,
    seenIds
  };
  return {
    ok: true,
    cursor: nextCursor,
    previousCursor: current,
    items: delta.items
  };
}

export function saveTeamRelayCursor(config, cursor) {
  const cursorFile = String(config?.paths?.teamRelayCursorFile || "").trim();
  if (!cursorFile || !cursor) {
    return;
  }
  mkdirSync(dirname(cursorFile), { recursive: true });
  saveJson(cursorFile, cursor);
}

export function rememberTeamRelayIds(cursor, ids) {
  const existing = Array.isArray(cursor?.seenIds) ? cursor.seenIds : [];
  return {
    ...(cursor || {}),
    seenIds: Array.from(new Set([...existing, ...ids].filter(Boolean))).slice(-400)
  };
}

export function teamRelayStatus(config) {
  const file = String(config?.teamRelayFile || "").trim();
  const cursor = loadJson(config?.paths?.teamRelayCursorFile || "", null);
  return {
    mode: getTeamRelayMode(config),
    configured: isTeamRelayConfigured(config),
    publishes: teamRelayPublishes(config),
    consumes: teamRelayConsumes(config),
    file: file || null,
    url: config?.teamRelayUrl ? "[configured]" : null,
    privateShared: shouldSharePrivateRelay(config),
    cursorOffset: cursor?.offset ?? null
  };
}
