import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listLoadedThreadsOverWs, readThreadOverWs } from "./app-server-client.js";
import { loadConfig } from "./env.js";
import { injectIntoThread } from "./codex.js";
import { getUpdates, sendMessage } from "./telegram.js";
import { appendJsonl, appendLog, defaultState, loadJson, nowIso, readTail, saveJson } from "./storage.js";

function loadState(config) {
  return loadJson(config.paths.stateFile, defaultState());
}

function saveStateForConfig(config, state) {
  saveJson(config.paths.stateFile, state);
}

function queueKey(entry) {
  return `${entry.chatId}:${entry.messageId}`;
}

function pendingReplyKey(entry) {
  return entry.turnId || `${entry.threadId || ""}:${entry.chatId}:${entry.messageId}`;
}

function statusWeight(status) {
  switch (status) {
    case "delivered":
    case "error":
      return 4;
    case "submitted":
      return 2;
    case "queued":
    default:
      return 1;
  }
}

function pickIsoLater(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  return left >= right ? left : right;
}

function pickLatestRecord(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }
  const currentStamp = current.ts || current.deliveredAt || current.lastAttemptAt || "";
  const incomingStamp = incoming.ts || incoming.deliveredAt || incoming.lastAttemptAt || "";
  if (incomingStamp > currentStamp) {
    return { ...incoming };
  }
  if (incomingStamp < currentStamp) {
    return { ...current };
  }
  const currentId = Number(current.messageId || 0);
  const incomingId = Number(incoming.messageId || 0);
  return incomingId >= currentId ? { ...incoming } : { ...current };
}

function mergeQueueEntry(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }

  const merged = {
    ...current,
    ...incoming
  };

  if (statusWeight(current.status) > statusWeight(incoming.status)) {
    merged.status = current.status;
  } else if (statusWeight(incoming.status) > statusWeight(current.status)) {
    merged.status = incoming.status;
  }

  merged.attempts = Math.max(Number(current.attempts || 0), Number(incoming.attempts || 0));
  merged.lastAttemptAt = pickIsoLater(current.lastAttemptAt, incoming.lastAttemptAt);
  merged.submittedAt = pickIsoLater(current.submittedAt, incoming.submittedAt);
  merged.deliveredAt = pickIsoLater(current.deliveredAt, incoming.deliveredAt);
  merged.ts = pickIsoLater(current.ts, incoming.ts);

  for (const field of ["threadId", "responsePreview", "stderr", "stdout", "chatType", "conversationKey", "groupTitle", "telegramThreadId", "senderIsBot"]) {
    if (!merged[field]) {
      merged[field] = current[field] || incoming[field] || null;
    }
  }

  return merged;
}

function mergeQueueLists(baseQueue, incomingQueue) {
  const mergedByKey = new Map();
  const orderedKeys = [];

  for (const entry of baseQueue || []) {
    const key = queueKey(entry);
    if (!mergedByKey.has(key)) {
      orderedKeys.push(key);
      mergedByKey.set(key, { ...entry });
      continue;
    }
    mergedByKey.set(key, mergeQueueEntry(mergedByKey.get(key), entry));
  }

  for (const entry of incomingQueue || []) {
    const key = queueKey(entry);
    if (!mergedByKey.has(key)) {
      orderedKeys.push(key);
      mergedByKey.set(key, { ...entry });
      continue;
    }
    mergedByKey.set(key, mergeQueueEntry(mergedByKey.get(key), entry));
  }

  return orderedKeys
    .map((key) => mergedByKey.get(key))
    .sort((left, right) => {
      const leftTs = left?.ts || left?.deliveredAt || "";
      const rightTs = right?.ts || right?.deliveredAt || "";
      if (leftTs !== rightTs) {
        return leftTs.localeCompare(rightTs);
      }
      return Number(left?.messageId || 0) - Number(right?.messageId || 0);
    });
}

function mergePendingReplyEntry(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }

  return {
    ...current,
    ...incoming,
    sentAt: pickIsoLater(current.sentAt, incoming.sentAt),
    status: incoming.status || current.status || "pending",
    responsePreview: incoming.responsePreview || current.responsePreview || "",
    responseMessageIds: Array.from(new Set([...(current.responseMessageIds || []), ...(incoming.responseMessageIds || [])]))
  };
}

