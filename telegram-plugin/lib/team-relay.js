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
  return isTeamRelayConfigured(config) && (mode === "consume" || mode === "both");
}

export function shouldSharePrivateRelay(config) {
  return /^(1|true|yes|on)$/i.test(String(config?.teamRelayPrivate || ""));
}

function relayFetchOptions(config, options = {}) {
  const timeoutMs = Math.max(100, Number.parseInt(String(config?.teamRelayTimeoutMs || "750"), 10) || 750);
  return {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  };
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

function relayField(event, camelName, snakeName = "") {
  return firstText(event?.[camelName], snakeName ? event?.[snakeName] : "");
}

export function buildTeamRelayEventId(event) {
  const sourceAgent = firstText(
    event?.sourceAgent,
    event?.source_agent,
    event?.user,
    event?.agentName,
    event?.publisherAgent,
    "unknown"
  );
  const chatId = relayField(event, "chatId", "chat_id");
  const messageId = relayField(event, "messageId", "message_id");
  if (sourceAgent && chatId && messageId) {
    return `telegram:${sourceAgent}:${chatId}:${messageId}`;
  }
  return `relay:${String(event?.direction || "event")}:${String(event?.agentName || "unknown")}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function normalizeRelayEvent(config, event) {
  const publisherAgent = firstText(event?.publisherAgent, event?.publisher_agent, config?.agentName, "default");
  const sourceAgent = firstText(event?.sourceAgent, event?.source_agent, event?.agentName, publisherAgent);
  const targetAgent = firstText(event?.targetAgent, event?.target_agent);
  const chatId = relayField(event, "chatId", "chat_id");
  const messageId = relayField(event, "messageId", "message_id");
  const replyToMessageId = relayField(event, "replyToMessageId", "reply_to_message_id");
  const telegramThreadId = relayField(event, "telegramThreadId", "telegram_thread_id");
  const chatType = relayField(event, "chatType", "chat_type").toLowerCase();
  const conversationKey = relayField(event, "conversationKey", "conversation_key");
  const groupTitle = relayField(event, "groupTitle", "group_title");
  const userId = relayField(event, "userId", "user_id");
  const normalized = {
    v: 1,
    ...event,
    id: String(event?.id || event?.eventId || event?.event_id || "").trim(),
    ts: String(event?.ts || "").trim() || nowIso(),
    source: String(event?.source || "codexlink.telegram").trim() || "codexlink.telegram",
    publisherAgent,
    publisher_agent: publisherAgent,
    agentName: firstText(event?.agentName, sourceAgent, publisherAgent, "default"),
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

  const response = await fetch(url, relayFetchOptions(config, {
    method: "POST",
    headers,
    body: JSON.stringify(event)
  }));
  if (!response.ok) {
    throw new Error(`team relay url returned HTTP ${response.status}`);
  }
  return { ok: true, status: response.status };
}

function buildRelayUrl(config, after) {
  const rawUrl = String(config?.teamRelayUrl || "").trim();
  if (!rawUrl) {
    return "";
  }
  const url = new URL(rawUrl);
  url.searchParams.set("after", String(after ?? 0));
  return url.toString();
}

async function readRelayUrlDelta(config, after) {
  const url = buildRelayUrl(config, after);
  if (!url) {
    return { nextOffset: after || 0, items: [], disabled: true };
  }

  const headers = {};
  const secret = String(config?.teamRelaySecret || "").trim();
  if (secret) {
    headers.authorization = `Bearer ${secret}`;
  }

  const response = await fetch(url, relayFetchOptions(config, { headers }));
  if (!response.ok) {
    throw new Error(`team relay url returned HTTP ${response.status}`);
  }
  const json = await response.json();
  const items = Array.isArray(json) ? json : (Array.isArray(json.events) ? json.events : []);
  const nextOffset = Number(json.offset ?? json.nextOffset ?? after ?? 0);
  return {
    nextOffset: Number.isFinite(nextOffset) ? nextOffset : Number(after || 0),
    items
  };
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
  let fileError = "";
  const file = String(config?.teamRelayFile || "").trim();
  if (file) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendJsonl(file, relayEvent);
      filePublished = true;
    } catch (error) {
      fileError = String(error?.message || error);
      appendLog(config.paths.activityFile, `TEAM_RELAY_FILE_ERROR id=${relayEvent.id}: ${fileError}`);
    }
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
    fileError: fileError || undefined,
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

export async function readTeamRelayDelta(config) {
  const file = String(config?.teamRelayFile || "").trim();
  const url = String(config?.teamRelayUrl || "").trim();
  const cursorFile = String(config?.paths?.teamRelayCursorFile || "").trim();
  if (!teamRelayConsumes(config) || (!file && !url) || !cursorFile) {
    return { ok: true, disabled: true, cursor: null, items: [] };
  }

  const cursor = loadJson(cursorFile, null);
  if (!cursor) {
    const start = String(config?.teamRelayStart || "tail").trim().toLowerCase();
    if (start !== "beginning") {
      const initial = { offset: 0, remoteOffset: 0, carry: "", seenIds: [] };
      if (file && existsSync(file)) {
        initial.offset = statSync(file).size;
      }
      if (url) {
        try {
          const remote = await readRelayUrlDelta(config, "tail");
          initial.remoteOffset = remote.nextOffset;
        } catch (error) {
          appendLog(config.paths.activityFile, `TEAM_RELAY_URL_READ_ERROR: ${String(error?.message || error)}`);
        }
      }
      saveJson(cursorFile, initial);
      return { ok: true, cursor: initial, items: [], initializedAtTail: true };
    }
  }

  const current = cursor || { offset: 0, remoteOffset: 0, carry: "", seenIds: [] };
  const fileDelta = file ? readJsonlDelta(file, current.offset, current.carry) : { nextOffset: Number(current.offset || 0), carry: "", items: [] };
  let remoteDelta = { nextOffset: Number(current.remoteOffset || 0), items: [] };
  if (url) {
    try {
      remoteDelta = await readRelayUrlDelta(config, current.remoteOffset || 0);
    } catch (error) {
      appendLog(config.paths.activityFile, `TEAM_RELAY_URL_READ_ERROR: ${String(error?.message || error)}`);
    }
  }
  const seenIds = Array.isArray(current.seenIds) ? current.seenIds.slice(-400) : [];
  const nextCursor = {
    offset: fileDelta.nextOffset,
    remoteOffset: remoteDelta.nextOffset,
    carry: fileDelta.carry,
    seenIds
  };
  return {
    ok: true,
    cursor: nextCursor,
    previousCursor: current,
    items: [...fileDelta.items, ...remoteDelta.items]
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
    cursorOffset: cursor?.offset ?? null,
    cursorRemoteOffset: cursor?.remoteOffset ?? null
  };
}
