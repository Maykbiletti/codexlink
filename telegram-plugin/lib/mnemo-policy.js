import { existsSync, readFileSync, writeFileSync } from "node:fs";

function nowIso() {
  return new Date().toISOString();
}

function readJson(path, fallback) {
  try {
    if (!path || !existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  if (!path) return;
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function ageMinutes(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

function truncate(value, max = 1200) {
  const raw = typeof value === "string" ? value : JSON.stringify(value || {});
  return raw.length > max ? `${raw.slice(0, max)}...[truncated]` : raw;
}

function inferProject(config, message) {
  if (config.mnemoProject) return config.mnemoProject;
  const text = [message.text, message.groupTitle, message.conversationKey].filter(Boolean).join(" ").toLowerCase();
  if (/wizard\s*1|wizard1|\/dashboard\/wizard(?!2)/.test(text)) return "apps.blun.ai:wizard1";
  if (/wizard\s*2|wizard2|\/dashboard\/wizard2/.test(text)) return "apps.blun.ai:wizard2";
  if (/\bmnemo\b/.test(text)) return "mnemo";
  return "apps.blun.ai:wizard2";
}

function syncKey(config, message, threadId) {
  return [
    config.agentName || "agent",
    message.conversationKey || message.chatId || "chat",
    threadId || "thread"
  ].join("|");
}

async function callMnemoTool(config, name, args) {
  const base = String(config.mnemoHubUrl || "").replace(/\/+$/, "");
  if (!base) throw new Error("mnemo hub url missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.mnemoSyncTimeoutMs || 2500);
  try {
    const res = await fetch(`${base}/tool/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args || {}),
      signal: controller.signal
    });
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${truncate(body, 600)}`);
    return body && Object.prototype.hasOwnProperty.call(body, "result") ? body.result : body;
  } finally {
    clearTimeout(timer);
  }
}

function buildPolicyArgs(config, message, entry, project, extra = {}) {
  return {
    runtime_name: "codexlink",
    agent_name: config.agentName || "agent",
    channel: message.chatType === "private" ? "telegram-dm" : "telegram",
    project,
    board: entry.board || "",
    message_count_since_full_sync: entry.messageCountSinceFullSync || 0,
    has_brief_pull: Boolean(entry.lastBriefPullAt),
    has_recall: Boolean(entry.lastRecallAt),
    has_project_board: Boolean(entry.lastProjectBoardAt),
    has_chat_sync: Boolean(entry.lastChatSyncAt),
    has_memory_update: Boolean(entry.lastMemoryUpdateAt),
    has_message_capture: Boolean(entry.lastMessageCaptureAt),
    minutes_since_brief_pull: ageMinutes(entry.lastBriefPullAt),
    minutes_since_recall: ageMinutes(entry.lastRecallAt),
    minutes_since_project_board: ageMinutes(entry.lastProjectBoardAt),
    minutes_since_chat_sync: ageMinutes(entry.lastChatSyncAt),
    minutes_since_memory_update: ageMinutes(entry.lastMemoryUpdateAt),
    minutes_since_message_capture: ageMinutes(entry.lastMessageCaptureAt),
    message_ref: `${message.chatId || ""}:${message.messageId || ""}`,
    session_key: message.conversationKey || "",
    meta: {
      group_title: message.groupTitle || "",
      telegram_thread_id: message.telegramThreadId || "",
      user: message.user || "",
      source: "codexlink-user-prompt-submit"
    },
    ...extra
  };
}

async function captureMessage(config, message, entry, project) {
  const stamp = nowIso();
  const channel = message.chatType === "private" ? "telegram-dm" : "telegram";
  const result = await callMnemoTool(config, "mem_capture_ingest", {
    source: "codexlink",
    direction: "inbound",
    event_kind: "telegram_message",
    actor: message.user || "unknown",
    content: message.text || "",
    text: message.text || "",
    project,
    ref_kind: "telegram_message",
    ref_id: `${message.chatId || ""}:${message.messageId || ""}`,
    thread_id: message.conversationKey || "",
    channel,
    remember: true,
    promote_memory: true,
    meta: {
      agent_name: config.agentName || "agent",
      chat_id: message.chatId || "",
      message_id: message.messageId || "",
      group_title: message.groupTitle || "",
      sender_is_bot: Boolean(message.senderIsBot),
      forced_by_runtime_policy: true
    }
  });
  entry.lastMessageCaptureAt = stamp;
  entry.lastMemoryUpdateAt = stamp;
  entry.lastChatSyncAt = stamp;
  return result;
}

async function recallForMessage(config, message, entry) {
  const stamp = nowIso();
  const result = await callMnemoTool(config, "mem_recall", {
    agent_name: config.agentName || "agent",
    query: message.text || "",
    text: message.text || "",
    limit: 8
  });
  entry.lastRecallAt = stamp;
  return result;
}

async function runFullSync(config, message, entry, project) {
  const stamp = nowIso();
  const results = {};
  const channel = message.chatType === "private" ? "telegram-dm" : "telegram";

  try {
    results.brief_pull = await callMnemoTool(config, "mem_brief_pull", {
      agent_name: config.agentName || "agent",
      limit: 20,
      peek: true,
      auto_requeue: true
    });
    entry.lastBriefPullAt = stamp;
  } catch (error) {
    results.brief_pull = { error: String(error.message || error) };
  }

  try {
    results.recall = await callMnemoTool(config, "mem_recall", {
      agent_name: config.agentName || "agent",
      query: message.text || "",
      text: message.text || "",
      limit: 8
    });
    entry.lastRecallAt = stamp;
  } catch (error) {
    results.recall = { error: String(error.message || error) };
  }

  try {
    results.project_board = await callMnemoTool(config, "mem_project_board", {
      project,
      agent_name: config.agentName || "agent",
      limit: 12
    });
    entry.lastProjectBoardAt = stamp;
    entry.board = "wizard2-bridge";
  } catch (error) {
    results.project_board = { error: String(error.message || error) };
    entry.board = entry.board || "wizard2-bridge";
  }

  try {
    results.capture = await callMnemoTool(config, "mem_capture_ingest", {
      source: "codexlink",
      direction: "inbound",
      event_kind: "telegram_message",
      actor: message.user || "unknown",
      content: message.text || "",
      text: message.text || "",
      project,
      ref_kind: "telegram_message",
      ref_id: `${message.chatId || ""}:${message.messageId || ""}`,
      thread_id: message.conversationKey || "",
      channel,
      remember: true,
      promote_memory: true,
      meta: {
        agent_name: config.agentName || "agent",
        chat_id: message.chatId || "",
        message_id: message.messageId || "",
        group_title: message.groupTitle || "",
        sender_is_bot: Boolean(message.senderIsBot)
      }
    });
    entry.lastMemoryUpdateAt = stamp;
    entry.lastChatSyncAt = stamp;
  } catch (error) {
    results.capture = { error: String(error.message || error) };
  }

  try {
    results.event_log = await callMnemoTool(config, "mem_event_log", {
      agent_name: config.agentName || "agent",
      project,
      channel,
      source: "codexlink",
      direction: "internal",
      actor: config.agentName || "agent",
      event_kind: "runtime_context_sync",
      status: "done",
      content: `CodexLink full Mnemo sync for ${config.agentName || "agent"} after ${entry.messageCountSinceFullSync || 0} messages`,
      ref_kind: "telegram_message",
      ref_id: `${message.chatId || ""}:${message.messageId || ""}`,
      thread_id: message.conversationKey || "",
      payload: {
        brief_count: results.brief_pull && results.brief_pull.count,
        recall_count: Array.isArray(results.recall) ? results.recall.length : results.recall && results.recall.count,
        board_project: project
      },
      meta: { sync_key: entry.key || "", full_sync_every_messages: 10 }
    });
    entry.lastChatSyncAt = stamp;
  } catch (error) {
    results.event_log = { error: String(error.message || error) };
  }

  entry.lastFullSyncAt = stamp;
  entry.messageCountSinceFullSync = 0;
  return results;
}

function buildContextBlock(sync) {
  if (!sync || !sync.enabled) return "";
  const lines = [
    "",
    "[Mnemo Runtime Sync]",
    `Policy status: ${sync.finalCheck && sync.finalCheck.status || sync.status || "unknown"}`,
    ...(sync.auditId ? [`Audit ID: ${sync.auditId}`] : []),
    `Project: ${sync.project || "unknown"}`,
    `Message captured: ${sync.messageCaptured ? "yes" : "no"}`,
    `Memory checked: ${sync.memoryChecked ? "yes" : "no"}`,
    `Full sync this turn: ${sync.fullSyncRan ? "yes" : "no"}`,
  ];
  if (sync.warningToken) lines.push(`Warning token: ${sync.warningToken}`);
  if (sync.blocked) lines.push("Runtime policy blocked this response because required Mnemo context could not be loaded.");
  if (sync.briefCount != null) lines.push(`Pending briefs seen: ${sync.briefCount}`);
  if (sync.boardSummary) lines.push(`Project board: ${sync.boardSummary}`);
  if (sync.recallSummary) lines.push(`Recall: ${sync.recallSummary}`);
  if (sync.error) lines.push(`Sync error: ${truncate(sync.error, 500)}`);
  lines.push("[/Mnemo Runtime Sync]");
  return lines.join("\n");
}

export async function runMnemoRuntimeSync(config, message, threadId) {
  if (!config.mnemoSyncEnabled) return { enabled: false, promptBlock: "" };
  const state = readJson(config.paths.mnemoSyncStateFile, { conversations: {} });
  state.conversations = state.conversations || {};
  const key = syncKey(config, message, threadId);
  const entry = state.conversations[key] || {};
  entry.key = key;
  if (String(entry.lastMessageId || "") !== String(message.messageId || "")) {
    entry.messageCountSinceFullSync = Number(entry.messageCountSinceFullSync || 0) + 1;
    entry.lastMessageId = message.messageId || "";
  }
  const project = inferProject(config, message);
  let initialCheck = null;
  let finalCheck = null;
  let syncResults = null;
  const immediateResults = {};
  let error = "";
  try {
    try {
      immediateResults.capture = await captureMessage(config, message, entry, project);
    } catch (captureError) {
      immediateResults.capture = { error: String(captureError.message || captureError) };
    }
    try {
      immediateResults.recall = await recallForMessage(config, message, entry);
    } catch (recallError) {
      immediateResults.recall = { error: String(recallError.message || recallError) };
    }
    initialCheck = await callMnemoTool(config, "mem_runtime_policy_check", buildPolicyArgs(config, message, entry, project));
    const mustSync = !initialCheck || initialCheck.status !== "ok" || initialCheck.full_sync_due;
    if (mustSync) {
      syncResults = await runFullSync(config, message, entry, project);
    }
    finalCheck = await callMnemoTool(
      config,
      "mem_runtime_policy_check",
      buildPolicyArgs(config, message, entry, project, {
        has_full_sync: Boolean(syncResults),
        full_sync_completed: Boolean(syncResults)
      })
    );
  } catch (caught) {
    error = String(caught.message || caught);
  }
  state.conversations[key] = entry;
  writeJson(config.paths.mnemoSyncStateFile, state);

  const effectiveCheck = finalCheck || initialCheck || {};
  const blocked = effectiveCheck.status === "block" && effectiveCheck.allowed === false;
  const briefCount = syncResults && syncResults.brief_pull && Number.isFinite(Number(syncResults.brief_pull.count))
    ? Number(syncResults.brief_pull.count)
    : null;
  const boardSummary = syncResults && syncResults.project_board
    ? truncate({
      focus: syncResults.project_board.focus || null,
      open_tasks: syncResults.project_board.tasks && syncResults.project_board.tasks.length,
      next_actions: syncResults.project_board.next_actions && syncResults.project_board.next_actions.slice(0, 3)
    }, 700)
    : "";
  const recallSource = immediateResults.recall || syncResults && syncResults.recall;
  const recallSummary = recallSource ? truncate(recallSource, 700) : "";
  const sync = {
    enabled: true,
    project,
    initialCheck,
    finalCheck,
    auditId: effectiveCheck.audit_id || null,
    status: effectiveCheck.status || (error ? "error" : "ok"),
    warningToken: effectiveCheck.warning_token || null,
    blocked,
    fullSyncRan: Boolean(syncResults),
    briefCount,
    boardSummary,
    recallSummary,
    messageCaptured: Boolean(immediateResults.capture && !immediateResults.capture.error),
    memoryChecked: Boolean(immediateResults.recall && !immediateResults.recall.error),
    error,
  };
  sync.promptBlock = buildContextBlock(sync);
  return sync;
}