function looksLikeBotSender(entry) {
  if (entry?.senderIsBot === true) {
    return true;
  }
  return /_bot$/i.test(String(entry?.user || "").trim());
}

function reconcilePendingRepliesInPlace(pendingReplies) {
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  const groups = new Map();

  for (const entry of replies) {
    const key = `${entry.chatId || ""}:${entry.conversationKey || ""}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }

  for (const entries of groups.values()) {
    entries.sort((left, right) => {
      const leftCreated = String(left?.createdAt || "");
      const rightCreated = String(right?.createdAt || "");
      if (leftCreated !== rightCreated) {
        return leftCreated.localeCompare(rightCreated);
      }
      return String(left?.messageId || "").localeCompare(String(right?.messageId || ""));
    });

    const latestSent = [...entries].reverse().find((entry) => entry.sentAt);
    if (!latestSent) {
      continue;
    }

    for (const entry of entries) {
      if (entry === latestSent || entry.sentAt) {
        continue;
      }
      if (String(entry.createdAt || "") > String(latestSent.createdAt || "")) {
        continue;
      }
      entry.status = entry.status === "error" ? entry.status : "superseded";
      entry.sentAt = latestSent.sentAt;
      if (!entry.responsePreview) {
        entry.responsePreview = latestSent.responsePreview || `Superseded by reply to message ${latestSent.messageId}`;
      }
      if ((!entry.responseMessageIds || entry.responseMessageIds.length === 0) && Array.isArray(latestSent.responseMessageIds)) {
        entry.responseMessageIds = [...latestSent.responseMessageIds];
      }
    }
  }

  return replies;
}

function mergePendingReplyLists(baseReplies, incomingReplies) {
  const merged = new Map();
  const order = [];

  for (const entry of baseReplies || []) {
    const key = pendingReplyKey(entry);
    if (!merged.has(key)) {
      order.push(key);
      merged.set(key, { ...entry });
      continue;
    }
    merged.set(key, mergePendingReplyEntry(merged.get(key), entry));
  }

  for (const entry of incomingReplies || []) {
    const key = pendingReplyKey(entry);
    if (!merged.has(key)) {
      order.push(key);
      merged.set(key, { ...entry });
      continue;
    }
    merged.set(key, mergePendingReplyEntry(merged.get(key), entry));
  }

  return order.map((key) => merged.get(key));
}

function syncRecordFromQueue(record, queue) {
  if (!record) {
    return null;
  }
  const match = (queue || []).find((entry) => queueKey(entry) === queueKey(record));
  return match ? mergeQueueEntry(record, match) : record;
}

function mergeStateSnapshots(currentState, incomingState) {
  const merged = {
    ...currentState,
    ...incomingState
  };

  merged.offset = Math.max(Number(currentState.offset || 0), Number(incomingState.offset || 0));
  merged.queue = mergeQueueLists(currentState.queue || [], incomingState.queue || []);
  merged.pendingReplies = mergePendingReplyLists(currentState.pendingReplies || [], incomingState.pendingReplies || []);
  merged.replyOffsets = {
    ...(currentState.replyOffsets || {}),
    ...(incomingState.replyOffsets || {})
  };
  merged.replyBuffers = {
    ...(currentState.replyBuffers || {}),
    ...(incomingState.replyBuffers || {})
  };
  merged.lastInbound = syncRecordFromQueue(
    pickLatestRecord(currentState.lastInbound || null, incomingState.lastInbound || null),
    merged.queue
  );
  merged.lastOutbound = pickLatestRecord(currentState.lastOutbound || null, incomingState.lastOutbound || null);
  merged.lastPollAt = pickIsoLater(currentState.lastPollAt, incomingState.lastPollAt);
  merged.lastInjectAt = pickIsoLater(currentState.lastInjectAt, incomingState.lastInjectAt);
  merged.currentThreadId = incomingState.currentThreadId || currentState.currentThreadId || "";
  return merged;
}

function normalizeInbound(message) {
  const text = message.text ?? message.caption ?? "";
  const chatType = String(message.chat?.type || "unknown");
  const telegramThreadId = message.message_thread_id ? String(message.message_thread_id) : "";
  const chatId = String(message.chat.id);
  return {
    chatId,
    messageId: String(message.message_id),
    replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : "",
    telegramThreadId,
    chatType,
    senderIsBot: Boolean(message.from?.is_bot),
    conversationKey: chatType === "private"
      ? `${chatId}:dm`
      : `${chatId}:${telegramThreadId || "root"}`,
    groupTitle: message.chat?.title || "",
    user: message.from?.username || message.from?.first_name || "unknown",
    userId: message.from?.id ? String(message.from.id) : "",
    text,
    ts: nowIso(),
    status: "queued",
    attempts: 0,
    lastAttemptAt: null
  };
}

function normalizeTelegramThreadId(value) {
  return String(value || "").trim();
}

function isAllowedChat(config, chatId) {
  const allowed = Array.isArray(config.allowedChatIds) ? config.allowedChatIds : [];
  if (allowed.length === 0) {
    return true;
  }
  return allowed.includes(String(chatId || "").trim());
}

function splitTelegramText(text, maxLength = 3500) {
  const value = String(text || "").trim();
  if (!value) {
    return [];
  }
  if (value.length <= maxLength) {
    return [value];
  }

  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < 0 || cut < maxLength * 0.5) {
      cut = remaining.lastIndexOf("\n", maxLength);
    }
    if (cut < 0 || cut < maxLength * 0.5) {
      cut = remaining.lastIndexOf(" ", maxLength);
    }
    if (cut < 0 || cut < maxLength * 0.5) {
      cut = maxLength;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
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
        // Keep moving; malformed partial lines are handled by carry.
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

async function resolveThreadSessionPath(config, threadId) {
  if (!threadId) {
    return "";
  }
  if (config.appServerWsUrl) {
    try {
      const readResult = await readThreadOverWs({
        wsUrl: config.appServerWsUrl,
        threadId,
        timeoutMs: 5000
      });
      return String(readResult.threadPath || "").trim();
    } catch {
      return "";
    }
  }
  return findRolloutFile(config.paths.sessionsDir, threadId) || "";
}

function buildPendingReplyEntry(message, threadId, turnId, sessionPath, sessionOffset) {
  return {
    turnId: String(turnId || "").trim(),
    threadId: String(threadId || "").trim(),
    sessionPath: String(sessionPath || "").trim(),
    sessionOffset: Number(sessionOffset || 0),
    chatId: String(message.chatId || "").trim(),
    messageId: String(message.messageId || "").trim(),
    replyToMessageId: String(message.messageId || "").trim(),
    telegramThreadId: normalizeTelegramThreadId(message.telegramThreadId),
    chatType: String(message.chatType || "").trim(),
    senderIsBot: Boolean(message.senderIsBot),
    conversationKey: String(message.conversationKey || "").trim(),
    groupTitle: String(message.groupTitle || "").trim(),
    user: String(message.user || "").trim(),
    sourceText: String(message.text || ""),
    createdAt: nowIso(),
    status: "pending",
    sentAt: null,
    responsePreview: "",
    responseMessageIds: []
  };
}

function parseUnixSeconds(isoString) {
  const millis = Date.parse(isoString || "");
  if (Number.isNaN(millis)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(millis / 1000);
}

function buildHistoryText(message) {
  const text = String(message.text || "").trim();
  const chatType = String(message.chatType || "");
  if (chatType === "private" || !chatType) {
    return text;
  }

  const title = String(message.groupTitle || message.chatId || "group").trim();
  const actor = String(message.user || "unknown").trim();
  const threadSuffix = message.telegramThreadId ? ` / thread ${message.telegramThreadId}` : "";
  return `[Telegram ${title}${threadSuffix} @${actor}] ${text}`;
}

function appendHistoryEntry(config, threadId, message) {
  if (!config.paths.historyFile || !threadId) {
    return null;
  }

  const text = buildHistoryText(message);
  if (!text) {
    return null;
  }

  const entry = {
    session_id: threadId,
    ts: parseUnixSeconds(message.ts),
    text
  };
  appendJsonl(config.paths.historyFile, entry);
  return entry;
}

function findRolloutFile(sessionsDir, threadId) {
  if (!sessionsDir || !threadId || !existsSync(sessionsDir)) {
    return null;
  }

  const stack = [sessionsDir];
  const matches = [];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) {
        continue;
      }
      matches.push({
        path: absolutePath,
        mtimeMs: statSync(absolutePath).mtimeMs
      });
    }
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.path || null;
}

function hasVisibleInboundSubmission(config, threadId, message) {
  const rolloutPath = findRolloutFile(config.paths.sessionsDir, threadId);
  if (!rolloutPath) {
    return false;
  }

  const rolloutText = readFileSync(rolloutPath, "utf8");
  return rolloutText.includes(`Chat ID: ${message.chatId}`)
    && rolloutText.includes(`Message ID: ${message.messageId}`)
    && rolloutText.includes(`Timestamp: ${message.ts}`);
}

function promoteVisibleQueuedEntry(config, state, threadId, message) {
  if (!message?.historyLoggedAt || message.status !== "queued") {
    return false;
  }
  if (!hasVisibleInboundSubmission(config, threadId, message)) {
    return false;
  }

  message.status = "submitted";
  message.submittedAt = message.submittedAt || nowIso();
  message.threadId = threadId;
  appendLog(config.paths.activityFile, `INJECT_SUBMITTED thread=${threadId} message=${message.messageId}`);
  state.lastInjectAt = nowIso();
  return true;
}

async function resolveActiveThreadId(config, state, preferredThreadId) {
  const fallbackThreadId = String(preferredThreadId || state.currentThreadId || config.currentThreadId || "").trim();
  if (!config.appServerWsUrl) {
    return fallbackThreadId;
  }

  try {
    const loaded = await listLoadedThreadsOverWs({
      wsUrl: config.appServerWsUrl,
      timeoutMs: 5000
    });
    const loadedIds = Array.isArray(loaded?.data) ? loaded.data.map((value) => String(value || "").trim()).filter(Boolean) : [];
    if (loadedIds.length === 0) {
      return fallbackThreadId;
    }

    let bestThreadId = loadedIds[loadedIds.length - 1];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidateThreadId of loadedIds) {
      let score = 0;
      try {
        const readResult = await readThreadOverWs({
          wsUrl: config.appServerWsUrl,
          threadId: candidateThreadId,
          timeoutMs: 5000
        });
        const sessionPath = String(readResult?.response?.result?.thread?.path || "").trim();
        if (sessionPath && existsSync(sessionPath)) {
          score = statSync(sessionPath).mtimeMs;
        }
      } catch {
        score = 0;
      }

      if (score >= bestScore) {
        bestScore = score;
        bestThreadId = candidateThreadId;
      }
    }

    if (state.currentThreadId !== bestThreadId) {
      state.currentThreadId = bestThreadId;
      saveStateForConfig(config, state);
      appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD thread=${bestThreadId}`);
    }
    return bestThreadId;
  } catch (error) {
    const message = String(error?.message || error).replace(/\s+/g, " ").slice(0, 180);
    appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD_ERROR ${message}`);
    return fallbackThreadId;
  }
}

export function bridgeStatus() {
  const config = loadConfig();
  const state = loadState(config);
  const queued = state.queue.filter((item) => item.status === "queued");
  const submitted = state.queue.filter((item) => item.status === "submitted");
  const pendingReplies = (state.pendingReplies || []).filter((item) => !item.sentAt && item.status !== "error");
  return {
    agent: config.agentName,
    allowedChatId: config.allowedChatId || null,
    boundThreadId: state.currentThreadId || config.currentThreadId || null,
    queueDepth: queued.length,
    submittedDepth: submitted.length,
    pendingReplyDepth: pendingReplies.length,
    lastInbound: state.lastInbound,
    lastOutbound: state.lastOutbound,
    lastPollAt: state.lastPollAt,
    lastInjectAt: state.lastInjectAt,
    stateDir: config.paths.root,
    note: "No autonomous shadow bot. Telegram is queued here and only injected into a real Codex thread on demand."
  };
}

async function sendOutboundChunks(config, state, options) {
  const chatId = String(options.chatId || "").trim();
  const text = String(options.text || "").trim();
  const replyToMessageId = String(options.replyToMessageId || "").trim();
  const telegramThreadId = normalizeTelegramThreadId(options.telegramThreadId);
  const source = String(options.source || "manual").trim();
  const sourceTurnId = String(options.sourceTurnId || "").trim();
  if (!chatId) {
    throw new Error("No chat id available for Telegram outbound.");
  }
  if (!text) {
    throw new Error("Outbound Telegram text is empty.");
  }

  const chunks = splitTelegramText(text);
  const messageIds = [];
  let lastOutbound = null;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = await sendMessage(config, {
      chatId,
      text: chunk,
      replyToMessageId: index === 0 ? replyToMessageId : "",
      telegramThreadId
    });
    const outbound = {
      chatId,
      messageId: String(result.message_id),
      replyToMessageId: index === 0 ? replyToMessageId : "",
      telegramThreadId: telegramThreadId || null,
      text: chunk,
      ts: nowIso(),
      source,
      sourceTurnId: sourceTurnId || null
    };
    state.lastOutbound = outbound;
    appendJsonl(config.paths.outboxFile, outbound);
    appendLog(config.paths.activityFile, `OUT_${source.toUpperCase()} chat=${chatId} reply_to=${outbound.replyToMessageId || "-"} thread=${telegramThreadId || "-"} message=${outbound.messageId}: ${chunk.replace(/\s+/g, " ").slice(0, 180)}`);
    messageIds.push(outbound.messageId);
    lastOutbound = outbound;
  }

  return {
    ok: true,
    outbound: lastOutbound,
    messageIds
  };
}

export function bindCurrentThread(threadId) {
  const config = loadConfig();
  const state = loadState(config);
  const resolved = (threadId || process.env.CODEX_THREAD_ID || config.currentThreadId || "").trim();
  if (!resolved) {
    throw new Error("No thread id provided and CODEX_THREAD_ID is not available.");
  }
  state.currentThreadId = resolved;
  saveStateForConfig(config, state);
  appendLog(config.paths.activityFile, `BOUND thread=${resolved}`);
  return {
    ok: true,
    threadId: resolved
  };
}

export async function pollOnce() {
  const config = loadConfig();
  const state = loadState(config);
  const startOffset = Number(state.offset || 0);
  const updates = await getUpdates(config, startOffset);
  let captured = 0;
  let ignored = 0;

  for (const update of updates) {
    state.offset = Math.max(Number(state.offset || 0), Number(update.update_id) + 1);
    if (!update.message) {
      ignored += 1;
      continue;
    }
    const inbound = normalizeInbound(update.message);
    if (!isAllowedChat(config, inbound.chatId)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    if (!inbound.text.trim()) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_EMPTY chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    state.queue.push(inbound);
    state.lastInbound = inbound;
    appendJsonl(config.paths.inboxFile, inbound);
    appendLog(config.paths.activityFile, `IN chat=${inbound.chatId} message=${inbound.messageId} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
    captured += 1;
  }

  state.lastPollAt = nowIso();
  const latestState = loadState(config);
  saveStateForConfig(config, mergeStateSnapshots(latestState, state));
  return {
    ok: true,
    startOffset,
    nextOffset: state.offset,
    captured,
    ignored
  };
}

