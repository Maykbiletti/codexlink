import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { repairMojibake } from "./text-encoding.js";

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

function compactText(value, max = 120) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeMnemoMessage(message) {
  if (!message || typeof message !== "object") return message;
  return {
    ...message,
    text: repairMojibake(message.text),
    user: repairMojibake(message.user),
    actor: repairMojibake(message.actor),
    sourceAgent: repairMojibake(message.sourceAgent),
    groupTitle: repairMojibake(message.groupTitle)
  };
}

const DEFAULT_CONTEXT_RECALL_LIMIT = 30;
const DEFAULT_CONTEXT_RECALL_ROW_CHARS = 420;
const FAST_RECALL_STOPWORDS = new Set([
  "der", "die", "das", "den", "dem", "und", "oder", "aber", "mit", "fuer", "von", "vom", "zur", "zum", "ist", "sind", "war", "was", "wie", "ich", "du", "wir", "ihr", "sie", "ein", "eine", "einer", "einen", "nicht", "noch", "auch", "auf", "aus", "bei", "nach", "dass",
  "the", "and", "or", "for", "with", "from", "that", "this", "what", "when", "where", "why", "how"
]);
let fastRecallDbModule = null;

function contextRecallLimit(config) {
  const configured = Number(
    config?.mnemoRecallLimit ||
    process.env.BLUN_MNEMO_RECALL_LIMIT ||
    process.env.MNEMO_RUNTIME_TURN_RECALL_LIMIT ||
    0
  );
  return Math.min(50, Math.max(1, Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CONTEXT_RECALL_LIMIT));
}

function fastRecallEnabled(config) {
  const raw = process.env.BLUN_MNEMO_FAST_RECALL ?? process.env.MNEMO_FAST_RECALL ?? "";
  if (/^(0|false|no|off)$/i.test(String(raw).trim())) return false;
  return Boolean(config?.mnemoSyncEnabled !== false);
}

function mnemoCoreDir() {
  const explicit = process.env.BLUN_MNEMO_CORE_DIR || process.env.MNEMO_CORE_DIR || "";
  if (explicit && existsSync(explicit)) return explicit;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home ? join(home, "mnemo", "packages", "core") : "";
}

function fastRecallDbPath() {
  const explicit = process.env.BLUN_MNEMO_DB || process.env.MNEMO_DB || "";
  if (explicit) return explicit;
  const core = mnemoCoreDir();
  return core ? join(core, "mnemo.db") : "";
}

function loadFastRecallDbModule() {
  if (fastRecallDbModule) return fastRecallDbModule;
  const core = mnemoCoreDir();
  const requireFromCore = createRequire(core ? resolve(core, "daemon.js") : import.meta.url);
  fastRecallDbModule = requireFromCore("better-sqlite3");
  return fastRecallDbModule;
}

function fastRecallTokens(query) {
  const original = String(query || "");
  const raw = original.toLowerCase();
  const folded = raw.normalize ? raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "") : raw;
  const tokens = [];
  const seen = new Set();
  const priority = new Set(["fredrik", "moller", "moeller", "mokker", "marketing", "head", "investor", "pitch", "scania", "elevenlabs", "telegram", "userid", "user", "api", "blun"]);
  for (const text of [raw, folded]) {
    for (const match of text.match(/[\p{L}\p{N}_]{3,}/gu) || []) {
      const token = match.toLowerCase();
      if (FAST_RECALL_STOPWORDS.has(token) || seen.has(token)) continue;
      seen.add(token);
      let score = 0;
      if (priority.has(token)) score += 20;
      if (/\d/.test(token)) score += 8;
      if (token.length >= 8) score += 3;
      if (token.length >= 12) score += 2;
      tokens.push({ token: token.slice(0, 48), score, index: tokens.length });
    }
  }
  return tokens
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .slice(0, 12)
    .map((item) => item.token);
}

function fastRecallFtsQuery(query) {
  const tokens = fastRecallTokens(query);
  return tokens.length ? tokens.map((token) => `${token}*`).join(" OR ") : "";
}