export function listQueue(limit = 10) {
  const config = loadConfig();
  const state = loadState(config);
  return state.queue.slice(-Math.max(1, limit));
}

export async function injectNext(threadId) {
  const config = loadConfig();
  const state = loadState(config);
  const useAppServer = Boolean(config.appServerWsUrl);
  const preferredThreadId = (
    threadId
    || (useAppServer ? config.currentThreadId : state.currentThreadId)
    || (useAppServer ? state.currentThreadId : config.currentThreadId)
    || ""
  ).trim();
  const resolvedThreadId = await resolveActiveThreadId(config, state, preferredThreadId);
  if (!resolvedThreadId) {
    throw new Error("No bound thread id. Use bridge_bind_current_thread first.");
  }

  let promoted = 0;
  if (!useAppServer) {
    for (const entry of state.queue) {
      if (promoteVisibleQueuedEntry(config, state, resolvedThreadId, entry)) {
        promoted += 1;
      }
    }
  }
  if (promoted > 0) {
    saveStateForConfig(config, state);
  }

  const next = state.queue.find((item) => item.status === "queued");
  if (!next) {
    return {
      ok: true,
      status: promoted > 0 ? "submitted" : "empty"
    };
  }

  next.attempts = Number(next.attempts || 0) + 1;
  next.lastAttemptAt = nowIso();
  let sessionPath = "";
  let sessionOffset = 0;
  if (useAppServer) {
    sessionPath = await resolveThreadSessionPath(config, resolvedThreadId);
    if (sessionPath && existsSync(sessionPath)) {
      sessionOffset = statSync(sessionPath).size;
    }
  }
  if (!useAppServer && !next.historyLoggedAt) {
    const historyEntry = appendHistoryEntry(config, resolvedThreadId, next);
    if (historyEntry) {
      next.historyLoggedAt = nowIso();
      next.historyText = historyEntry.text;
      appendLog(config.paths.activityFile, `HISTORY_APPEND thread=${resolvedThreadId} message=${next.messageId}`);
    }
  }
  saveStateForConfig(config, state);
  appendLog(config.paths.activityFile, `INJECT_START thread=${resolvedThreadId} message=${next.messageId}`);
  const result = await injectIntoThread(config, next, resolvedThreadId);
  if (result.busy) {
    const promotedThisAttempt = useAppServer ? false : promoteVisibleQueuedEntry(config, state, resolvedThreadId, next);
    appendLog(config.paths.activityFile, `INJECT_BUSY thread=${resolvedThreadId} message=${next.messageId}`);
    const latestState = loadState(config);
    saveStateForConfig(config, mergeStateSnapshots(latestState, state));
    return {
      ok: false,
      status: promotedThisAttempt ? "submitted" : "busy",
      threadId: resolvedThreadId,
      message: next
    };
  }

  next.status = result.ok ? "delivered" : "error";
  next.deliveredAt = nowIso();
  next.threadId = resolvedThreadId;
  next.turnId = String(result.turnId || "").trim() || null;
  next.responsePreview = result.responseText.slice(0, 400);
  next.stderr = result.stderr.slice(0, 400);
  next.stdout = result.stdout.slice(0, 400);
  if (useAppServer && result.ok) {
    if (looksLikeBotSender(next)) {
      appendLog(config.paths.activityFile, `REPLY_SKIP_BOT thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}`);
    } else {
      const pendingReply = buildPendingReplyEntry(next, resolvedThreadId, next.turnId, sessionPath, sessionOffset);
      state.pendingReplies = mergePendingReplyLists(state.pendingReplies || [], [pendingReply]);
      appendLog(config.paths.activityFile, `REPLY_PENDING thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}`);
    }
  }
  state.lastInjectAt = nowIso();
  const latestState = loadState(config);
  saveStateForConfig(config, mergeStateSnapshots(latestState, state));
  appendLog(config.paths.activityFile, `INJECT_${result.ok ? "OK" : "ERROR"} thread=${resolvedThreadId} message=${next.messageId}`);
  return {
    ok: result.ok,
    status: result.ok ? "delivered" : "error",
    threadId: resolvedThreadId,
    message: next,
    responsePreview: result.responseText.slice(0, 400),
    stderr: result.stderr.slice(0, 400)
  };
}