function fastRecallNoise(row) {
  const actor = typeof row === "object" && row ? String(row.actor || "").toLowerCase() : "";
  const topic = typeof row === "object" && row ? String(row.topic || "").toLowerCase() : "";
  const kind = typeof row === "object" && row ? String(row.kind || row.surface || "").toLowerCase() : "";
  const preview = (typeof row === "string" ? row : String(row?.preview || row?.content || row?.text || JSON.stringify(row || ""))).toLowerCase();
  const transportSmoke = preview.includes("[botdoctor smoke]")
    || preview.includes("botdoctor smoke")
    || preview.includes("nur stiller transporttest")
    || preview.includes("transport-smoke: nur stiller inject-test")
    || (preview.includes("transport-smoke") && preview.includes("keine antwort"))
    || (preview.includes("keine antwort noetig") && preview.includes("transport"))
    || (preview.includes("keine antwort nötig") && preview.includes("transport"));
  if (transportSmoke) {
    return true;
  }
  if (actor === "mcp-tool" || actor === "http-tool") return true;
  if (topic === "tool_call" || topic === "tool_result" || topic.includes("tool_call") || topic.includes("tool_result")) return true;
  if (topic.includes("capture_validation_failed") || topic.includes("memory_insert") || topic.includes("transcript_insert") || topic.includes("runtime_message")) return true;
  if (kind === "tool_call" || kind === "tool_result") return true;
  if (preview.includes('"query"') && preview.includes("mem_recall")) return true;
  if (preview.includes('"runtime_turn_key"') || preview.includes('"validation_errors"')) return true;
  if (preview.includes('"source":"diagnostic:auto-recall"')) return true;
  if (preview.includes("finding291-smoke-debug")) return true;
  if (preview.includes("smoke-fast-")) return true;
  return false;
}

function dedupeRecallRows(rows, limit) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || fastRecallNoise(row)) continue;
    const key = `${row.surface || row.kind || "memory"}:${row.ref_id || row.id || row.preview}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function fastLocalRecall(config, message, limit = DEFAULT_CONTEXT_RECALL_LIMIT) {
  if (!fastRecallEnabled(config)) return null;
  const dbPath = fastRecallDbPath();
  const ftsQuery = fastRecallFtsQuery(message?.text || "");
  if (!dbPath || !existsSync(dbPath) || !ftsQuery) return null;
  const maxRows = Math.max(1, Math.min(Number(limit) || DEFAULT_CONTEXT_RECALL_LIMIT, 50));
  let db = null;
  try {
    const Database = loadFastRecallDbModule();
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 800 });
    db.pragma("query_only = ON");
    db.pragma("busy_timeout = 800");
    const memoryRows = db.prepare(`
      SELECT 'memory' AS surface, CAST(m.id AS TEXT) AS ref_id,
             m.kind, m.actor, m.occurred_at, m.topic, m.importance,
             substr(m.text, 1, 400) AS preview,
             bm25(memory_fts) AS bm25,
             'local_memory_fts' AS match_mode
      FROM memory_fts
      JOIN memory m ON m.id = memory_fts.rowid
      WHERE memory_fts MATCH ?
      ORDER BY bm25 ASC, m.occurred_at DESC
      LIMIT ?
    `).all(ftsQuery, maxRows * 2);
    const journalRows = db.prepare(`
      SELECT scope AS surface, scope AS kind, ref_id,
             agent_name AS actor, '' AS occurred_at,
             COALESCE(summary, '') AS topic,
             substr(COALESCE(content, summary, ''), 1, 400) AS preview,
             bm25(mnemo_search_fts) AS bm25,
             'local_journal_fts' AS match_mode
      FROM mnemo_search_fts
      WHERE mnemo_search_fts MATCH ?
      ORDER BY bm25 ASC
      LIMIT ?
    `).all(ftsQuery, maxRows * 2);
    const rows = dedupeRecallRows([...memoryRows, ...journalRows]
      .sort((a, b) => (Number(a.bm25 ?? 999) - Number(b.bm25 ?? 999))), maxRows);
    return { ok: true, local: true, query: ftsQuery, count: rows.length, rows };
  } catch (error) {
    return { ok: false, local: true, error: String(error.message || error), count: 0, rows: [] };
  } finally {
    try { if (db) db.close(); } catch {}
  }
}

function recallRowsFrom(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source;
  if (Array.isArray(source.rows)) return source.rows;
  if (Array.isArray(source.results)) return source.results;
  if (Array.isArray(source.memories)) return source.memories;
  if (Array.isArray(source.items)) return source.items;
  if (source.recall && Array.isArray(source.recall.rows)) return source.recall.rows;
  if (source.result) return recallRowsFrom(source.result);
  return [];
}

function recallRowText(row, index) {
  const ref = row?.ref_id || row?.id || row?.memory_id || row?.event_id || "";
  const head = [
    ref ? `#${ref}` : `#${index + 1}`,
    row?.surface || row?.kind || row?.topic || "",
    row?.actor || row?.speaker || "",
    row?.occurred_at || row?.created_at || row?.ts || "",
  ].filter(Boolean).join(" ");
  const body = row?.preview || row?.snippet || row?.text || row?.content || row?.summary || "";
  return `- ${head}: ${compactText(body, DEFAULT_CONTEXT_RECALL_ROW_CHARS)}`.trim();
}

function formatRecallSummary(source, limit = DEFAULT_CONTEXT_RECALL_LIMIT) {
  const rows = recallRowsFrom(source).filter((row) => row && !fastRecallNoise(row));
  if (!rows.length) return "";
  const capped = rows.slice(0, limit);
  return [
    `Recall hits injected: ${capped.length}${rows.length > capped.length ? `/${rows.length}` : ""}`,
    "Relevant memories:",
    ...capped.map((row, index) => recallRowText(row, index)),
  ].join("\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  const base = Math.min(5000, 350 * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(base + Math.random() * Math.min(250, base));
}

function retryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function retryableFetchError(error) {
  const name = String(error && error.name || "");
  const msg = String(error && error.message || "");
  return name === "AbortError"
    || /operation was aborted|timeout|timed out|fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|socket hang up/i.test(msg);
}

function mnemoToolTimeoutMs(config) {
  const configured = Number(config.mnemoSyncTimeoutMs || 0);
  return Number.isFinite(configured) && configured > 0 ? configured : 15000;
}

function mnemoToolRetryAttempts(config) {
  const configured = Number(config.mnemoSyncRetryAttempts || 0);
  return Math.max(1, Number.isFinite(configured) && configured > 0 ? configured : 3);
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
  let lastError = null;
  const attempts = mnemoToolRetryAttempts(config);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), mnemoToolTimeoutMs(config));
    try {
      const res = await fetch(`${base}/tool/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args || {}),
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = await res.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
      if (res.ok) {
        return body && Object.prototype.hasOwnProperty.call(body, "result") ? body.result : body;
      }
      const error = new Error(`${name} HTTP ${res.status}: ${truncate(body, 600)}`);
      if (!retryableStatus(res.status) || attempt >= attempts) throw error;
      lastError = error;
    } catch (error) {
      clearTimeout(timer);
      if (!retryableFetchError(error) || attempt >= attempts) throw error;
      lastError = error;
    }
    await sleep(retryDelayMs(attempt));
  }
  throw lastError || new Error(`${name} failed`);
}

export async function logMnemoOutboundReceipt(config, outbound, contextEntry = null) {
  if (!config?.mnemoSyncEnabled) {
    return { ok: true, enabled: false, reason: "disabled" };
  }

  const chatId = String(outbound?.chatId || "").trim();
  const messageId = String(outbound?.messageId || "").trim();
  const text = repairMojibake(outbound?.text).trim();
  if (!chatId || !messageId || !text) {
    return { ok: false, enabled: true, reason: "incomplete_outbound" };
  }

  const chatType = String(contextEntry?.chatType || "").trim().toLowerCase()
    || (chatId.startsWith("-") ? "supergroup" : "private");
  const channel = chatType === "private" ? "telegram-dm" : "telegram";
  const project = inferProject(config, {
    text,
    groupTitle: contextEntry?.groupTitle || "",
    conversationKey: contextEntry?.conversationKey || `${chatId}:${outbound.telegramThreadId || "root"}`
  });
  const refId = `${chatId}:${messageId}`;
  const actor = String(config.agentName || config.displayName || "agent").trim() || "agent";
  const threadId = String(contextEntry?.conversationKey || `${chatId}:${outbound.telegramThreadId || "root"}`).trim();
  const meta = {
    agent_name: config.agentName || "",
    display_name: config.displayName || "",
    chat_id: chatId,
    message_id: messageId,
    reply_to_message_id: outbound.replyToMessageId || "",
    telegram_thread_id: outbound.telegramThreadId || "",
    group_title: contextEntry?.groupTitle || "",
    source: outbound.source || "manual",
    source_turn_id: outbound.sourceTurnId || "",
    sender_is_bot: true
  };

  const results = {};
  try {
    results.turn_finish = await callMnemoTool(config, "mem_runtime_turn_finish", {
      runtime_name: "codexlink",
      agent_name: config.agentName || "agent",
      channel,
      project,
      board: project.includes("wizard2") ? "wizard2-bridge" : "",
      thread_id: threadId,
      session_key: threadId,
      chat_id: chatId,
      message_id: messageId,
      message_ref: refId,
      ref_kind: "telegram_message",
      ref_id: refId,
      source: "codexlink",
      actor,
      speaker: actor,
      recipient: contextEntry?.user || "",
      reply_to_message_id: outbound.replyToMessageId || "",
      response: text,
      content: text,
      text,
      promote_memory: true,
      promote_transcript: true,
      remember: true,
      telegram: true,
      meta
    });
    return {
      ok: Boolean(results.turn_finish && results.turn_finish.ok),
      enabled: true,
      project,
      ref_id: refId,
      results
    };
  } catch (turnFinishError) {
    const messageText = String(turnFinishError && turnFinishError.message || turnFinishError || "");
    if (!/mem_runtime_turn_finish|unknown tool|not[_ -]?found|404/i.test(messageText)) {
      throw turnFinishError;
    }
    results.turn_finish = { ok: false, fallback: true, error: messageText };
  }

  results.capture = await callMnemoTool(config, "mem_capture_ingest", {
    source: "codexlink",
    direction: "outbound",
    event_kind: "telegram_message",
    actor,
    content: text,
    text,
    project,
    ref_kind: "telegram_message",
    ref_id: refId,
    thread_id: threadId,
    channel,
    remember: true,
    promote_memory: true,
    meta
  });

  results.event_log = await callMnemoTool(config, "mem_event_log", {
    source: "codexlink",
    direction: "outbound",
    actor,
    channel,
    event_kind: "telegram_message",
    status: "sent",
    content: text,
    project,
    ref_kind: "telegram_message",
    ref_id: refId,
    thread_id: threadId,
    payload: {
      chat_id: chatId,
      message_id: messageId,
      reply_to_message_id: outbound.replyToMessageId || "",
      source: outbound.source || "manual"
    },
    meta
  });

  return { ok: true, enabled: true, project, ref_id: refId, results };
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

function buildTurnBeginArgs(config, message, entry, project, threadId) {
  const channel = message.chatType === "private" ? "telegram-dm" : "telegram";
  const ref = `${message.chatId || ""}:${message.messageId || ""}`;
  return {
    runtime_name: "codexlink",
    agent_name: config.agentName || "agent",
    channel,
    project,
    board: entry.board || "",
    thread_id: threadId || message.conversationKey || "default",
    session_id: message.conversationKey || threadId || "default",
    session_key: message.conversationKey || "",
    chat_id: String(message.chatId || ""),
    message_id: String(message.messageId || ""),
    message_ref: ref,
    ref_kind: "telegram_message",
    ref_id: ref,
    source_ref: `tg:${ref}`,
    dedupe_key: `telegram:${ref}`,
    source: "codexlink",
    direction: "inbound",
    actor: message.user || "unknown",
    user: message.user || "unknown",
    user_id: String(message.userId || ""),
    content: message.text || "",
    text: message.text || "",
    message: message.text || "",
    recall_query: message.text || "",
    recall_enabled: true,
    runtime_recall: true,
    light_mode: false,
    recall_limit: 8,
    brief_limit: 20,
    board_limit: 12,
    promote_memory: false,
    promote_transcript: true,
    remember: false,
    telegram: true,
    meta: {
      group_title: message.groupTitle || "",
      telegram_thread_id: message.telegramThreadId || "",
      sender_is_bot: Boolean(message.senderIsBot),
      relevance: message.relevance || "",
      conversation_key: message.conversationKey || "",
      source: "codexlink-user-prompt-submit"
    }
  };
}

function runtimeRecallCount(result) {
  const count = Number(result?.recall?.count);
  if (Number.isFinite(count)) return count;
  if (Array.isArray(result?.recall?.rows)) {
    return result.recall.rows.filter((row) => row && !fastRecallNoise(row)).length;
  }
  return 0;
}

async function ensureUserPromptHealthReceipt(config, message, project, threadId, turnResult) {
  if (!config?.mnemoSyncEnabled || !turnResult || typeof turnResult !== "object") return null;
  if (turnResult.hook_status || turnResult.user_prompt_hook || turnResult.userPromptHook) {
    return turnResult.hook_status || turnResult.user_prompt_hook || turnResult.userPromptHook;
  }

  const ref = `${message.chatId || ""}:${message.messageId || ""}`;
  const sessionId = message.conversationKey || threadId || "default";
  const priorRecallOk = turnResult.recall?.ok == null ? null : Boolean(turnResult.recall.ok);
  const promptCaptureOk = turnResult.capture?.ok == null ? null : Boolean(turnResult.capture.ok);
  const blockers = Array.isArray(turnResult.blockers) ? turnResult.blockers.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  const ok = priorRecallOk !== false && promptCaptureOk !== false && blockers.length === 0;
  try {
    const receipt = await callMnemoTool(config, "mem_action_log", {
      agent_name: config.agentName || "agent",
      action_kind: "mnemo_runtime_hook",
      target: "UserPromptSubmit",
      status: ok ? "ok" : "error",
      topic: "runtime_hook",
      session_id: sessionId,
      payload: {
        hook_event: "UserPromptSubmit",
        project,
        ok,
        runtime_turn_gate: true,
        runtime_name: "codexlink",
        audit_id: turnResult.audit_id || null,
        prior_recall_ok: priorRecallOk,
        prior_count: runtimeRecallCount(turnResult),
        prompt_capture_ok: promptCaptureOk,
        transcript_sync_ok: promptCaptureOk,
        transcript_count: promptCaptureOk ? 1 : 0,
        full_sync_ran: Boolean(turnResult.full_sync_ran),
        blockers
      },
      meta: {
        hook: "codexlink-runtime-fallback",
        runtime_name: "codexlink",
        runtime_turn_key: turnResult.turn_key || null,
        message_ref: ref || null,
        channel: message.chatType === "private" ? "telegram-dm" : "telegram",
        chat_id: String(message.chatId || "") || null,
        message_id: String(message.messageId || "") || null
      }
    });
    turnResult.hook_status = receipt;
    return receipt;
  } catch (error) {
    turnResult.hook_status_error = String(error && error.message || error);
    return null;
  }
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
    source_ref: `tg:${message.chatId || ""}:${message.messageId || ""}`,
    dedupe_key: `telegram:${message.chatId || ""}:${message.messageId || ""}`,
    thread_id: message.conversationKey || "",
    channel,
    remember: false,
    promote_memory: false,
    promote_transcript: true,
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

function telegramLiveCaptureEnabled(config) {
  if (!config || !config.mnemoSyncEnabled || !config.mnemoHubUrl) {
    return false;
  }
  return config.mnemoTelegramCaptureEnabled !== false;
}

function telegramThreadIdForCapture(message) {
  const chatId = String(message?.chatId || "").trim();
  const thread = String(message?.telegramThreadId || "").trim();
  const key = String(message?.conversationKey || "").trim();
  if (key) return key;
  if (!chatId) return "telegram:unknown";
  if (String(message?.chatType || "").toLowerCase() === "private") {
    return `${chatId}:dm`;
  }
  return `${chatId}:${thread || "root"}`;
}

function telegramChannelForCapture(message) {
  const chatId = String(message?.chatId || "").trim();
  if (String(message?.chatType || "").toLowerCase() === "private") {
    return `telegram-dm:${chatId || "unknown"}`;
  }
  return `telegram-chat:${chatId || "unknown"}`;
}

function telegramActorIdForCapture(message) {
  return String(
    message?.userId
      || message?.user_id
      || message?.fromUserId
      || message?.sourceAgent
      || message?.user
      || "unknown"
  ).trim();
}

function telegramContentForCapture(message) {
  const text = String(message?.text || "").trim();
  if (text) return text;
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length > 0) {
    const names = attachments
      .map((attachment) => attachment?.originalName || attachment?.safeName || attachment?.kind || "attachment")
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    return `Telegram attachment${names ? `: ${names}` : ""}`;
  }
  if (message?.attachment) {
    return `Telegram attachment: ${message.attachment.originalName || message.attachment.safeName || message.attachment.kind || "attachment"}`;
  }
  return "Telegram message";
}

function telegramImportanceForCapture(message) {
  const relevance = String(message?.relevance || "").toLowerCase();
  if (relevance === "escalation") return 7;
  if (relevance === "direct" || relevance === "lane") return 5;
  if (String(message?.chatType || "").toLowerCase() === "private") return 4;
  return 2;
}

export async function captureTelegramLive(config, message, options = {}) {
  if (!telegramLiveCaptureEnabled(config)) {
    return { ok: true, skipped: true, reason: "telegram_live_capture_disabled" };
  }
  if (!message) {
    return { ok: false, error: "message required" };
  }

  message = normalizeMnemoMessage(message);

  const stamp = String(message.ts || message.occurredAt || nowIso()).trim();
  const chatId = String(message.chatId || "").trim();
  const messageId = String(message.messageId || message.message_id || "").trim();
  const threadId = telegramThreadIdForCapture(message);
  const actor = String(message.user || message.actor || message.sourceAgent || "unknown").trim() || "unknown";
  const actorId = telegramActorIdForCapture(message);
  const project = options.project || inferProject(config, message);
  const refId = messageId ? `${chatId || "unknown"}:${messageId}` : `telegram:${threadId}:${stamp}`;
  const content = telegramContentForCapture(message);

  return await callMnemoTool(config, "mem_capture_ingest", {
    source: "telegram",
    channel: telegramChannelForCapture(message),
    direction: "inbound",
    event_kind: "telegram_message",
    actor,
    actor_id: actorId,
    speaker: actor,
    content,
    text: content,
    project,
    ref_kind: "telegram_message",
    ref_id: refId,
    source_ref: `tg:${refId}`,
    dedupe_key: `telegram:${refId}`,
    thread_id: threadId,
    session_id: threadId,
    occurred_at: stamp,
    promote_transcript: true,
    promote_memory: false,
    remember: false,
    importance: telegramImportanceForCapture(message),
    meta: {
      agent_name: config.agentName || "agent",
      capture_path: options.path || "codexlink-live",
      chat_id: chatId,
      chat_type: message.chatType || "",
      message_id: messageId,
      group_title: message.groupTitle || "",
      telegram_thread_id: message.telegramThreadId || "",
      conversation_key: message.conversationKey || threadId,
      user_id: actorId,
      sender_is_bot: Boolean(message.senderIsBot),
      relevance: message.relevance || "",
      intent: message.intent || "",
      update_type: message.updateType || "",
      attachment_count: Array.isArray(message.attachments) ? message.attachments.length : (message.attachment ? 1 : 0)
    }
  });
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
      source_ref: `tg:${message.chatId || ""}:${message.messageId || ""}`,
      dedupe_key: `telegram:${message.chatId || ""}:${message.messageId || ""}`,
      thread_id: message.conversationKey || "",
      channel,
      remember: false,
      promote_memory: false,
      promote_transcript: true,
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

function syncFromTurnBegin(result, project) {
  const policy = result && result.policy_check || {};
  const recallRows = result && result.recall && Array.isArray(result.recall.rows) ? result.recall.rows : [];
  const fullSync = result && result.full_sync || {};
  const blocked = result && (result.response_allowed === false || result.allowed === false || result.status === "block");
  return {
    enabled: true,
    project,
    turnResult: result,
    initialCheck: policy,
    finalCheck: policy,
    auditId: result && result.audit_id || policy.audit_id || null,
    status: result && result.status || policy.status || "ok",
    warningToken: result && result.warning_token || policy.warning_token || null,
    blocked,
    fullSyncRan: Boolean(result && result.full_sync_ran),
    briefCount: Number.isFinite(Number(fullSync.brief_pull_count)) ? Number(fullSync.brief_pull_count) : null,
    boardSummary: fullSync.project_board_loaded ? "loaded" : "",
    recallSummary: formatRecallSummary(recallRows),
    messageCaptured: Boolean(result && result.capture && result.capture.ok),
    memoryChecked: Boolean(result && result.recall && result.recall.ok),
    error: result && result.error || "",
    promptBlock: result && result.context_block || ""
  };
}

function syncFromFastRecallFallback(project, fastRecallResult, messageText) {
  const recallRows = fastRecallResult && Array.isArray(fastRecallResult.rows) ? fastRecallResult.rows : [];
  const sync = {
    enabled: true,
    project,
    initialCheck: { status: "degraded" },
    finalCheck: { status: "degraded" },
    auditId: null,
    status: "degraded",
    warningToken: "mnemo_turn_begin_timeout_fast_recall",
    blocked: false,
    fullSyncRan: false,
    briefCount: null,
    boardSummary: "",
    recallSummary: formatRecallSummary(fastRecallResult),
    messageCaptured: false,
    memoryChecked: recallRows.length > 0,
    error: "",
    timeoutReason: String(messageText || "").slice(0, 300)
  };
  sync.promptBlock = buildContextBlock(sync);
  return sync;
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
  if (sync.recallSummary) {
    lines.push("Recall:");
    lines.push(...String(sync.recallSummary).split(/\r?\n/));
  }
  if (sync.error) lines.push(`Sync error: ${truncate(sync.error, 500)}`);
  lines.push("[/Mnemo Runtime Sync]");
  return lines.join("\n");
}

export async function runMnemoRuntimeSync(config, message, threadId) {
  if (!config.mnemoSyncEnabled) return { enabled: false, promptBlock: "" };
  message = normalizeMnemoMessage(message);
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
  const fastRecallResult = fastLocalRecall(config, message, contextRecallLimit(config));
  try {
    const turnResult = await callMnemoTool(config, "mem_runtime_turn_begin", buildTurnBeginArgs(config, message, entry, project, threadId));
    if (fastRecallResult && fastRecallResult.ok && (fastRecallResult.rows || []).length) {
      turnResult.recall = fastRecallResult;
      turnResult.context_block = "";
    }
    await ensureUserPromptHealthReceipt(config, message, project, threadId, turnResult);
    const stamp = nowIso();
    if (turnResult && turnResult.capture && turnResult.capture.ok) {
      entry.lastMessageCaptureAt = stamp;
      entry.lastMemoryUpdateAt = stamp;
      entry.lastChatSyncAt = stamp;
    }
    if (turnResult && turnResult.recall && turnResult.recall.ok) {
      entry.lastRecallAt = stamp;
    }
    if (turnResult && turnResult.full_sync_ran) {
      entry.lastBriefPullAt = stamp;
      entry.lastProjectBoardAt = stamp;
      entry.lastFullSyncAt = stamp;
      entry.board = turnResult.board || entry.board || "wizard2-bridge";
    }
    if (Number.isFinite(Number(turnResult && turnResult.message_count_since_full_sync))) {
      entry.messageCountSinceFullSync = Number(turnResult.message_count_since_full_sync);
    }
    state.conversations[key] = entry;
    writeJson(config.paths.mnemoSyncStateFile, state);
    const sync = syncFromTurnBegin(turnResult, project);
    if (fastRecallResult && fastRecallResult.ok && (fastRecallResult.rows || []).length) {
      sync.recallSummary = formatRecallSummary(fastRecallResult);
      sync.memoryChecked = true;
      sync.promptBlock = buildContextBlock(sync);
    } else {
      sync.promptBlock = sync.promptBlock || buildContextBlock(sync);
    }
    return sync;
  } catch (turnBeginError) {
    const messageText = String(turnBeginError && turnBeginError.message || turnBeginError || "");
    const turnBeginTimedOut = /abort|timeout|timed out|operation was aborted|ETIMEDOUT/i.test(messageText);
    if (turnBeginTimedOut) {
      const stamp = nowIso();
      entry.lastTurnBeginErrorAt = stamp;
      entry.lastTurnBeginError = messageText.slice(0, 300);
      if (fastRecallResult && fastRecallResult.ok && (fastRecallResult.rows || []).length) {
        entry.lastRecallAt = stamp;
      }
      const timeoutTurnResult = {
        recall: fastRecallResult && fastRecallResult.ok ? fastRecallResult : null,
        full_sync_ran: false,
        blockers: ["mem_runtime_turn_begin_timeout"],
        turn_key: key,
        warning_token: "mnemo_turn_begin_timeout_fast_recall"
      };
      await ensureUserPromptHealthReceipt({
        ...config,
        mnemoSyncRetryAttempts: 1,
        mnemoSyncTimeoutMs: Math.min(mnemoToolTimeoutMs(config), 5000)
      }, message, project, threadId, timeoutTurnResult).catch(() => null);
      state.conversations[key] = entry;
      writeJson(config.paths.mnemoSyncStateFile, state);
      return syncFromFastRecallFallback(project, fastRecallResult, messageText);
    }
    if (!/mem_runtime_turn_begin|unknown tool|not[_ -]?found|404/i.test(messageText)) {
      throw turnBeginError;
    }
  }

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
      immediateResults.recall = fastRecallResult || await recallForMessage(config, message, entry);
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
  const recallSummary = recallSource ? formatRecallSummary(recallSource) : "";
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