export async function relayRepliesOnce() {
  const config = loadConfig();
  const state = loadState(config);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);

  for (const entry of state.pendingReplies || []) {
    if (entry.sentAt || entry.status === "error") {
      continue;
    }
    if (!looksLikeBotSender(entry)) {
      continue;
    }
    entry.status = "ignored_bot";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || "[ignored bot message]";
  }

  const pendingReplies = (state.pendingReplies || []).filter((entry) => !entry.sentAt && entry.status !== "error");
  if (pendingReplies.length === 0) {
    saveStateForConfig(config, state);
    return { ok: true, status: "empty", delivered: 0 };
  }

  let delivered = 0;
  const usedTurnIds = new Set();
  const sessionCompletions = new Map();

  for (const entry of pendingReplies) {
    if (!entry.sessionPath) {
      entry.sessionPath = await resolveThreadSessionPath(config, entry.threadId);
    }
    if (!entry.sessionPath || !existsSync(entry.sessionPath)) {
      continue;
    }

    if (!sessionCompletions.has(entry.sessionPath)) {
      const fallbackOffset = pendingReplies
        .filter((candidate) => candidate.sessionPath === entry.sessionPath)
        .reduce((lowest, candidate) => Math.min(lowest, Number(candidate.sessionOffset || 0)), Number(entry.sessionOffset || 0));
      const currentOffset = Number((state.replyOffsets || {})[entry.sessionPath] ?? fallbackOffset);
      const currentCarry = String((state.replyBuffers || {})[entry.sessionPath] || "");
      const delta = readJsonlDelta(entry.sessionPath, currentOffset, currentCarry);
      state.replyOffsets = {
        ...(state.replyOffsets || {}),
        [entry.sessionPath]: delta.nextOffset
      };
      state.replyBuffers = {
        ...(state.replyBuffers || {}),
        [entry.sessionPath]: delta.carry
      };
      const completions = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "task_complete")
        .map((item) => ({
          turnId: String(item?.payload?.turn_id || "").trim(),
          message: String(item?.payload?.last_agent_message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.message);
      sessionCompletions.set(entry.sessionPath, completions);
    }

    const completions = sessionCompletions.get(entry.sessionPath) || [];

    let match = null;
    if (entry.turnId) {
      match = completions.find((item) => item.turnId === entry.turnId);
    } else {
      match = completions.find((item) => item.timestamp >= entry.createdAt && !usedTurnIds.has(item.turnId));
    }
    if (!match) {
      continue;
    }

    const outboundResult = await sendOutboundChunks(config, state, {
      chatId: entry.chatId,
      text: match.message,
      replyToMessageId: entry.replyToMessageId,
      telegramThreadId: entry.telegramThreadId,
      source: "auto",
      sourceTurnId: match.turnId
    });
    entry.sentAt = nowIso();
    entry.status = "sent";
    entry.turnId = entry.turnId || match.turnId;
    entry.responsePreview = match.message.slice(0, 400);
    entry.responseMessageIds = outboundResult.messageIds;
    usedTurnIds.add(match.turnId);
    appendLog(config.paths.activityFile, `REPLY_SENT thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundResult.messageIds.join(",")}`);
    delivered += 1;
  }

  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  saveStateForConfig(config, state);
  return {
    ok: true,
    status: delivered > 0 ? "sent" : "pending",
    delivered,
    pending: (state.pendingReplies || []).filter((entry) => !entry.sentAt && entry.status !== "error").length
  };
}

export async function reply(text, options = {}) {
  const config = loadConfig();
  const state = loadState(config);
  const lastInbound = state.lastInbound;
  const chatId = String(options.chatId || lastInbound?.chatId || config.allowedChatId || "").trim();
  const replyToMessageId = String(options.replyToMessageId || lastInbound?.messageId || "").trim();
  const telegramThreadId = normalizeTelegramThreadId(options.telegramThreadId || lastInbound?.telegramThreadId || "");
  if (!chatId) {
    throw new Error("No chat id available for reply.");
  }
  const result = await sendOutboundChunks(config, state, {
    chatId,
    text,
    replyToMessageId,
    telegramThreadId,
    source: "manual"
  });
  saveStateForConfig(config, state);
  return result;
}

export function tailActivity(lines = 20) {
  const config = loadConfig();
  return readTail(config.paths.activityFile, lines);
}
