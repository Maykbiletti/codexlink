import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, extname, join } from "node:path";
import { getActiveTurnIdOverWs, listLoadedThreadsOverWs, readThreadOverWs } from "./app-server-client.js";
import { diagnosticSmokeKind, isDiagnosticSmokeEntry } from "./diagnostic-smoke.js";
import { loadConfig } from "./env.js";
import { injectIntoThread, isAddressOnlyPing } from "./codex.js";
import { downloadFileBuffer, getFileInfo, getUpdates, sendChatAction, sendMessage } from "./telegram.js";
import { appendJsonl, appendLog, defaultState, loadJson, loadJsonStrict, nowIso, readTail, saveJson, saveJsonWithBackup } from "./storage.js";
import { buildTeamRelayEventId, publishTeamRelayEvent, readTeamRelayDelta, rememberTeamRelayIds, saveTeamRelayCursor, teamRelayStatus } from "./team-relay.js";
import { captureTelegramLive, logMnemoOutboundReceipt } from "./mnemo-policy.js";

let lastStateRecoveryReportAt = 0;

function normalizeRuntimeState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime state must be a JSON object.");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "offset")) {
    throw new Error("Runtime state is missing its Telegram offset.");
  }
  const offset = Number(value.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Runtime state has an invalid Telegram offset: ${value.offset}`);
  }
  for (const key of ["queue", "pendingReplies"]) {
    if (value[key] !== undefined && !Array.isArray(value[key])) {
      throw new Error(`Runtime state field ${key} must be an array.`);
    }
  }
  for (const key of ["replyOffsets", "replyBuffers"]) {
    if (value[key] !== undefined && (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))) {
      throw new Error(`Runtime state field ${key} must be an object.`);
    }
  }
  const normalized = {
    ...defaultState(),
    ...value,
    schemaVersion: 3,
    offset,
    queue: Array.isArray(value.queue) ? value.queue : [],
    pendingReplies: Array.isArray(value.pendingReplies) ? value.pendingReplies : [],
    replyOffsets: value.replyOffsets || {},
    replyBuffers: value.replyBuffers || {},
    intakeCursorInitialized: typeof value.intakeCursorInitialized === "boolean"
      ? value.intakeCursorInitialized
      : true
  };
  return scrubIdleBriefArtifactsInPlace(normalized);
}

function stateRecoveryMarkerPath(config) {
  return config.paths.stateRecoveryFile || join(config.paths.root, "state-recovery-required.json");
}

function stateBackupPath(config) {
  return config.paths.stateBackupFile || `${config.paths.stateFile}.bak`;
}

function clearStateRecoveryMarker(config) {
  try { unlinkSync(stateRecoveryMarkerPath(config)); } catch {}
}

function reportStateRecoveryRequired(config, primaryError, backupError) {
  const error = new Error(
    `Runtime state recovery required; Telegram intake is stopped. Primary: ${compactError(primaryError)}. Backup: ${compactError(backupError)}`
  );
  error.code = "STATE_RECOVERY_REQUIRED";
  error.primaryError = primaryError;
  error.backupError = backupError;
  const markerPath = stateRecoveryMarkerPath(config);
  const existingMarker = existsSync(markerPath) ? loadJson(markerPath, null) : null;
  const marker = {
    version: 1,
    status: "recovery_required",
    intakeStopped: true,
    detectedAt: existingMarker?.detectedAt || nowIso(),
    lastDetectedAt: nowIso(),
    stateFile: config.paths.stateFile,
    backupFile: stateBackupPath(config),
    primaryError: compactError(primaryError),
    backupError: compactError(backupError)
  };
  if (!existingMarker || Date.now() - lastStateRecoveryReportAt >= 30000) {
    try { saveJson(markerPath, marker); } catch {}
    appendLog(config.paths.activityFile, `STATE_RECOVERY_REQUIRED intake=stopped primary=${marker.primaryError} backup=${marker.backupError}`);
    lastStateRecoveryReportAt = Date.now();
  }
  throw error;
}

function loadState(config) {
  const backupFile = stateBackupPath(config);
  if (!existsSync(config.paths.stateFile) && !existsSync(backupFile)) {
    const state = defaultState();
    saveJsonWithBackup(config.paths.stateFile, state, backupFile);
    clearStateRecoveryMarker(config);
    appendLog(config.paths.activityFile, "STATE_INITIALIZED intake_cursor=tail_pending");
    return state;
  }

  let primaryError = null;
  try {
    const state = normalizeRuntimeState(loadJsonStrict(config.paths.stateFile));
    clearStateRecoveryMarker(config);
    return state;
  } catch (error) {
    primaryError = error;
  }

  try {
    const recovered = normalizeRuntimeState(loadJsonStrict(backupFile));
    saveJsonWithBackup(config.paths.stateFile, recovered, backupFile);
    clearStateRecoveryMarker(config);
    appendLog(config.paths.activityFile, `STATE_RECOVERED source=backup offset=${recovered.offset} primary_error=${compactError(primaryError)}`);
    return recovered;
  } catch (backupError) {
    return reportStateRecoveryRequired(config, primaryError, backupError);
  }
}

let mnemoOutboundRetryDrainScheduled = false;

function mnemoOutboundRetryFile(config) {
  return join(config.paths.root, "mnemo-outbound-retry.jsonl");
}

function slimReceiptContextEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  return {
    chatId: entry.chatId || "",
    chatType: entry.chatType || "",
    conversationKey: entry.conversationKey || "",
    groupTitle: entry.groupTitle || "",
    messageId: entry.messageId || "",
    replyToMessageId: entry.replyToMessageId || "",
    telegramThreadId: entry.telegramThreadId || "",
    threadId: entry.threadId || "",
    turnId: entry.turnId || "",
    user: entry.user || ""
  };
}

function compactError(error) {
  return String(error?.message || error || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function retryDelayForAttempts(attempts) {
  const count = Math.max(1, Number(attempts || 1));
  return Math.min(10 * 60 * 1000, 30 * 1000 * Math.pow(2, Math.min(5, count - 1)));
}

function readMnemoOutboundRetries(config) {
  const path = mnemoOutboundRetryFile(config);
  if (!existsSync(path)) {
    return [];
  }
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry && entry.id && entry.outbound);
  } catch (error) {
    appendLog(config.paths.activityFile, `MNEMO_OUTBOUND_RETRY_READ_ERROR ${compactError(error)}`);
    return [];
  }
}

function writeMnemoOutboundRetries(config, retries) {
  const path = mnemoOutboundRetryFile(config);
  const rows = (retries || [])
    .filter((entry) => entry && entry.id && entry.outbound)
    .map((entry) => JSON.stringify(entry));
  writeFileSync(path, rows.length ? `${rows.join("\n")}\n` : "", "utf8");
}

function enqueueMnemoOutboundRetry(config, outbound, contextEntry, error, attempts = 0) {
  const id = `${outbound?.chatId || ""}:${outbound?.messageId || ""}`;
  if (!id || id === ":") {
    return;
  }
  const nextAttempts = Math.max(1, Number(attempts || 0) + 1);
  const record = {
    id,
    queuedAt: nowIso(),
    attempts: nextAttempts,
    nextAttemptAt: new Date(Date.now() + retryDelayForAttempts(nextAttempts)).toISOString(),
    outbound,
    contextEntry: slimReceiptContextEntry(contextEntry),
    error: compactError(error)
  };
  appendJsonl(mnemoOutboundRetryFile(config), record);
  appendLog(config.paths.activityFile, `MNEMO_OUTBOUND_RECEIPT_QUEUED chat=${outbound.chatId} message=${outbound.messageId} attempts=${nextAttempts} next=${record.nextAttemptAt}`);
}

async function deliverMnemoOutboundReceipt(config, outbound, contextEntry, origin = "async", timeoutMs = 5000) {
  const receiptConfig = {
    ...config,
    mnemoSyncRetryAttempts: 1,
    mnemoSyncTimeoutMs: Math.max(1000, timeoutMs)
  };
  const mnemoReceipt = await logMnemoOutboundReceipt(receiptConfig, outbound, contextEntry);
  if (mnemoReceipt?.enabled) {
    appendLog(
      config.paths.activityFile,
      `MNEMO_OUTBOUND_RECEIPT${origin === "retry" ? "_RETRY" : ""} chat=${outbound.chatId} message=${outbound.messageId} ok=${mnemoReceipt.ok ? 1 : 0} ref=${mnemoReceipt.ref_id || "-"}`
    );
  }
  return mnemoReceipt;
}

function scheduleMnemoOutboundReceipt(config, outbound, contextEntry) {
  const timer = setTimeout(async () => {
    try {
      await deliverMnemoOutboundReceipt(config, outbound, contextEntry, "async", 5000);
      scheduleMnemoOutboundRetryDrain(config);
    } catch (error) {
      appendLog(config.paths.activityFile, `MNEMO_OUTBOUND_RECEIPT_ERROR chat=${outbound.chatId} message=${outbound.messageId}: ${compactError(error)}`);
      enqueueMnemoOutboundRetry(config, outbound, contextEntry, error);
      scheduleMnemoOutboundRetryDrain(config);
    }
  }, 0);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

async function drainMnemoOutboundRetries(config, limit = 2) {
  const raw = readMnemoOutboundRetries(config);
  if (!raw.length) {
    return { ok: true, attempted: 0, remaining: 0 };
  }
  const latestById = new Map();
  for (const entry of raw) {
    latestById.set(entry.id, entry);
  }
  const now = Date.now();
  const retries = Array.from(latestById.values());
  const due = retries
    .filter((entry) => Date.parse(String(entry.nextAttemptAt || "")) <= now)
    .slice(0, limit);
  if (!due.length) {
    return { ok: true, attempted: 0, remaining: retries.length };
  }

  const delivered = new Set();
  for (const entry of due) {
    try {
      await deliverMnemoOutboundReceipt(config, entry.outbound, entry.contextEntry, "retry", 5000);
      delivered.add(entry.id);
    } catch (error) {
      entry.attempts = Math.max(1, Number(entry.attempts || 0) + 1);
      entry.nextAttemptAt = new Date(Date.now() + retryDelayForAttempts(entry.attempts)).toISOString();
      entry.error = compactError(error);
      appendLog(config.paths.activityFile, `MNEMO_OUTBOUND_RECEIPT_RETRY_ERROR chat=${entry.outbound.chatId} message=${entry.outbound.messageId} attempts=${entry.attempts}: ${entry.error}`);
    }
  }

  const remaining = retries.filter((entry) => !delivered.has(entry.id));
  try {
    writeMnemoOutboundRetries(config, remaining);
  } catch (error) {
    appendLog(config.paths.activityFile, `MNEMO_OUTBOUND_RETRY_WRITE_ERROR ${compactError(error)}`);
  }
  return { ok: true, attempted: due.length, delivered: delivered.size, remaining: remaining.length };
}

function scheduleMnemoOutboundRetryDrain(config) {
  if (mnemoOutboundRetryDrainScheduled) {
    return;
  }
  mnemoOutboundRetryDrainScheduled = true;
  const timer = setTimeout(async () => {
    mnemoOutboundRetryDrainScheduled = false;
    try {
      await drainMnemoOutboundRetries(config);
    } catch (error) {
      appendLog(config.paths.activityFile, `MNEMO_OUTBOUND_RETRY_DRAIN_ERROR ${compactError(error)}`);
    }
  }, 1000);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

function sleepStateLock(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function withStateLock(config, callback) {
  const lockPath = `${config.paths.stateFile}.lock`;
  const deadline = Date.now() + 15000;
  let descriptor = null;

  while (descriptor === null) {
    try {
      descriptor = openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 60000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Telegram state lock: ${lockPath}`);
      }
      sleepStateLock(25);
    }
  }

  try {
    return callback();
  } finally {
    try { closeSync(descriptor); } catch {}
    try { unlinkSync(lockPath); } catch {}
  }
}

function saveStateForConfig(config, state) {
  withStateLock(config, () => {
    const latestState = loadState(config);
    const mergedState = mergeStateSnapshots(latestState, state);
    saveJsonWithBackup(
      config.paths.stateFile,
      scrubIdleBriefArtifactsInPlace(mergedState),
      stateBackupPath(config)
    );
  });
}

function persistActiveThreadBinding(config, threadId) {
  const value = String(threadId || "").trim();
  if (!value) {
    return;
  }

  try {
    const envPath = config.paths.envFile;
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
    let wroteThread = false;
    const lines = existing
      .filter((line, index, all) => index < all.length - 1 || line.trim() !== "")
      .map((line) => {
        if (/^\s*BLUN_TELEGRAM_THREAD_ID\s*=/.test(line)) {
          wroteThread = true;
          return `BLUN_TELEGRAM_THREAD_ID=${value}`;
        }
        return line;
      });
    if (!wroteThread) {
      lines.push(`BLUN_TELEGRAM_THREAD_ID=${value}`);
    }
    writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Runtime binding is a self-heal path; dispatch can continue with state.
  }

  try {
    const runtimePath = config.paths.currentRuntimeFile;
    const runtime = loadJson(runtimePath, null);
    if (runtime && (!config.appServerWsUrl || !runtime.ws_url || String(runtime.ws_url).trim() === String(config.appServerWsUrl).trim())) {
      runtime.thread_id = value;
      saveJson(runtimePath, runtime);
    }
  } catch {
    // Best effort only.
  }
}

function queueKey(entry) {
  return `${entry.chatId}:${entry.messageId}`;
}

function hasKnownInboundMessage(state, inbound) {
  const key = queueKey(inbound);
  return [
    ...(state.queue || []),
    ...(state.pendingReplies || [])
  ].some((entry) => queueKey(entry) === key);
}

async function captureInboundForMnemo(config, inbound, path) {
  try {
    const result = await captureTelegramLive(config, inbound, { path });
    if (result && result.skipped) {
      appendLog(config.paths.activityFile, `MNEMO_TELEGRAM_CAPTURE_SKIPPED path=${path} reason=${result.reason || "unknown"}`);
    } else if (result && result.ok) {
      appendLog(
        config.paths.activityFile,
        `MNEMO_TELEGRAM_CAPTURE_OK path=${path} status=${result.status || "ok"} chat=${inbound.chatId} message=${inbound.messageId} thread=${inbound.conversationKey || "-"}`
      );
    } else {
      appendLog(config.paths.activityFile, `MNEMO_TELEGRAM_CAPTURE_FAIL path=${path} error=${String(result && result.error || "unknown").slice(0, 220)}`);
    }
    return result;
  } catch (error) {
    appendLog(config.paths.activityFile, `MNEMO_TELEGRAM_CAPTURE_ERROR path=${path} error=${String(error?.message || error).slice(0, 220)}`);
    return { ok: false, error: String(error?.message || error) };
  }
}

function pendingReplyKey(entry) {
  return entry.turnId || `${entry.threadId || ""}:${entry.chatId}:${entry.messageId}`;
}

function containsToken(text, token) {
  const value = String(token || "").trim();
  if (!value) {
    return false;
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(String(text || ""));
}

function shouldAckOnlyAddressPing() {
  return String(process.env.BLUN_TELEGRAM_PING_ACK_ONLY || "").trim() === "1";
}

function looksLikeEscalation(text) {
  const value = foldTriggerText(text);
  if (!value) {
    return false;
  }
  if ([
    "eskalation",
    "escalation",
    "urgent",
    "emergency",
    "prio 0",
    "p0",
    "blocker"
  ].some((token) => containsToken(value, token))) {
    return true;
  }
  return containsToken(value, "sofort") && !/\bab sofort\b/u.test(value);
}

const UNIVERSAL_AGENT_COMMANDS = new Set([
  "ai",
  "assistant",
  "bot",
  "agent",
  "helper",
  "copilot",
  "codex",
  "claude",
  "gpt",
  "llm",
  "ask",
  "chat",
  "prompt",
  "debug",
  "fix",
  "review",
  "explain",
  "summarize",
  "summarise",
  "translate",
  "analyze",
  "analyse",
  "optimize",
  "optimise",
  "refactor",
  "test",
  "hilfe",
  "hilf",
  "frage",
  "frag",
  "erklar",
  "erklaer",
  "erklare",
  "erklaere",
  "pruf",
  "pruef",
  "prufe",
  "pruefe",
  "reparier",
  "repariere",
  "behebe",
  "korrigiere",
  "ubersetz",
  "uebersetz",
  "zusammenfassen",
  "analysiere",
  "optimiere",
  "teste",
  "hjalp",
  "fraga",
  "forklar",
  "oversatt",
  "sammanfatta",
  "analysera",
  "granska",
  "fixa",
  "ayuda",
  "pregunta",
  "explica",
  "traducir",
  "traduce",
  "resumir",
  "resume",
  "analiza",
  "revisar",
  "arregla",
  "corrige",
  "aide",
  "explique",
  "traduire",
  "traduis",
  "resumer",
  "analyse",
  "corriger",
  "aiuto",
  "spiega",
  "traduci",
  "riassumi",
  "analizza",
  "correggi",
  "sistema",
  "ajuda",
  "explica",
  "traduz",
  "analisa",
  "corrigir",
  "uitleg",
  "vertaal",
  "samenvatten",
  "analyseer",
  "pomoc",
  "wyjasnij",
  "przetlumacz",
  "podsumuj",
  "analizuj",
  "napraw",
  "yardim",
  "acikla",
  "cevir",
  "ozetle",
  "analiz",
  "duzelt"
]);

const UNIVERSAL_AGENT_PATTERNS = [
  /\b(can someone|could someone|please|pls)\s+(explain|help|debug|review|fix|summari[sz]e|translate|analy[sz]e)\b/u,
  /\b(help me|help with this|what does this do|fix this error|review this code|write tests|create solution)\b/u,
  /\b(kann jemand|kannst du|bitte)\s+(helfen|erklaren|erklaeren|prufen|pruefen|fixen|reparieren|ubersetzen|uebersetzen|analysieren)\b/u,
  /\b(hilf mir|was bedeutet das|schau dir das an|pruf das|pruef das|fix das|debug das|fass das zusammen)\b/u,
  /\b(kan nagon|kan du)\s+(hjalpa|forklara|granska|fixa|oversatta|sammanfatta)\b/u,
  /\b(ayudame|puedes|puede alguien)\s+(explicar|revisar|arreglar|traducir|resumir|analizar)\b/u,
  /\b(aide moi|peux tu|quelqu un peut)\s+(expliquer|corriger|traduire|resumer|analyser)\b/u
];

function groupDeliveryMode(config) {
  return String(config.groupDeliveryMode || "observe").trim().toLowerCase();
}

function shouldDeliverAllGroupMessages(config) {
  return groupDeliveryMode(config) === "all";
}

function shouldObserveAllGroupMessages(config) {
  return groupDeliveryMode(config) === "observe";
}

function shouldSubmitEveryAllowedMessage(config) {
  return shouldDeliverAllGroupMessages(config);
}

function looksLikeUniversalAgentIntent(text) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const first = words[0] || "";
  if (UNIVERSAL_AGENT_COMMANDS.has(first)) {
    return true;
  }

  return UNIVERSAL_AGENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

const CONTINUE_NEGATIVE_ONLY = new Set([
  "ok",
  "okay",
  "ja",
  "yes",
  "si",
  "oui",
  "passt",
  "gut",
  "nice",
  "cool",
  "danke",
  "thanks",
  "merci",
  "gracias",
  "verstanden",
  "perfekt",
  "super",
  "top",
  "alles klar",
  "sieht gut aus",
  "hort sich gut an",
  "hoert sich gut an"
]);

const CONTINUE_BLOCK_PATTERNS = [
  /\bweiter so\b/u,
  /^status\b/u,
  /\bexplizites go\b/u,
  /\bohne\b[\s\S]{0,24}\bgo\b/u
];

const CONTINUE_PATTERN_GROUPS = [
  { weight: 4, patterns: [/\bmach weiter\b/u, /\bleg los\b/u, /\blos geht'?s\b/u, /\bfeuer frei\b/u, /\bsetz(?:e)? es um\b/u, /\bfu(?:eh|h)re es aus\b/u, /\bimplementiere es\b/u, /\bfix das\b/u, /\bfix den fehler\b/u, /\bbeheb(?:e)? das\b/u, /\breparier das\b/u, /\bteste es\b/u, /\bdebugge es\b/u] },
  { weight: 4, patterns: [/\bgo ahead\b/u, /\bcontinue\b/u, /\bkeep going\b/u, /\bexecute it\b/u, /\bimplement it\b/u, /\bfix it\b/u, /\bpatch it\b/u, /\bdebug it\b/u, /\btest it\b/u, /\brun it\b/u, /\bsend it\b/u, /\bship it\b/u, /\bkeep cooking\b/u, /\bfinish the implementation\b/u] },
  { weight: 4, patterns: [/\bdale\b/u, /\bvas y\b/u, /\bfais le\b/u, /\bcontinua\b/u, /\bvai avanti\b/u, /\bvamos\b/u, /\bga door\b/u, /\bkontynuuj\b/u, /\bdevam et\b/u] },
  { weight: 3, patterns: [/\bund weiter\b/u, /\barbeite weiter\b/u, /\bsetz(?:e)? fort\b/u, /\bn(?:ae|a)chster schritt\b/u, /\bmach den n(?:ae|a)chsten schritt\b/u, /\bweiter trotz fehler\b/u, /\bnicht abbrechen\b/u, /\bnochmal versuchen\b/u, /\bbrief f(?:ue|u)r dich\b/u, /\bbrief\b[\s\S]{0,30}\babruf(?:en)?\b/u, /\bbrief\b[\s\S]{0,30}\bpull\b/u] },
  { weight: 3, patterns: [/\bgib gas\b/u, /\bhau rein\b/u, /\bzieh durch\b/u, /\bzieh komplett durch\b/u, /\bnicht quatschen machen\b/u, /\bballer weiter\b/u, /\bmach den rest\b/u, /\bmach alleine weiter\b/u, /\bfull send\b/u, /\bfuck it we ball\b/u, /\byolo\b/u] }
];

const CONTINUE_ACTION_WORDS = [
  "mach",
  "start",
  "weiter",
  "los",
  "arbeite",
  "setz",
  "setze",
  "fuhre",
  "fuehre",
  "implementiere",
  "fix",
  "teste",
  "debugge",
  "patch",
  "bau",
  "ander",
  "aender",
  "schreib",
  "go",
  "continue",
  "deploy",
  "ship",
  "baller",
  "vollgas",
  "cook",
  "run"
];

const WORK_CONTEXT_HINTS = [
  "auth",
  "middleware",
  "datei",
  "file",
  "code",
  "anderung",
  "aenderung",
  "brief",
  "abruf",
  "pull",
  "commit",
  "test",
  "debug",
  "fehler",
  "bug",
  "fix",
  "patch",
  "implement",
  "umsetzen",
  "refactor",
  "deploy",
  "ui",
  "portal",
  "gruppe",
  "konsole",
  "plugin"
];

function normalizeTriggerText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[â€™']/g, "'")
    .replace(/[â€œâ€â€ž"]/g, "\"")
    .replace(/[â€“â€”]/g, "-")
    .replace(/[^\p{L}\p{N}@_"'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function foldTriggerText(text) {
  return normalizeTriggerText(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "");
}

function tokenCount(text) {
  if (!text) {
    return 0;
  }
  return text.split(/\s+/).filter(Boolean).length;
}

function looksLikeWorkContextText(text) {
  const normalized = foldTriggerText(text);
  if (!normalized || CONTINUE_NEGATIVE_ONLY.has(normalized)) {
    return false;
  }
  return WORK_CONTEXT_HINTS.some((token) => containsToken(normalized, token));
}

function hasRecentWorkContext(context = {}) {
  const currentConversationKey = String(context.conversationKey || "").trim();
  const recentEntries = Array.isArray(context.recentEntries) ? context.recentEntries : [];
  if (context.hasRecentWorkContext === true) {
    return true;
  }
  if (context.hasPendingReplies) {
    return true;
  }
  if (recentEntries.some((entry) => String(entry.intent || "").trim().toLowerCase() !== "continue_nudge")) {
    return true;
  }

  if (currentConversationKey) {
    const recentConversationEntries = recentEntries.filter((entry) => String(entry.conversationKey || "").trim() === currentConversationKey);
    if (recentConversationEntries.some((entry) => looksLikeWorkContextText(entry.text || entry.sourceText || ""))) {
      return true;
    }
  }

  if (looksLikeWorkContextText(context.lastUserWorkText || "")) {
    return true;
  }

  return false;
}

function getContinueTriggerScore(text, context = {}) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return 0;
  }
  if (CONTINUE_NEGATIVE_ONLY.has(normalized)) {
    return 0;
  }
  if (looksLikeStatusBroadcast(normalized)) {
    return 0;
  }

  const words = tokenCount(normalized);
  let score = 0;

  for (const pattern of CONTINUE_BLOCK_PATTERNS) {
    if (pattern.test(normalized)) {
      score -= 2;
    }
  }

  for (const group of CONTINUE_PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      if (pattern.test(normalized)) {
        score += group.weight;
      }
    }
  }

  for (const actionWord of CONTINUE_ACTION_WORDS) {
    if (containsToken(normalized, actionWord)) {
      score += 1;
    }
  }

  if (words > 0 && words <= 4 && score > 0) {
    score += 1;
  }

  if (hasRecentWorkContext(context) && score > 0) {
    score += 1;
  }

  if (/[!?]/.test(String(text || "")) && score < 3) {
    score -= 1;
  }

  if (words > 12 && score < 3) {
    score = Math.min(score, 1);
  }

  return Math.max(0, score);
}

function looksLikeContinueNudge(text, context = {}) {
  const score = getContinueTriggerScore(text, context);
  if (score >= 3) {
    return true;
  }
  return score >= 1 && hasRecentWorkContext(context);
}

function looksLikeAckOnly(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  if (value.length > 220) {
    return false;
  }
  return [
    "ok",
    "okay",
    "ja",
    "verstanden",
    "alles klar",
    "mache ich",
    "ich arbeite weiter",
    "ich mache weiter",
    "ich bin dran",
    "ich bin da",
    "weiter",
    "alles klar, ich mache weiter",
    "verstanden. ich arbeite weiter."
  ].includes(value);
}

function looksLikeContextRequestOnly(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value || value.length > 280) {
    return false;
  }
  return [
    "mir fehlt in diesem chat gerade der konkrete arbeitskontext. schick mir bitte den letzten stand oder die aufgabe kurz hier rein, dann setze ich direkt fort.",
    "schick mir kurz den letzten stand oder den punkt, ab dem ich anknÃ¼pfen soll.",
    "schick mir bitte den letzten stand.",
    "mir fehlt gerade der konkrete arbeitskontext.",
    "welcher punkt genau?",
    "womit genau soll ich weitermachen?"
  ].includes(value);
}

function uniqueAgentMentionNames(config) {
  const values = [
    ...(Array.isArray(config.mentionNames) ? config.mentionNames : []),
    config.agentName
  ];
  return Array.from(new Set(
    values
      .map((value) => foldTriggerText(value))
      .filter((value) => value && value !== "default")
  ));
}

function uniqueOtherAgentMentionNames(config) {
  const ownNames = new Set(uniqueAgentMentionNames(config));
  const values = Array.isArray(config.otherAgentNames) ? config.otherAgentNames : [];
  return Array.from(new Set(
    values
      .map((value) => foldTriggerText(value))
      .filter((value) => value && value !== "default" && !ownNames.has(value))
  ));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function startsWithAgentAddress(normalized, mention) {
  // normalizeTriggerText strips most punctuation, so this covers "Agent?",
  // "Agent:", "/agent", "!agent", "#agent" and "[agent]" as "agent".
  return new RegExp(`^@?${mention}\\b(?:\\s|$)`, "u").test(normalized);
}

function startsWithTeamAddressList(normalized, mention) {
  // Group chats often address multiple agents in one breath:
  // "designer, codex ...". Keep this conservative: only treat it as direct
  // if this agent is in the first small address block at the beginning.
  return new RegExp(`^(?:@?[a-z][a-z0-9_-]{1,24}\\b\\s+){1,3}@?${mention}\\b(?:\\s|$)`, "u").test(normalized);
}

function looksLikeStatusBroadcast(text) {
  const normalized = foldTriggerText(text);
  if (/^status(?:\s|$|[~:.-])/u.test(normalized)) {
    return true;
  }
  if (/^status\s+~?\s*\d{1,2}\s+\d{2}\b/u.test(normalized)) {
    return true;
  }
  return /^[a-z][a-z0-9_-]{1,24}\s+~?\s*\d{1,2}\s+\d{2}\b/u.test(normalized);
}

function looksLikeTransportQueueGateToken(text) {
  return /^tq(?:\d{1,3}|-[a-z])(?:\b|$|[\s:.-])/i.test(String(text || "").trim());
}

function looksLikeAgentCollectionRequest(config, inbound) {
  const text = String(inbound?.text || "");
  if (!text || String(inbound?.chatType || "") === "private") {
    return false;
  }
  if (!isAgentAddressed(config, text)) {
    return false;
  }
  const normalized = foldTriggerText(text);
  return /\b(?:alle|jeder|agent|agenten|otto|angel|dieter|fredrik|nachricht|nachrichten|schreibt|schreiben|feuert|test|serie|tq|wiederhole|wiederholen|pending|queue|turnqueue|turn\s*queue)\b/u.test(normalized);
}

function getAgentCollectionWindow(state) {
  const window = state?.agentCollectionWindow;
  if (!window || typeof window !== "object") {
    return null;
  }
  const expiresAt = Date.parse(String(window.expiresAt || ""));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }
  if (Number(window.remaining || 0) <= 0) {
    return null;
  }
  return window;
}

function armAgentCollectionWindow(config, state, inbound) {
  if (!looksLikeAgentCollectionRequest(config, inbound)) {
    return false;
  }
  const now = Date.now();
  state.agentCollectionWindow = {
    chatId: String(inbound.chatId || "").trim(),
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1000 * 120).toISOString(),
    sourceMessageId: String(inbound.messageId || "").trim(),
    remaining: 32
  };
  appendLog(config.paths.activityFile, `AGENT_COLLECTION_ARMED source=${inbound.messageId || "-"} chat=${inbound.chatId || "-"} remaining=32`);
  return true;
}

function promoteByAgentCollectionWindow(config, state, inbound) {
  const window = getAgentCollectionWindow(state);
  if (!window) {
    if (state?.agentCollectionWindow) {
      state.agentCollectionWindow = null;
    }
    return false;
  }
  if (String(inbound?.chatId || "").trim() !== String(window.chatId || "").trim()) {
    return false;
  }
  if (String(inbound?.messageId || "").trim() === String(window.sourceMessageId || "").trim()) {
    return false;
  }
  if (String(inbound?.chatType || "") === "private") {
    return false;
  }
  inbound.relevance = "direct";
  inbound.agentCollectionPromoted = true;
  inbound.agentCollectionSourceMessageId = String(window.sourceMessageId || "").trim();
  window.remaining = Math.max(0, Number(window.remaining || 0) - 1);
  appendLog(
    config.paths.activityFile,
    `AGENT_COLLECTION_PROMOTED source=${window.sourceMessageId || "-"} message=${inbound.messageId || "-"} user=${inbound.user || "-"} remaining=${window.remaining}`
  );
  if (window.remaining <= 0) {
    state.agentCollectionWindow = null;
  }
  return true;
}

function isAgentAddressed(config, text) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return false;
  }

  const mentionNames = uniqueAgentMentionNames(config);
  if (mentionNames.length === 0) {
    return false;
  }

  for (const name of mentionNames) {
    const mention = escapeRegExp(name);
    const startsAddressed = startsWithAgentAddress(normalized, mention) || startsWithTeamAddressList(normalized, mention);
    if (startsAddressed) {
      return true;
    }

    const routedToAgent = new RegExp(`\\b(?:fuer|fur|for|an|to)\\s+@?${mention}\\b`, "u").test(normalized);
    if (routedToAgent) {
      return true;
    }

    const briefDirective = new RegExp(`\\bbrief\\b(?:\\s+#?\\d+)?\\s+(?:fuer|fur|for|an|to)\\s+@?${mention}\\b|\\b@?${mention}\\b\\s*[-:,]?\\s*brief\\b`, "u").test(normalized);
    if (briefDirective) {
      return true;
    }

    const imperativeAfterMention = new RegExp(`\\b@?${mention}\\b\\s+(?:bitte|please|du|kannst|kann|sollst|soll|bekommst|bekommt|kriegst|erhaeltst|erhaltst|brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|mach|setz|starte|aktivier|antwort|melde|bescheid)\\b`, "u").test(normalized);
    if (imperativeAfterMention) {
      return true;
    }

    const workDirective = new RegExp(`\\b@?${mention}\\b[\\s\\S]{0,120}\\b(?:bitte|please|du|kannst|kann|sollst|soll|bekommst|bekommt|kriegst|erhaeltst|erhaltst|brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content)\\b|\\b(?:brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content)\\b[\\s\\S]{0,120}\\b@?${mention}\\b`, "u").test(normalized);
    if (workDirective) {
      return true;
    }

    if (containsToken(normalized, name)) {
      return true;
    }
  }

  return false;
}

function isOtherAgentAddressed(config, text) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return false;
  }

  const mentionNames = uniqueOtherAgentMentionNames(config);
  if (mentionNames.length === 0) {
    return false;
  }

  for (const name of mentionNames) {
    const mention = escapeRegExp(name);
    const startsAddressed = startsWithAgentAddress(normalized, mention) || startsWithTeamAddressList(normalized, mention);
    if (startsAddressed) {
      return true;
    }

    const routedToAgent = new RegExp(`\\b(?:fuer|fur|for|an|to)\\s+@?${mention}\\b`, "u").test(normalized);
    if (routedToAgent) {
      return true;
    }

    const briefDirective = new RegExp(`\\bbrief\\b(?:\\s+#?\\d+)?\\s+(?:fuer|fur|for|an|to)\\s+@?${mention}\\b|\\b@?${mention}\\b\\s*[-:,]?\\s*brief\\b`, "u").test(normalized);
    if (briefDirective) {
      return true;
    }

    const workDirective = new RegExp(`\\b@?${mention}\\b[\\s\\S]{0,120}\\b(?:bitte|please|du|kannst|kann|sollst|soll|bekommst|bekommt|kriegst|erhaeltst|erhaltst|brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content|uebersetz|ubersetz|translate)\\b|\\b(?:brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content|uebersetz|ubersetz|translate)\\b[\\s\\S]{0,120}\\b@?${mention}\\b`, "u").test(normalized);
    if (workDirective) {
      return true;
    }
  }

  return false;
}

function classifyInboundRelevance(config, inbound) {
  if (isCatchupQueueEntry(inbound)) {
    return "direct";
  }

  const text = String(inbound.text || "");
  const isStatusBroadcast = looksLikeStatusBroadcast(text);
  const isGroupChat = String(inbound.chatType || "") !== "private";

  if (isGroupChat && shouldDeliverAllGroupMessages(config)) {
    return "direct";
  }

  if (isGroupChat && looksLikeTransportQueueGateToken(text)) {
    return "direct";
  }

  if (!isStatusBroadcast && isAgentAddressed(config, text)) {
    return "direct";
  }

  if (!isStatusBroadcast && isOtherAgentAddressed(config, text)) {
    return isGroupChat && shouldObserveAllGroupMessages(config) ? "observe" : "ambient";
  }

  if (!isStatusBroadcast && looksLikeUniversalAgentIntent(text)) {
    return "direct";
  }

  if (String(inbound.chatType || "") === "private") {
    return "direct";
  }

  if (isStatusBroadcast) {
    return isGroupChat && shouldObserveAllGroupMessages(config) ? "observe" : "ambient";
  }

  if (looksLikeEscalation(text)) {
    return "escalation";
  }

  const lane = String(config.lane || "").trim();
  if (lane && lane.toLowerCase() !== "general" && containsToken(text, lane)) {
    return "lane";
  }

  if (isGroupChat && shouldDeliverAllGroupMessages(config)) {
    return "direct";
  }

  if (isGroupChat && shouldObserveAllGroupMessages(config)) {
    return "observe";
  }

  if (inbound.senderIsBot) {
    return isGroupChat && shouldObserveAllGroupMessages(config) ? "observe" : "ambient";
  }

  return "ambient";
}

function statusWeight(status) {
  switch (status) {
    case "delivered":
    case "replied":
    case "cancelled":
    case "error":
    case "failed":
      return 4;
    case "running":
    case "submitted":
    case "injecting":
      return 2;
    case "parked":
      return 3;
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

function hasRuntimeTurnQueueResult(entry) {
  return /^turn_queued\b/i.test(String(entry?.responsePreview || ""))
    || Boolean(entry?.turnId && (entry?.deliveredAt || entry?.injectFinishedAt));
}

function queueEvidenceTime(entry) {
  const candidates = [
    entry?.deliveredAt,
    entry?.injectFinishedAt,
    entry?.lastAttemptAt,
    entry?.submittedAt,
    entry?.requeuedAt,
    entry?.parkedAt,
    entry?.ts
  ];
  let latest = 0;
  for (const candidate of candidates) {
    const millis = Date.parse(candidate || "");
    if (!Number.isNaN(millis) && millis > latest) {
      latest = millis;
    }
  }
  return latest;
}

function isIntentionalQueueReentry(entry) {
  return String(entry?.status || "") === "queued" && Boolean(entry?.requeuedAt || entry?.requeueReason);
}

function isCatchupQueueEntry(entry) {
  return Boolean(entry) && (
    String(entry?.intent || "").trim().toLowerCase() === "catchup"
    || String(entry?.updateType || "").trim().toLowerCase() === "catchup"
    || String(entry?.messageId || "").startsWith("catchup-")
  );
}

function selectQueueMergeAnchor(current, incoming) {
  const currentCatchup = isCatchupQueueEntry(current);
  const incomingCatchup = isCatchupQueueEntry(incoming);
  if (currentCatchup !== incomingCatchup) {
    return incomingCatchup ? incoming : current;
  }

  const currentRuntimeQueue = hasRuntimeTurnQueueResult(current);
  const incomingRuntimeQueue = hasRuntimeTurnQueueResult(incoming);
  if (currentRuntimeQueue !== incomingRuntimeQueue) {
    return incomingRuntimeQueue ? incoming : current;
  }

  const currentReentry = isIntentionalQueueReentry(current);
  const incomingReentry = isIntentionalQueueReentry(incoming);
  if (currentReentry !== incomingReentry) {
    const currentEvidence = queueEvidenceTime(current);
    const incomingEvidence = queueEvidenceTime(incoming);
    if (currentReentry && currentEvidence >= incomingEvidence) {
      return current;
    }
    if (incomingReentry && incomingEvidence >= currentEvidence) {
      return incoming;
    }
  }

  const currentWeight = statusWeight(current?.status);
  const incomingWeight = statusWeight(incoming?.status);
  if (currentWeight !== incomingWeight) {
    return incomingWeight > currentWeight ? incoming : current;
  }

  return queueEvidenceTime(incoming) >= queueEvidenceTime(current) ? incoming : current;
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

function isoAgeMs(isoString) {
  const millis = Date.parse(isoString || "");
  if (Number.isNaN(millis)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Date.now() - millis);
}

function isNonTerminalPendingReply(entry) {
  return Boolean(entry)
    && !entry.sentAt
    && !["sent", "suppressed_ack", "error", "ignored_bot", "superseded", "expired", "stale_thread", "aborted", "no_reply_completed", "suppressed_private_reply"].includes(String(entry.status || ""));
}

function hasResponseMessageIds(entry) {
  return Array.isArray(entry?.responseMessageIds)
    && entry.responseMessageIds.filter(Boolean).length > 0;
}

function isReplyAwaitingOutcome(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const status = String(entry.status || "").trim().toLowerCase();
  if (["sent", "suppressed_ack", "suppressed_private_reply", "error", "ignored_bot", "superseded", "expired", "stale_thread", "aborted", "no_reply_completed"].includes(status)) {
    return false;
  }
  if (entry.sentAt && !hasResponseMessageIds(entry)) {
    return false;
  }
  return !hasResponseMessageIds(entry);
}

function closeStaleThreadPendingRepliesInPlace(pendingReplies, activeThreadId) {
  const threadId = String(activeThreadId || "").trim();
  if (!threadId) {
    return 0;
  }
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  let closed = 0;
  for (const entry of replies) {
    if (!isNonTerminalPendingReply(entry)) {
      continue;
    }
    const entryThreadId = String(entry.threadId || "").trim();
    if (!entryThreadId || entryThreadId === threadId) {
      continue;
    }
    entry.status = "stale_thread";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || `[stale pending reply from previous thread ${entryThreadId}]`;
    closed += 1;
  }
  return closed;
}

function supersedeOlderPendingRepliesInPlace(pendingReplies) {
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  const newestByConversation = new Map();

  for (const entry of replies) {
    if (!isReplyAwaitingOutcome(entry)) {
      continue;
    }
    const key = [
      String(entry.chatId || "").trim(),
      String(entry.conversationKey || "").trim(),
      String(entry.telegramThreadId || "").trim()
    ].join("|");
    const current = newestByConversation.get(key);
    const stamp = String(entry.createdAt || "");
    if (!current || stamp > current.stamp) {
      newestByConversation.set(key, { entry, stamp });
    }
  }

  let superseded = 0;
  for (const entry of replies) {
    if (!isReplyAwaitingOutcome(entry)) {
      continue;
    }
    const key = [
      String(entry.chatId || "").trim(),
      String(entry.conversationKey || "").trim(),
      String(entry.telegramThreadId || "").trim()
    ].join("|");
    const newest = newestByConversation.get(key)?.entry || null;
    if (!newest || newest === entry) {
      continue;
    }
    entry.status = "superseded";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || "[superseded by newer message]";
    superseded += 1;
  }

  return superseded;
}

function isPrivateIdleBriefArtifact(entry) {
  if (!entry) {
    return false;
  }
  if (String(entry.chatType || "").toLowerCase() !== "private") {
    return false;
  }
  return looksLikeMnemoIdleLoopBrief(entry.text || entry.sourceText || "");
}

function scrubIdleBriefArtifactsInPlace(state) {
  if (!state || typeof state !== "object") {
    return state;
  }

  const queue = Array.isArray(state.queue) ? state.queue : [];
  state.queue = mergeQueueLists([], queue.filter((entry) => !isPrivateIdleBriefArtifact(entry)));

  const pendingReplies = Array.isArray(state.pendingReplies) ? state.pendingReplies : [];
  state.pendingReplies = mergePendingReplyLists([], pendingReplies.filter((entry) => !isPrivateIdleBriefArtifact(entry)));

  if (isPrivateIdleBriefArtifact(state.lastInbound)) {
    state.lastInbound = [...state.queue]
      .filter((entry) => !isPrivateIdleBriefArtifact(entry))
      .sort((left, right) => {
        const leftStamp = String(left?.ts || left?.deliveredAt || left?.lastAttemptAt || "");
        const rightStamp = String(right?.ts || right?.deliveredAt || right?.lastAttemptAt || "");
        if (leftStamp !== rightStamp) {
          return rightStamp.localeCompare(leftStamp);
        }
        return Number(right?.messageId || 0) - Number(left?.messageId || 0);
      })[0] || null;
  }

  return state;
}

function closeExpiredPendingRepliesInPlace(config, pendingReplies) {
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  const timeoutMs = getEffectivePendingReplyTimeoutMs(config);
  if (timeoutMs <= 0) {
    return 0;
  }

  let expired = 0;
  for (const entry of replies) {
    if (hasResponseMessageIds(entry)) {
      entry.status = String(entry.status || "").trim().toLowerCase() === "suppressed_ack" ? "suppressed_ack" : "sent";
      entry.sentAt = entry.sentAt || getPendingReplyActivityAt(entry) || nowIso();
      continue;
    }
    if (!isNonTerminalPendingReply(entry)) {
      continue;
    }
    if (isoAgeMs(getPendingReplyActivityAt(entry)) < timeoutMs) {
      continue;
    }
    entry.status = "expired";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || `[pending reply expired after ${timeoutMs}ms]`;
    expired += 1;
  }
  return expired;
}

function getEffectivePendingReplyTimeoutMs(config) {
  const configuredMs = Math.max(Number(config.pendingReplyTimeoutMs || 0), 0);
  if (configuredMs <= 0) {
    return 0;
  }
  return configuredMs;
}

function getEffectiveIdleCooldownMs(config, entry = null) {
  const configuredMs = Math.max(Number(config.idleCooldownMs || 0), 0);
  if (configuredMs <= 0) {
    return 0;
  }
  const relevance = String(entry?.relevance || "").trim().toLowerCase();
  const chatType = String(entry?.chatType || "").trim().toLowerCase();
  const directLike = chatType === "private" || relevance === "direct" || relevance === "lane";
  const capMs = directLike ? 3000 : 5000;
  return Math.min(configuredMs, capMs);
}

function parkExpiredAmbientQueueEntriesInPlace(config, queue) {
  const entries = Array.isArray(queue) ? queue : [];
  const ttlMs = Math.max(Number(config.ambientQueueTtlMs || 0), 0);
  if (ttlMs <= 0) {
    return 0;
  }

  let parked = 0;
  for (const entry of entries) {
    if (!entry || entry.status !== "queued") {
      continue;
    }
    const relevance = String(entry.relevance || "").trim().toLowerCase();
    if (relevance !== "ambient" && relevance !== "observe") {
      continue;
    }
    if (isoAgeMs(entry.ts) < ttlMs) {
      continue;
    }
    entry.status = "parked";
    entry.parkedAt = nowIso();
    if (!entry.responsePreview) {
      entry.responsePreview = `[${relevance} parked after ${ttlMs}ms]`;
    }
    parked += 1;
  }
  return parked;
}

function reclassifyQueuedEntriesInPlace(config, queue) {
  const entries = Array.isArray(queue) ? queue : [];
  let changed = 0;
  let parked = 0;
  for (const entry of entries) {
    if (!entry || entry.status !== "queued") {
      continue;
    }
    if (isCatchupQueueEntry(entry)) {
      entry.relevance = "direct";
      continue;
    }
    const previous = String(entry.relevance || "").trim().toLowerCase();
    const chatType = String(entry.chatType || "").trim().toLowerCase();
    if (chatType === "private" || ["direct", "lane", "escalation"].includes(previous)) {
      continue;
    }
    const next = classifyInboundRelevance(config, entry);
    if (next === previous) {
      continue;
    }
    const reclassifiedAt = nowIso();
    entry.relevance = next;
    entry.reclassifiedAt = reclassifiedAt;
    if (next === "ambient" && String(entry.chatType || "").trim().toLowerCase() !== "private") {
      entry.status = "parked";
      entry.parkedAt = entry.parkedAt || reclassifiedAt;
      entry.responsePreview = entry.responsePreview || "[reclassified ambient]";
      parked += 1;
    }
    changed += 1;
  }
  return { changed, parked };
}

function recoverStaleInjectingEntriesInPlace(entries, staleMs = 1000 * 60 * 5) {
  let recovered = 0;
  const now = Date.now();
  for (const entry of entries || []) {
    if (!entry || String(entry.status || "").trim().toLowerCase() !== "injecting") {
      continue;
    }
    const startedAt = Date.parse(entry.injectStartedAt || entry.lastAttemptAt || "");
    if (Number.isFinite(startedAt) && now - startedAt < staleMs) {
      continue;
    }
    entry.status = "queued";
    entry.injectRecoveredAt = nowIso();
    entry.requeuedAt = entry.injectRecoveredAt;
    entry.requeueReason = "stale_injecting_lease";
    entry.leaseUntil = null;
    recovered += 1;
  }
  return recovered;
}

export function mergeQueueEntry(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }

  const anchor = selectQueueMergeAnchor(current, incoming);
  const other = anchor === incoming ? current : incoming;
  const merged = {
    ...other,
    ...anchor
  };

  const completedBusyRetry = current.status === "injecting"
    && incoming.status === "queued"
    && Boolean(incoming.retryAfterAt);
  if (completedBusyRetry) {
    merged.status = "queued";
  } else {
    merged.status = anchor.status || incoming.status || current.status;
  }

  merged.attempts = Math.max(Number(current.attempts || 0), Number(incoming.attempts || 0));
  merged.lastAttemptAt = pickIsoLater(current.lastAttemptAt, incoming.lastAttemptAt);
  merged.submittedAt = pickIsoLater(current.submittedAt, incoming.submittedAt);
  merged.deliveredAt = pickIsoLater(current.deliveredAt, incoming.deliveredAt);
  merged.requeuedAt = pickIsoLater(current.requeuedAt, incoming.requeuedAt);
  merged.parkedAt = pickIsoLater(current.parkedAt, incoming.parkedAt);
  merged.injectStartedAt = pickIsoLater(current.injectStartedAt, incoming.injectStartedAt);
  merged.injectFinishedAt = pickIsoLater(current.injectFinishedAt, incoming.injectFinishedAt);
  merged.retryAfterAt = pickIsoLater(current.retryAfterAt, incoming.retryAfterAt);
  merged.ts = pickIsoLater(current.ts, incoming.ts);

  for (const field of ["threadId", "turnId", "activeTurnId", "responsePreview", "stderr", "stdout", "chatType", "conversationKey", "groupTitle", "telegramThreadId", "senderIsBot", "relevance", "intent", "updateType"]) {
    merged[field] = anchor[field] ?? other[field] ?? null;
  }

  const currentHasRuntimeResult = hasRuntimeTurnQueueResult(current);
  const incomingHasRuntimeResult = hasRuntimeTurnQueueResult(incoming);
  const runtimeQueueSource = currentHasRuntimeResult && incomingHasRuntimeResult
    ? selectQueueMergeAnchor(current, incoming)
    : (incomingHasRuntimeResult ? incoming : (currentHasRuntimeResult ? current : null));
  if (runtimeQueueSource) {
    const terminal = ["delivered", "replied", "cancelled", "error", "failed"].includes(String(runtimeQueueSource.status || "").toLowerCase());
    merged.status = terminal ? runtimeQueueSource.status : "submitted";
    merged.relevance = "direct";
    merged.threadId = runtimeQueueSource.threadId || merged.threadId || null;
    merged.turnId = runtimeQueueSource.turnId || merged.turnId || null;
    merged.responsePreview = runtimeQueueSource.responsePreview ?? merged.responsePreview;
    merged.retryAfterAt = null;
  }

  if (isCatchupQueueEntry(current) || isCatchupQueueEntry(incoming) || isCatchupQueueEntry(merged)) {
    const mergedStatus = String(merged.status || "").trim().toLowerCase();
    const deliveredCatchup = Boolean(merged.turnId || merged.deliveredAt || merged.injectFinishedAt);
    if (deliveredCatchup) {
      merged.status = "delivered";
    } else if (!["injecting", "submitted", "delivered", "error", "expired", "suppressed_ack", "suppressed_private_reply"].includes(mergedStatus)) {
      merged.status = "queued";
    }
    merged.relevance = "direct";
    merged.intent = "catchup";
    merged.updateType = "catchup";
    merged.parkedAt = null;
    merged.catchupForMessageId = incoming.catchupForMessageId || current.catchupForMessageId || merged.catchupForMessageId || null;
    merged.catchupObserveRefs = Array.from(new Set([
      ...(Array.isArray(current.catchupObserveRefs) ? current.catchupObserveRefs : []),
      ...(Array.isArray(incoming.catchupObserveRefs) ? incoming.catchupObserveRefs : []),
      ...(Array.isArray(merged.catchupObserveRefs) ? merged.catchupObserveRefs : [])
    ]));
  }

  if (["delivered", "error", "parked", "submitted"].includes(String(merged.status || "").toLowerCase())) {
    merged.retryAfterAt = null;
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

function isTransportSmokeEntry(entry) {
  return isDiagnosticSmokeEntry(entry);
}

function isTrustedBotSender(config, entry) {
  if (!looksLikeBotSender(entry)) {
    return false;
  }
  const sender = foldTriggerText(entry?.user || "");
  const trustedBots = Array.isArray(config?.trustedBotSenders) ? config.trustedBotSenders : [];
  return trustedBots.map((value) => foldTriggerText(value)).includes(sender);
}

function shouldReplyToTeamBotSender(config, entry) {
  if (!looksLikeBotSender(entry)) {
    return true;
  }
  if (!isGroupChatEntry(entry)) {
    return false;
  }
  if (isTrustedBotSender(config, entry)) {
    return true;
  }
  const text = String(entry?.sourceText || entry?.text || "");
  if (looksLikeTransportQueueGateToken(text)) {
    return true;
  }
  const relevance = String(entry?.relevance || "").trim().toLowerCase();
  if (relevance === "escalation") {
    return true;
  }
  if (["direct", "lane"].includes(relevance) && isAgentAddressed(config, text)) {
    return true;
  }
  return looksLikeContinueNudge(text, {});
}

function shouldAcceptBotRelayEntry(config, entry) {
  if (!looksLikeBotSender(entry)) {
    return true;
  }
  if (isTrustedBotSender(config, entry)) {
    return true;
  }
  const text = String(entry?.sourceText || entry?.text || "");
  const relevance = String(entry?.relevance || "").trim().toLowerCase();
  if (relevance === "escalation") {
    return true;
  }
  if (isAgentAddressed(config, text)) {
    return true;
  }
  return looksLikeContinueNudge(text, {});
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

function markMatchingQueueEntriesInPlace(state, source, updates) {
  const key = queueKey(source || {});
  if (!key || key === ":") {
    return 0;
  }
  let changed = 0;
  for (const entry of state.queue || []) {
    if (queueKey(entry) !== key) {
      continue;
    }
    Object.assign(entry, updates);
    changed += 1;
  }
  return changed;
}

function markMatchingDeliveryStateInPlace(state, source, updates) {
  let changed = markMatchingQueueEntriesInPlace(state, source, updates);
  const key = queueKey(source || {});
  if (!key || key === ":") {
    return changed;
  }
  for (const entry of state.pendingReplies || []) {
    if (queueKey(entry) !== key) {
      continue;
    }
    Object.assign(entry, updates);
    changed += 1;
  }
  return changed;
}

function mergeStateSnapshots(currentState, incomingState) {
  const merged = {
    ...currentState,
    ...incomingState
  };

  merged.offset = Math.max(Number(currentState.offset || 0), Number(incomingState.offset || 0));
  merged.queue = compactQueueHistory(mergeQueueLists(currentState.queue || [], incomingState.queue || []));
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
  merged.lastUiNotice = null;
  merged.lastPollAt = pickIsoLater(currentState.lastPollAt, incomingState.lastPollAt);
  merged.lastInjectAt = pickIsoLater(currentState.lastInjectAt, incomingState.lastInjectAt);
  merged.currentThreadId = incomingState.currentThreadId || currentState.currentThreadId || "";
  return merged;
}

function compactQueueHistory(queue) {
  const configured = Number.parseInt(process.env.BLUN_TELEGRAM_QUEUE_HISTORY_LIMIT || "500", 10);
  const historyLimit = Number.isFinite(configured) && configured >= 50 ? configured : 500;
  const terminalStatuses = new Set(["delivered", "replied", "cancelled", "failed", "expired", "ignored_bot", "suppressed_ack", "stale_thread"]);
  const active = [];
  const terminal = [];
  for (const entry of queue || []) {
    if (terminalStatuses.has(String(entry?.status || "").toLowerCase())) {
      terminal.push(entry);
    } else {
      active.push(entry);
    }
  }
  return [...active, ...terminal.slice(-historyLimit)];
}

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function sanitizeAttachmentName(name) {
  const raw = basename(String(name || "").replace(/\0/g, "")).replace(/\.\./g, "");
  const cleaned = raw.replace(/[^0-9A-Za-z._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "telegram-file.bin";
}

function safePathPart(value) {
  return String(value || "")
    .replace(/[^0-9A-Za-z_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "telegram";
}

function isImageMimeOrName(mimeType, name) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTENSIONS.has(extname(String(name || "")).toLowerCase());
}

function pickTelegramAttachment(message) {
  const messageId = String(message?.message_id || Date.now());
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length > 0) {
    const photo = [...photos].sort((left, right) => Number(left?.file_size || 0) - Number(right?.file_size || 0)).pop();
    if (photo?.file_id) {
      return {
        kind: "photo",
        fileId: String(photo.file_id),
        fileUniqueId: String(photo.file_unique_id || ""),
        originalName: `telegram-photo-${messageId}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: Number(photo.file_size || 0),
        isImage: true
      };
    }
  }

  const document = message?.document;
  if (document?.file_id) {
    const originalName = String(document.file_name || `telegram-document-${messageId}`);
    const mimeType = String(document.mime_type || "application/octet-stream");
    return {
      kind: "document",
      fileId: String(document.file_id),
      fileUniqueId: String(document.file_unique_id || ""),
      originalName,
      mimeType,
      sizeBytes: Number(document.file_size || 0),
      isImage: isImageMimeOrName(mimeType, originalName)
    };
  }

  const video = message?.video || message?.animation;
  if (video?.file_id) {
    const mimeType = String(video.mime_type || "video/mp4");
    return {
      kind: message?.animation ? "animation" : "video",
      fileId: String(video.file_id),
      fileUniqueId: String(video.file_unique_id || ""),
      originalName: String(video.file_name || `telegram-video-${messageId}.mp4`),
      mimeType,
      sizeBytes: Number(video.file_size || 0),
      isImage: false
    };
  }

  return null;
}

async function stageTelegramAttachment(config, inbound) {
  if (!inbound?.attachment?.fileId) {
    delete inbound.attachment;
    return;
  }

  const attachment = inbound.attachment;
  const maxBytes = Math.max(Number(config.attachmentMaxBytes || 0), 1);
  try {
    const file = await getFileInfo(config, attachment.fileId);
    if (!file?.file_path) {
      throw new Error("Telegram returned no file path");
    }

    const fileSize = Number(file.file_size || attachment.sizeBytes || 0);
    if (fileSize > maxBytes) {
      throw new Error(`file too large (${Math.round(fileSize / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }

    const buffer = await downloadFileBuffer(config, file.file_path);
    if (buffer.byteLength > maxBytes) {
      throw new Error(`file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }

    const fallbackName = basename(file.file_path) || attachment.originalName || "telegram-file.bin";
    const originalName = attachment.originalName || fallbackName;
    const safeName = sanitizeAttachmentName(originalName.includes(".") ? originalName : fallbackName);
    const dir = join(
      config.paths.attachmentsDir,
      `${safePathPart(inbound.chatId)}_${safePathPart(inbound.messageId)}`
    );
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, safeName);
    writeFileSync(localPath, buffer);

    inbound.attachments = [{
      ...attachment,
      originalName,
      safeName,
      sizeBytes: buffer.byteLength,
      telegramFilePath: file.file_path,
      localPath,
      isImage: Boolean(attachment.isImage || isImageMimeOrName(attachment.mimeType, safeName))
    }];
    appendLog(config.paths.activityFile, `ATTACHMENT_SAVED chat=${inbound.chatId} message=${inbound.messageId} file=${safeName} bytes=${buffer.byteLength}`);
  } catch (error) {
    inbound.attachments = [{
      ...attachment,
      error: String(error?.message || error)
    }];
    appendLog(config.paths.activityFile, `ATTACHMENT_ERROR chat=${inbound.chatId} message=${inbound.messageId}: ${String(error?.message || error)}`);
  } finally {
    delete inbound.attachment;
  }
}

function normalizeInbound(message, updateType = "message") {
  const text = message.text ?? message.caption ?? "";
  const chatType = String(message.chat?.type || "unknown");
  const telegramThreadId = message.message_thread_id ? String(message.message_thread_id) : "";
  const chatId = String(message.chat.id);
  const sender = message.from || message.sender_chat || {};
  const receivedAt = nowIso();
  return {
    id: `telegram:${chatId}:${String(message.message_id)}`,
    source: "telegram",
    sourceMessageId: String(message.message_id),
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
    user: sender.username || sender.title || sender.first_name || "unknown",
    userId: sender.id ? String(sender.id) : "",
    text,
    attachment: pickTelegramAttachment(message),
    ts: receivedAt,
    createdAt: receivedAt,
    availableAt: receivedAt,
    leaseUntil: null,
    intent: "message",
    relevance: "ambient",
    updateType,
    status: "queued",
    attempts: 0,
    lastAttemptAt: null
  };
}

function buildInboundRelayEvent(config, inbound, status = "seen") {
  const relevance = String(inbound.relevance || "ambient").trim().toLowerCase();
  const sourceAgent = String(inbound.sourceAgent || inbound.source_agent || inbound.user || "telegram").trim() || "telegram";
  const targetAgent = ["direct"].includes(relevance) ? String(config.agentName || "").trim() : "";
  return {
    direction: "inbound",
    agentName: config.agentName,
    publisherAgent: config.agentName,
    publisher_agent: config.agentName,
    sourceAgent,
    source_agent: sourceAgent,
    targetAgent,
    target_agent: targetAgent,
    status,
    chatId: inbound.chatId,
    chat_id: inbound.chatId,
    messageId: inbound.messageId,
    message_id: inbound.messageId,
    replyToMessageId: inbound.replyToMessageId || "",
    reply_to_message_id: inbound.replyToMessageId || "",
    telegramThreadId: inbound.telegramThreadId || "",
    telegram_thread_id: inbound.telegramThreadId || "",
    chatType: inbound.chatType || "",
    chat_type: inbound.chatType || "",
    conversationKey: inbound.conversationKey || "",
    conversation_key: inbound.conversationKey || "",
    groupTitle: inbound.groupTitle || "",
    group_title: inbound.groupTitle || "",
    user: inbound.user || "",
    userId: inbound.userId || "",
    user_id: inbound.userId || "",
    senderIsBot: Boolean(inbound.senderIsBot),
    sender_is_bot: Boolean(inbound.senderIsBot),
    relevance,
    intent: inbound.intent || "message",
    updateType: inbound.updateType || "message",
    update_type: inbound.updateType || "message",
    scope: relevance === "lane" ? String(config.lane || "").trim() : "",
    priority: relevance === "escalation" ? "high" : "normal",
    text: inbound.text || "",
    ts: inbound.ts || nowIso()
  };
}

function buildOutboundRelayEvent(config, outbound, contextEntry = null) {
  const sourceAgent = String(config.agentName || "CodexLink").trim() || "CodexLink";
  return {
    direction: "outbound",
    agentName: config.agentName,
    publisherAgent: config.agentName,
    publisher_agent: config.agentName,
    sourceAgent,
    source_agent: sourceAgent,
    targetAgent: "",
    target_agent: "",
    status: "sent",
    chatId: outbound.chatId,
    chat_id: outbound.chatId,
    messageId: outbound.messageId,
    message_id: outbound.messageId,
    replyToMessageId: outbound.replyToMessageId || "",
    reply_to_message_id: outbound.replyToMessageId || "",
    telegramThreadId: outbound.telegramThreadId || "",
    telegram_thread_id: outbound.telegramThreadId || "",
    chatType: contextEntry?.chatType || (String(outbound.chatId || "").startsWith("-") ? "supergroup" : "private"),
    chat_type: contextEntry?.chatType || (String(outbound.chatId || "").startsWith("-") ? "supergroup" : "private"),
    conversationKey: contextEntry?.conversationKey || `${outbound.chatId}:${outbound.telegramThreadId || "root"}`,
    conversation_key: contextEntry?.conversationKey || `${outbound.chatId}:${outbound.telegramThreadId || "root"}`,
    groupTitle: contextEntry?.groupTitle || "",
    group_title: contextEntry?.groupTitle || "",
    user: config.displayName || config.agentName || "CodexLink",
    userId: "",
    user_id: "",
    senderIsBot: true,
    sender_is_bot: true,
    source: outbound.source || "manual",
    sourceTurnId: outbound.sourceTurnId || "",
    source_turn_id: outbound.sourceTurnId || "",
    scope: "",
    priority: "normal",
    text: outbound.text || "",
    ts: outbound.ts || nowIso()
  };
}

function firstRelayText(event, ...keys) {
  for (const key of keys) {
    const value = event?.[key];
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

function normalizeRelayAgentToken(value) {
  return String(value || "").trim().toLowerCase().replace(/^@+/, "");
}

function currentRelayAgentAliases(config) {
  const names = [
    config?.agentName,
    config?.displayName,
    ...(Array.isArray(config?.mentionNames) ? config.mentionNames : [])
  ];
  return new Set(names.map(normalizeRelayAgentToken).filter(Boolean));
}

function getRelayTargetMatch(config, targetAgent) {
  const raw = Array.isArray(targetAgent) ? targetAgent.join(",") : String(targetAgent || "");
  const targets = raw
    .split(/[,\s]+/)
    .map(normalizeRelayAgentToken)
    .filter(Boolean);
  if (targets.length === 0 || targets.some((value) => ["*", "all", "any", "team", "broadcast"].includes(value))) {
    return { matched: true, specific: false };
  }
  const aliases = currentRelayAgentAliases(config);
  return {
    matched: targets.some((target) => aliases.has(target)),
    specific: true
  };
}

function normalizeTeamRelayInbound(config, state, event) {
  const sourceAgent = firstRelayText(event, "sourceAgent", "source_agent", "agentName", "publisherAgent", "publisher_agent", "user");
  const publisherAgent = firstRelayText(event, "publisherAgent", "publisher_agent", "agentName");
  const currentAgent = normalizeRelayAgentToken(config.agentName || "");
  if (!event || normalizeRelayAgentToken(sourceAgent) === currentAgent || normalizeRelayAgentToken(publisherAgent) === currentAgent) {
    return null;
  }

  const targetAgent = firstRelayText(event, "targetAgent", "target_agent");
  const targetMatch = getRelayTargetMatch(config, targetAgent);
  if (!targetMatch.matched) {
    return null;
  }

  const chatId = firstRelayText(event, "chatId", "chat_id");
  const messageId = firstRelayText(event, "messageId", "message_id");
  const text = String(event.text || "").trim();
  const chatType = firstRelayText(event, "chatType", "chat_type").toLowerCase() || (chatId.startsWith("-") ? "supergroup" : "unknown");
  if (!chatId || !messageId || !text || chatType === "private") {
    return null;
  }

  const telegramThreadId = normalizeTelegramThreadId(firstRelayText(event, "telegramThreadId", "telegram_thread_id"));
  const conversationKey = firstRelayText(event, "conversationKey", "conversation_key") || `${chatId}:${telegramThreadId || "root"}`;
  const scope = firstRelayText(event, "scope");
  const priority = firstRelayText(event, "priority");
  const receivedAt = String(event.ts || "").trim() || nowIso();
  const inbound = {
    id: `team-relay:${chatId}:${messageId}`,
    source: "team-relay",
    sourceMessageId: messageId,
    chatId,
    messageId,
    replyToMessageId: firstRelayText(event, "replyToMessageId", "reply_to_message_id"),
    telegramThreadId,
    chatType,
    senderIsBot: Boolean(event.senderIsBot || event.sender_is_bot || String(event.direction || "").toLowerCase() === "outbound"),
    conversationKey,
    groupTitle: firstRelayText(event, "groupTitle", "group_title"),
    user: String(event.user || sourceAgent || "team-relay").trim() || "team-relay",
    userId: firstRelayText(event, "userId", "user_id"),
    text,
    ts: receivedAt,
    createdAt: receivedAt,
    availableAt: receivedAt,
    leaseUntil: null,
    intent: "message",
    relevance: "ambient",
    status: "queued",
    attempts: 0,
    lastAttemptAt: null,
    relay: {
      id: String(event.id || "").trim(),
      direction: String(event.direction || "").trim(),
      sourceAgent,
      publisherAgent,
      targetAgent,
      scope,
      priority
    }
  };
  const continueContext = buildContinueContext(state, inbound);
  inbound.intent = looksLikeContinueNudge(inbound.text, continueContext) ? "continue_nudge" : "message";
  inbound.relevance = classifyInboundRelevance(config, inbound);
  if (!armAgentCollectionWindow(config, state, inbound)) {
    promoteByAgentCollectionWindow(config, state, inbound);
  }
  if (!shouldAcceptBotRelayEntry(config, inbound)) {
    return null;
  }
  if (targetMatch.specific && inbound.relevance !== "escalation") {
    inbound.relevance = "direct";
  } else if (scope && config.lane && normalizeRelayAgentToken(scope) === normalizeRelayAgentToken(config.lane) && inbound.relevance === "ambient") {
    inbound.relevance = "lane";
  }
  if (priority.toLowerCase() === "high" && inbound.relevance === "ambient") {
    inbound.relevance = "escalation";
  }
  return inbound;
}

function buildContinueContext(state, inbound) {
  const sameConversation = (entry) => String(entry?.conversationKey || "").trim() === String(inbound?.conversationKey || "").trim();
  const recentEntries = [
    ...(state.queue || []),
    ...(state.pendingReplies || [])
  ].filter((entry) => {
    if (!entry || entry.senderIsBot) {
      return false;
    }
    if (!sameConversation(entry)) {
      return false;
    }
    const ageMs = isoAgeMs(entry.ts || entry.createdAt || entry.deliveredAt || entry.lastAttemptAt || "");
    return ageMs <= 1000 * 60 * 60 * 6;
  });

  const lastUserWorkEntry = [...recentEntries]
    .reverse()
    .find((entry) => String(entry.intent || "").trim().toLowerCase() !== "continue_nudge");

  return {
    conversationKey: inbound?.conversationKey || "",
    recentEntries,
    lastUserWorkText: lastUserWorkEntry?.text || lastUserWorkEntry?.sourceText || "",
    hasPendingReplies: (state.pendingReplies || []).some((entry) => {
      if (!entry || entry.senderIsBot || entry.sentAt) {
        return false;
      }
      return sameConversation(entry);
    })
  };
}

function looksLikeMnemoIdleLoopBrief(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }
  if (/^Mnemo Idle #\d+:/i.test(value)) {
    return true;
  }
  return /^---\s*BRIEF\b[\s\S]*\bfrom=mnemo-idle-loop\b[\s\S]*\[IDLE-CYCLE\]/i.test(value);
}

function normalizeTelegramThreadId(value) {
  return String(value || "").trim();
}

export function isAllowedChat(config, inbound) {
  const allowed = Array.isArray(config.allowedChatIds) ? config.allowedChatIds : [];
  if (allowed.length === 0) {
    return false;
  }
  const chatId = String(inbound?.chatId || inbound || "").trim();
  return allowed.includes(chatId);
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

function isPrivateChatType(chatType) {
  return String(chatType || "").trim().toLowerCase() === "private";
}

function isPrivateReplySuppressed(config) {
  const mode = String(config?.privateReplyMode || "").trim().toLowerCase();
  return ["off", "suppress", "disabled", "none", "group_only", "group-only"].includes(mode);
}

function isExplicitTrue(value) {
  return value === true || /^(1|true|yes|on)$/i.test(String(value || ""));
}

function assertNoPrivateDmGroupLeak(config, state, options = {}, contextEntry = null) {
  const explicitGroupBroadcast = isExplicitTrue(options.allowPrivateToGroup) && isExplicitTrue(options.confirmGroupBroadcast);
  if (!config.privateDmGroupGuard || explicitGroupBroadcast) {
    return;
  }
  const targetChatId = String(options.chatId || "").trim();
  if (!targetChatId) {
    return;
  }
  const source = String(options.source || "manual").trim();
  const sourceEntry = contextEntry || (source === "manual" ? state.lastInbound : null);
  if (!sourceEntry || !isPrivateChatType(sourceEntry.chatType)) {
    return;
  }
  const sourceChatId = String(sourceEntry.chatId || "").trim();
  if (sourceChatId && sourceChatId !== targetChatId) {
    throw new Error(
      `Refusing to send private DM context to a different chat (${sourceChatId} -> ${targetChatId}). ` +
      "Use allowPrivateToGroup plus confirmGroupBroadcast only after an explicit user request to inform the group."
    );
  }
}

function shouldSendDeferredReceipt(config, entry, reason) {
  return false;
  if (!config?.queueNoticeEnabled) {
    return false;
  }
  if (!entry) {
    return false;
  }
  if (entry.senderIsBot) {
    return false;
  }
  if (entry.intent === "continue_nudge") {
    return false;
  }
  if (entry.queueNoticeSentAt) {
    return false;
  }
  if (!["pending_reply", "session_active"].includes(String(reason || ""))) {
    return false;
  }
  const relevance = String(entry.relevance || "").toLowerCase();
  const chatType = String(entry.chatType || "").toLowerCase();
  if (chatType === "private" && isPrivateReplySuppressed(config)) {
    return false;
  }
  return chatType === "private";
}

function shouldSendTypingIndicator(config, entry) {
  if (!entry || entry.senderIsBot) {
    return false;
  }
  const relevance = String(entry.relevance || "").toLowerCase();
  const chatType = String(entry.chatType || "").toLowerCase();
  if (chatType === "private" && isPrivateReplySuppressed(config)) {
    return false;
  }
  return chatType === "private" || relevance === "direct" || relevance === "lane";
}

function buildDeferredReceiptText(entry) {
  const chatType = String(entry?.chatType || "").toLowerCase();
  const user = String(entry?.user || "").trim();
  if (chatType === "private") {
    return "Ich habe deine Nachricht. Ich ziehe sie nach dem aktuellen Lauf.";
  }
  if (user) {
    return `Alles klar ${user}, ich habe deine Nachricht. Ich ziehe sie nach dem aktuellen Lauf.`;
  }
  return "Ich habe die Nachricht. Ich ziehe sie nach dem aktuellen Lauf.";
}

function buildProgressFallbackText(entry) {
  const chatType = String(entry?.chatType || "").toLowerCase();
  const user = String(entry?.user || "").trim();
  if (chatType === "private") {
    return "Ich arbeite noch daran und melde den naechsten konkreten Stand hier.";
  }
  if (user) {
    return `${user}, ich arbeite noch daran und melde den naechsten konkreten Stand hier.`;
  }
  return "Ich arbeite noch daran und melde den naechsten konkreten Stand hier.";
}

function hasRecentSessionWrite(entry, sessionPath, activeWindowMs = 15000) {
  if (!entry?.createdAt || !sessionPath || !existsSync(sessionPath)) {
    return false;
  }
  try {
    const modifiedAt = statSync(sessionPath).mtimeMs;
    const createdAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdAt) || modifiedAt < createdAt) {
      return false;
    }
    return Date.now() - modifiedAt <= activeWindowMs;
  } catch {
    return false;
  }
}

function shouldSendFallbackProgress(config, entry, sessionPath) {
  if (!entry || entry.senderIsBot) {
    return false;
  }
  const fallbackMs = Math.max(Number(config.progressFallbackMs || 0), 0);
  if (fallbackMs <= 0 || isoAgeMs(entry.createdAt) < fallbackMs) {
    return false;
  }

  const intent = String(entry.intent || "").trim().toLowerCase();
  const relevance = String(entry.relevance || "").trim().toLowerCase();
  const sourceText = entry.sourceText || entry.text || "";
  const looksLikeWork = intent === "continue_nudge"
    || relevance === "escalation"
    || isAgentAddressed(config, sourceText)
    || looksLikeWorkContextText(sourceText);
  if (!looksLikeWork) {
    return false;
  }

  return hasRecentSessionWrite(entry, sessionPath);
}

function shouldSendProgressUpgrade(entry, progress) {
  if (!entry || !progress) {
    return false;
  }
  if (String(entry.progressMode || "").trim().toLowerCase() !== "fallback") {
    return false;
  }
  if (entry.progressUpgradeSentAt) {
    return false;
  }
  const progressText = normalizeWhitespace(repairMojibake(progress.message || ""));
  if (!progressText) {
    return false;
  }
  const fallbackText = normalizeWhitespace(repairMojibake(entry.progressPreview || ""));
  if (!fallbackText || progressText === fallbackText) {
    return false;
  }
  if (looksLikeAckOnly(progressText) || looksLikeContextRequestOnly(progressText)) {
    return false;
  }
  return true;
}

function getProgressRelayMode(config) {
  const mode = String(config?.progressRelayMode || "status").trim().toLowerCase();
  if (["off", "status", "commentary"].includes(mode)) {
    return mode;
  }
  return "status";
}

function getPendingReplyActivityAt(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  return String(
    entry.lastSignalAt
    || entry.progressSentAt
    || entry.sentAt
    || entry.createdAt
    || ""
  ).trim();
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repairMojibake(text) {
  const value = String(text || "");
  if (!/[ÃƒÃ¢ï¿½]/.test(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (repaired && !/\u0000/.test(repaired)) {
      return repaired;
    }
  } catch {
    // Fall through to targeted replacements.
  }

  return value
    .replace(/Ã¢â‚¬â€/g, "-")
    .replace(/Ã¢â‚¬â€œ/g, "-")
    .replace(/Ã¢â‚¬Å¾|Ã¢â‚¬Å“|Ã¢â‚¬Â/g, "\"")
    .replace(/Ã¢â‚¬â„¢|Ã¢â‚¬Ëœ/g, "'")
    .replace(/Ã¢â‚¬Â¦/g, "...")
    .replace(/Ã¢â€šÂ¬/g, "EUR")
    .replace(/Ãƒâ€ž/g, "Ã„")
    .replace(/Ãƒâ€“/g, "Ã–")
    .replace(/ÃƒÅ“/g, "Ãœ")
    .replace(/ÃƒÂ¤/g, "Ã¤")
    .replace(/ÃƒÂ¶/g, "Ã¶")
    .replace(/ÃƒÂ¼/g, "Ã¼")
    .replace(/ÃƒÅ¸/g, "ÃŸ");
}

function shouldPublishInboundUiNotice(entry) {
  if (!entry) {
    return false;
  }
  const chatType = String(entry.chatType || "").toLowerCase();
  const relevance = String(entry.relevance || "").toLowerCase();
  return chatType === "private" || ["direct", "lane", "escalation", "observe"].includes(relevance);
}

function formatCompactInboundUiNotice(entry) {
  let text = normalizeWhitespace(repairMojibake(entry?.text || "")).slice(0, 180);
  if (!text && Array.isArray(entry?.attachments) && entry.attachments.length > 0) {
    const first = entry.attachments[0];
    text = first?.isImage ? "sendete einen Screenshot" : `sendete ${first?.originalName || "eine Datei"}`;
  } else if (!text && entry?.attachment) {
    text = entry.attachment.isImage ? "sendete einen Screenshot" : `sendete ${entry.attachment.originalName || "eine Datei"}`;
  }
  if (!text) {
    return "";
  }
  if (/^(brief von|mnemo idle #)/i.test(text)) {
    return text;
  }
  const user = String(entry?.user || "unknown").trim();
  const groupTitle = String(entry?.groupTitle || "").trim();
  const chatType = String(entry?.chatType || "").trim().toLowerCase();
  if (chatType === "private" || !groupTitle) {
    return `${user}: ${text}`;
  }
  return `${user} @ ${groupTitle}: ${text}`;
}

function findRecentOutboundForTurn(config, chatId, source, sourceTurnId, text = "") {
  if (!config?.paths?.outboxFile || !existsSync(config.paths.outboxFile)) {
    return null;
  }
  const normalizedChatId = String(chatId || "").trim();
  const normalizedSource = String(source || "").trim();
  const normalizedTurnId = String(sourceTurnId || "").trim();
  const normalizedText = normalizeWhitespace(repairMojibake(text || ""));
  if (!normalizedChatId || !normalizedSource || !normalizedTurnId) {
    return null;
  }

  const matches = [];
  for (const line of readTail(config.paths.outboxFile, 400).reverse()) {
    try {
      const item = JSON.parse(line);
      if (String(item?.chatId || "").trim() !== normalizedChatId) {
        continue;
      }
      if (String(item?.source || "").trim() !== normalizedSource) {
        continue;
      }
      if (String(item?.sourceTurnId || "").trim() !== normalizedTurnId) {
        continue;
      }
      if (normalizedText) {
        const itemText = normalizeWhitespace(repairMojibake(item?.text || ""));
        if (itemText !== normalizedText) {
          continue;
        }
      }
      matches.push(item);
    } catch {
      // Ignore malformed tail lines.
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => String(left?.ts || "").localeCompare(String(right?.ts || "")));
  return {
    outbound: matches[matches.length - 1],
    messageIds: matches.map((item) => String(item.messageId || "").trim()).filter(Boolean)
  };
}

async function maybeSendDeferredReceipt(config, state, entry, reason) {
  if (!shouldSendDeferredReceipt(config, entry, reason)) {
    return false;
  }

  try {
    await sendOutboundChunks(config, state, {
      chatId: entry.chatId,
      text: buildDeferredReceiptText(entry),
      replyToMessageId: entry.messageId,
      telegramThreadId: entry.telegramThreadId,
      source: "queue_notice"
    });
    entry.queueNoticeSentAt = nowIso();
    entry.queueNoticeReason = String(reason || "");
    state.lastQueueNoticeAt = entry.queueNoticeSentAt;
    appendLog(
      config.paths.activityFile,
      `QUEUE_NOTICE chat=${entry.chatId} message=${entry.messageId} reason=${entry.queueNoticeReason || "-"}`
    );
    return true;
  } catch (error) {
    appendLog(
      config.paths.activityFile,
      `QUEUE_NOTICE_ERROR chat=${entry.chatId} message=${entry.messageId} reason=${String(reason || "-")}: ${error}`
    );
    return false;
  }
}

function shouldSendRuntimeQueueNotice(config, entry, result) {
  return false;
  const mode = String(process.env.BLUN_TELEGRAM_RUNTIME_QUEUE_NOTICE || "1").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(mode)) {
    return false;
  }
  if (!entry || entry.senderIsBot) {
    return false;
  }
  if (entry.intent === "continue_nudge") {
    return false;
  }
  if (entry.runtimeQueueNoticeSentAt) {
    return false;
  }
  const queuedBehindActiveTurn = Boolean(result?.queuedBehindActiveTurn)
    || /\bbehind_active_turn=1\b/.test(String(result?.responseText || ""));
  if (!queuedBehindActiveTurn) {
    return false;
  }
  const relevance = String(entry.relevance || "").toLowerCase();
  const chatType = String(entry.chatType || "").toLowerCase();
  if (chatType === "private" && isPrivateReplySuppressed(config)) {
    return false;
  }
  return chatType === "private";
}

function buildRuntimeQueueNoticeText() {
  return "In der Turnqueue. Läuft nach dem aktuellen Turn.";
}

async function maybeSendRuntimeQueueNotice(config, state, entry, result) {
  if (!shouldSendRuntimeQueueNotice(config, entry, result)) {
    return false;
  }

  try {
    await sendOutboundChunks(config, state, {
      chatId: entry.chatId,
      text: buildRuntimeQueueNoticeText(entry),
      replyToMessageId: entry.messageId,
      telegramThreadId: entry.telegramThreadId,
      source: "queue_notice"
    });
    const sentAt = nowIso();
    entry.runtimeQueueNoticeSentAt = sentAt;
    entry.runtimeQueueNoticeReason = "behind_active_turn";
    state.lastRuntimeQueueNoticeAt = sentAt;
    markMatchingQueueEntriesInPlace(state, entry, {
      runtimeQueueNoticeSentAt: sentAt,
      runtimeQueueNoticeReason: entry.runtimeQueueNoticeReason
    });
    appendLog(
      config.paths.activityFile,
      `RUNTIME_QUEUE_NOTICE chat=${entry.chatId} message=${entry.messageId} reason=${entry.runtimeQueueNoticeReason}`
    );
    return true;
  } catch (error) {
    appendLog(
      config.paths.activityFile,
      `RUNTIME_QUEUE_NOTICE_ERROR chat=${entry.chatId} message=${entry.messageId}: ${String(error?.message || error).slice(0, 220)}`
    );
    return false;
  }
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

function countOpenPendingReplies(state, config) {
  const timeoutMs = getEffectivePendingReplyTimeoutMs(config);
  return (state.pendingReplies || []).filter((entry) => {
    if (!isNonTerminalPendingReply(entry)) {
      return false;
    }
    if (timeoutMs > 0 && isoAgeMs(entry.createdAt) >= timeoutMs) {
      return false;
    }
    return true;
  }).length;
}

async function resolveSessionActivity(config, threadId, entry = null) {
  const sessionPath = await resolveThreadSessionPath(config, threadId);
  const cooldownMs = getEffectiveIdleCooldownMs(config, entry);
  if (!sessionPath || !existsSync(sessionPath)) {
    return {
      sessionPath,
      quietMs: Number.POSITIVE_INFINITY,
      active: false,
      cooldownMs
    };
  }

  const quietMs = Math.max(0, Date.now() - statSync(sessionPath).mtimeMs);
  return {
    sessionPath,
    quietMs,
    active: quietMs < cooldownMs,
    cooldownMs
  };
}

function buildPendingReplyEntry(message, threadId, turnId, sessionPath, sessionOffset) {
  return {
    turnId: String(turnId || "").trim(),
    threadId: String(threadId || "").trim(),
    sessionPath: String(sessionPath || "").trim(),
    sessionOffset: Number(sessionOffset || 0),
    chatId: String(message.chatId || "").trim(),
    messageId: String(message.messageId || "").trim(),
    replyToMessageId: String(message.replyToMessageId || message.messageId || "").trim(),
    telegramThreadId: normalizeTelegramThreadId(message.telegramThreadId),
    chatType: String(message.chatType || "").trim(),
    senderIsBot: Boolean(message.senderIsBot),
    conversationKey: String(message.conversationKey || "").trim(),
    groupTitle: String(message.groupTitle || "").trim(),
    user: String(message.user || "").trim(),
    sourceText: String(message.text || ""),
    intent: String(message.intent || "message").trim(),
    catchupForMessageId: String(message.catchupForMessageId || "").trim(),
    catchupObserveRefs: Array.isArray(message.catchupObserveRefs) ? message.catchupObserveRefs : [],
    createdAt: nowIso(),
    status: "pending",
    sentAt: null,
    responsePreview: "",
    responseMessageIds: []
  };
}

function shouldTrackPendingReply(config, message) {
  if (!message) {
    return false;
  }
  if (message.noTelegramReply === true) {
    return false;
  }
  if (String(message.relevance || "").trim().toLowerCase() === "observe") {
    return false;
  }
  if (looksLikeBotSender(message) && !shouldReplyToTeamBotSender(config, message)) {
    return false;
  }
  if (looksLikeAckOnly(message.text)) {
    return false;
  }
  const intent = String(message.intent || "message").trim().toLowerCase();
  if (intent !== "continue_nudge") {
    return true;
  }
  const chatType = String(message.chatType || "").trim().toLowerCase();
  return chatType === "group" || chatType === "supergroup";
}

function parseUnixSeconds(isoString) {
  const millis = Date.parse(isoString || "");
  if (Number.isNaN(millis)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(millis / 1000);
}

function isPidAlive(pid) {
  const parsed = Number.parseInt(String(pid || "0"), 10);
  if (!parsed || parsed <= 0) {
    return false;
  }
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function getRuntimeOwner(config) {
  if (!config.paths.currentRuntimeFile || !existsSync(config.paths.currentRuntimeFile)) {
    return null;
  }
  const runtime = loadJson(config.paths.currentRuntimeFile, null);
  if (!runtime) {
    return null;
  }
  if (config.appServerWsUrl && runtime.ws_url && String(runtime.ws_url).trim() !== String(config.appServerWsUrl).trim()) {
    return null;
  }
  const frontendHostPid = Number.parseInt(String(runtime.frontend_host_pid || "0"), 10) || 0;
  return {
    runtime,
    frontendHostPid,
    frontendAlive: isPidAlive(frontendHostPid)
  };
}

function normalizeThreadTimestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric > 100000000000 ? numeric : numeric * 1000;
}

function parseRuntimeStartedAtMs(runtime) {
  const parsed = Date.parse(String(runtime?.started_at || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildHistoryText(message) {
  let text = String(message.text || "").trim();
  if (!text && Array.isArray(message.attachments) && message.attachments.length > 0) {
    const first = message.attachments[0];
    text = first?.isImage ? "[Telegram screenshot]" : `[Telegram file: ${first?.originalName || "attachment"}]`;
  }
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

async function resolveActiveThreadId(config, state, preferredThreadId, options = {}) {
  const fallbackThreadId = String(preferredThreadId || config.currentThreadId || state.currentThreadId || "").trim();
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

    const runtimeOwner = getRuntimeOwner(config);
    const runtimeThreadId = String(runtimeOwner?.runtime?.thread_id || "").trim();
    const runtimeStartedAtMs = parseRuntimeStartedAtMs(runtimeOwner?.runtime);
    const pinnedThreadId = String(preferredThreadId || config.currentThreadId || runtimeThreadId || "").trim();
    if (pinnedThreadId && loadedIds.includes(pinnedThreadId)) {
      try {
        const pinnedResult = await readThreadOverWs({
          wsUrl: config.appServerWsUrl,
          threadId: pinnedThreadId,
          timeoutMs: 5000
        });
        const pinnedThread = pinnedResult?.response?.result?.thread || {};
        const pinnedIsSubAgent = Boolean(pinnedThread.parentThreadId || pinnedThread.forkedFromId || pinnedThread.source?.subAgent);
        if (!pinnedIsSubAgent) {
          if (state.currentThreadId !== pinnedThreadId) {
            state.currentThreadId = pinnedThreadId;
            saveStateForConfig(config, state);
            appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD_PINNED thread=${pinnedThreadId}`);
          }
          persistActiveThreadBinding(config, pinnedThreadId);
          return pinnedThreadId;
        }
        appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD_UNPIN_SUBAGENT thread=${pinnedThreadId}`);
      } catch {
        // Fall through to root-aware scoring.
      }
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
        const thread = readResult?.response?.result?.thread || {};
        const createdAtMs = normalizeThreadTimestampMs(thread.createdAt);
        if (createdAtMs > 0) {
          score = createdAtMs;
        }
        const isSubAgent = Boolean(thread.parentThreadId || thread.forkedFromId || thread.source?.subAgent);
        score += isSubAgent ? -5000000000000000 : 5000000000000000;
        const source = typeof thread.source === "string" ? thread.source.toLowerCase() : "";
        const statusType = String(thread.status?.type || "").toLowerCase();
        if (source === "cli" && statusType === "active") {
          score += 4000000000000000;
        } else if (statusType === "active") {
          score += 3000000000000000;
        } else if (source === "cli") {
          score += 2000000000000000;
        }
        if (runtimeStartedAtMs > 0 && createdAtMs >= runtimeStartedAtMs - 120000) {
          score += 1000000000000000;
        }
        const sessionPath = String(thread.path || "").trim();
        if (sessionPath && existsSync(sessionPath)) {
          score = Math.max(score, statSync(sessionPath).birthtimeMs || 0);
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
    persistActiveThreadBinding(config, bestThreadId);
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
  const runtimeOwner = getRuntimeOwner(config);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  const expiredPendingReplies = closeExpiredPendingRepliesInPlace(config, state.pendingReplies || []);
  if (expiredPendingReplies > 0 || parkedAmbient > 0) {
    if (parkedAmbient > 0) {
      appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    }
    saveStateForConfig(config, state);
  }
  const queued = state.queue.filter((item) => item.status === "queued");
  const submitted = state.queue.filter((item) => item.status === "submitted");
  const running = state.queue.filter((item) => item.status === "running");
  const parked = state.queue.filter((item) => item.status === "parked");
  const ambient = queued.filter((item) => item.relevance === "ambient");
  const observe = queued.filter((item) => item.relevance === "observe");
  const pendingReplies = (state.pendingReplies || []).filter((item) => isNonTerminalPendingReply(item));
  const expiredReplies = (state.pendingReplies || []).filter((item) => String(item.status || "") === "expired");
  return {
    agent: config.agentName,
    allowedChatId: config.allowedChatId || null,
    allowlistConfigured: config.allowedChatIds.length > 0,
    boundThreadId: config.currentThreadId || state.currentThreadId || null,
    frontendOwnerPid: runtimeOwner?.frontendHostPid || null,
    frontendOwnerAlive: runtimeOwner?.frontendAlive ?? null,
    dispatchMode: config.dispatchMode,
    groupDeliveryMode: config.groupDeliveryMode,
    idleCooldownMs: config.idleCooldownMs,
    pendingReplyTimeoutMs: config.pendingReplyTimeoutMs,
    queueDepth: queued.length,
    observeQueueDepth: observe.length,
    ambientQueueDepth: ambient.length,
    parkedQueueDepth: parked.length,
    submittedDepth: submitted.length,
    runningDepth: running.length,
    pendingReplyDepth: pendingReplies.length,
    expiredPendingReplyDepth: expiredReplies.length,
    progressRelayMode: getProgressRelayMode(config),
    lastInbound: state.lastInbound,
    lastOutbound: state.lastOutbound,
    lastPollAt: state.lastPollAt,
    lastInjectAt: state.lastInjectAt,
    teamRelay: teamRelayStatus(config),
    stateDir: config.paths.root,
    note: "The durable runtime queue is authoritative. Telegram intake is disabled until an allowlist is configured."
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

  if ((source === "auto" || source === "auto_progress") && sourceTurnId) {
    const existing = findRecentOutboundForTurn(config, chatId, source, sourceTurnId, text);
    if (existing?.outbound) {
      state.lastOutbound = existing.outbound;
      appendLog(
        config.paths.activityFile,
        `OUT_AUTO_SKIP_DUP chat=${chatId} reply_to=${replyToMessageId || "-"} turn=${sourceTurnId} outbound=${existing.messageIds.join(",")}`
      );
      return {
        ok: true,
        outbound: existing.outbound,
        messageIds: existing.messageIds,
        skippedDuplicate: true
      };
    }
  }

  const chunks = splitTelegramText(text);
  const messageIds = [];
  let lastOutbound = null;

  const contextEntry = [
    ...(state.queue || []),
    ...(state.pendingReplies || [])
  ].find((entry) => {
    if (String(entry.chatId || "").trim() !== chatId) {
      return false;
    }
    if (replyToMessageId && String(entry.messageId || entry.replyToMessageId || "").trim() === replyToMessageId) {
      return true;
    }
    if (telegramThreadId && String(entry.telegramThreadId || "").trim() === telegramThreadId) {
      return true;
    }
    return false;
  }) || null;

  assertNoPrivateDmGroupLeak(config, state, options, contextEntry);

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
    await publishTeamRelayEvent(config, buildOutboundRelayEvent(config, outbound, contextEntry));
    scheduleMnemoOutboundReceipt(config, outbound, contextEntry);
    messageIds.push(outbound.messageId);
    lastOutbound = outbound;
  }

  if (lastOutbound) {
    try {
      const preview = (
        typeof normalizeWhitespace === "function"
          ? normalizeWhitespace(repairMojibake(lastOutbound.text))
          : String(lastOutbound.text || "")
            .replace(/\r/g, " ")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim()
      ).slice(0, 140);
      const groupTitle = String(contextEntry?.groupTitle || "").trim();
      const user = String(contextEntry?.user || "").trim();
      const chatType = String(contextEntry?.chatType || "").trim().toLowerCase();
      let label = "Antwort";
      if (groupTitle) {
        label = `Antwort @ ${groupTitle}`;
      } else if (chatType === "private" && user) {
        label = `Antwort an ${user}`;
      }
      state.lastOutboundUiNotice = {
        ts: nowIso(),
        kind: "outbound",
        text: `${label}: ${preview}`
      };
    } catch (error) {
      appendLog(config.paths.activityFile, `UI_NOTICE_ERROR chat=${chatId} reply_to=${replyToMessageId || "-"}: ${error}`);
    }
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
  const parkedAmbientAtStart = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  if (parkedAmbientAtStart > 0) {
    appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbientAtStart}`);
  }
  if (state.intakeCursorInitialized !== true) {
    const pending = await getUpdates(config, -1);
    const updateIds = (pending || [])
      .map((update) => Number(update?.update_id))
      .filter((value) => Number.isSafeInteger(value) && value >= 0);
    const latestUpdateId = updateIds.length > 0 ? Math.max(...updateIds) : -1;
    state.offset = latestUpdateId >= 0 ? latestUpdateId + 1 : 0;
    state.intakeCursorInitialized = true;
    state.intakeInitializedAt = nowIso();
    state.lastPollAt = state.intakeInitializedAt;
    saveStateForConfig(config, state);
    appendLog(
      config.paths.activityFile,
      `INTAKE_TAIL_INITIALIZED next_offset=${state.offset} discarded_pending=${updateIds.length}`
    );
    return {
      ok: true,
      status: "tail_initialized",
      startOffset: null,
      nextOffset: state.offset,
      captured: 0,
      ignored: updateIds.length,
      discardedPending: updateIds.length
    };
  }

  const startOffset = Number(state.offset);
  const updates = await getUpdates(config, startOffset);
  let captured = 0;
  let ignored = 0;

  for (const update of updates) {
    state.offset = Math.max(Number(state.offset || 0), Number(update.update_id) + 1);
    const message = update.message
      || update.edited_message
      || update.channel_post
      || update.edited_channel_post
      || null;
    const updateType = update.message
      ? "message"
      : update.edited_message
        ? "edited_message"
        : update.channel_post
          ? "channel_post"
          : update.edited_channel_post
            ? "edited_channel_post"
            : "";
    if (!message) {
      ignored += 1;
      appendLog(
        config.paths.activityFile,
        `IGNORED_UPDATE_TYPE update=${update.update_id || "-"} keys=${Object.keys(update || {}).join(",") || "-"}`
      );
      continue;
    }
    const inbound = normalizeInbound(message, updateType);
    inbound.updateId = String(update.update_id);
    if (!isAllowedChat(config, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED chat=${inbound.chatId} user=${inbound.userId || "-"} message=${inbound.messageId}`);
      continue;
    }
    const diagnosticKind = diagnosticSmokeKind(inbound);
    if (diagnosticKind) {
      ignored += 1;
      appendJsonl(config.paths.inboxFile, {
        ...inbound,
        status: "ignored_diagnostic_smoke",
        diagnosticKind
      });
      appendLog(config.paths.activityFile, `DIAGNOSTIC_SMOKE_DROPPED kind=${diagnosticKind} chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    if (String(inbound.chatType || "") === "private" && looksLikeMnemoIdleLoopBrief(inbound.text)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_IDLE_BRIEF chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    if (!inbound.text.trim() && !inbound.attachment) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_EMPTY chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    const continueContext = buildContinueContext(state, inbound);
    inbound.intent = looksLikeContinueNudge(inbound.text, continueContext) ? "continue_nudge" : "message";
    inbound.relevance = classifyInboundRelevance(config, inbound);
    if (!armAgentCollectionWindow(config, state, inbound)) {
      promoteByAgentCollectionWindow(config, state, inbound);
    }
    if (!shouldAcceptBotRelayEntry(config, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_BOT_RELAY chat=${inbound.chatId} message=${inbound.messageId} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
      continue;
    }
    if (hasKnownInboundMessage(state, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_DUPLICATE chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    await captureInboundForMnemo(config, inbound, "poller");
    await publishTeamRelayEvent(config, buildInboundRelayEvent(config, inbound, "accepted"));
    if (String(inbound.chatType || "") !== "private" && String(inbound.relevance || "") === "ambient" && !shouldSubmitEveryAllowedMessage(config)) {
      ignored += 1;
      appendJsonl(config.paths.inboxFile, { ...inbound, status: "ignored_ambient" });
      appendLog(config.paths.activityFile, `IGNORED_AMBIENT chat=${inbound.chatId} message=${inbound.messageId} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
      continue;
    }
    if (shouldSendTypingIndicator(config, inbound)) {
      void sendChatAction(config, {
        chatId: inbound.chatId,
        telegramThreadId: inbound.telegramThreadId
      }).catch(() => {});
    }
    await stageTelegramAttachment(config, inbound);
    state.queue.push(inbound);
    state.lastInbound = inbound;
    appendJsonl(config.paths.inboxFile, inbound);
    appendLog(config.paths.activityFile, `IN chat=${inbound.chatId} message=${inbound.messageId} relevance=${inbound.relevance} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
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

export async function consumeTeamRelayOnce() {
  const config = loadConfig();
  const state = loadState(config);
  const delta = await readTeamRelayDelta(config);
  if (delta.disabled) {
    return { ok: true, status: "disabled", captured: 0, ignored: 0 };
  }
  if (delta.initializedAtTail) {
    return { ok: true, status: "tail_initialized", captured: 0, ignored: 0 };
  }

  let captured = 0;
  let ignored = 0;
  const consumedIds = [];
  const seenIds = new Set(Array.isArray(delta.previousCursor?.seenIds) ? delta.previousCursor.seenIds : []);

  for (const event of delta.items || []) {
    const eventId = String(event?.id || buildTeamRelayEventId(event)).trim();
    if (seenIds.has(eventId)) {
      ignored += 1;
      continue;
    }
    seenIds.add(eventId);
    consumedIds.push(eventId);

    const diagnosticKind = diagnosticSmokeKind(event);
    if (diagnosticKind) {
      ignored += 1;
      appendJsonl(config.paths.inboxFile, {
        id: eventId,
        source: "team-relay",
        chatId: firstRelayText(event, "chatId", "chat_id"),
        messageId: firstRelayText(event, "messageId", "message_id"),
        text: String(event?.text || ""),
        ts: String(event?.ts || "") || nowIso(),
        status: "ignored_diagnostic_smoke",
        diagnosticKind
      });
      appendLog(config.paths.activityFile, `TEAM_RELAY_DIAGNOSTIC_DROPPED kind=${diagnosticKind} id=${eventId}`);
      continue;
    }

    const inbound = normalizeTeamRelayInbound(config, state, event);
    if (!inbound) {
      ignored += 1;
      continue;
    }
    if (!isAllowedChat(config, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `TEAM_RELAY_IGNORED_CHAT id=${eventId} chat=${inbound.chatId} user=${inbound.userId || "-"}`);
      continue;
    }
    if (hasKnownInboundMessage(state, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `TEAM_RELAY_IGNORED_DUPLICATE id=${eventId} chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    await captureInboundForMnemo(config, inbound, "team-relay");
    if (String(inbound.chatType || "") !== "private" && String(inbound.relevance || "") === "ambient" && !shouldSubmitEveryAllowedMessage(config)) {
      ignored += 1;
      appendJsonl(config.paths.inboxFile, { ...inbound, status: "ignored_ambient_relay" });
      appendLog(config.paths.activityFile, `TEAM_RELAY_IGNORED_AMBIENT id=${eventId} chat=${inbound.chatId} message=${inbound.messageId} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
      continue;
    }

    state.queue.push(inbound);
    state.lastInbound = inbound;
    appendJsonl(config.paths.inboxFile, inbound);
    appendLog(config.paths.activityFile, `TEAM_RELAY_IN id=${eventId} chat=${inbound.chatId} message=${inbound.messageId} relevance=${inbound.relevance} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
    captured += 1;
  }

  const latestState = loadState(config);
  saveStateForConfig(config, mergeStateSnapshots(latestState, state));
  saveTeamRelayCursor(config, rememberTeamRelayIds(delta.cursor, consumedIds));
  return {
    ok: true,
    status: captured > 0 ? "captured" : "empty",
    captured,
    ignored
  };
}

export function listQueue(limit = 10) {
  const config = loadConfig();
  const state = loadState(config);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  if (parkedAmbient > 0) {
    appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    saveStateForConfig(config, state);
  }
  return state.queue.slice(-Math.max(1, limit));
}

function getQueuedDispatchPriority(item) {
  if (!item || item.status !== "queued") {
    return Number.MAX_SAFE_INTEGER;
  }
  const relevance = String(item.relevance || "").toLowerCase();
  const chatType = String(item.chatType || "").toLowerCase();
  if (relevance === "escalation") {
    return 0;
  }
  if (chatType === "private" || relevance === "direct" || relevance === "lane") {
    return 2;
  }
  return 3;
}

function compareQueuedDispatchOrder(left, right) {
  const priorityDiff = getQueuedDispatchPriority(left) - getQueuedDispatchPriority(right);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const leftTs = String(left?.ts || "");
  const rightTs = String(right?.ts || "");
  if (leftTs !== rightTs) {
    return leftTs.localeCompare(rightTs);
  }
  const leftMessage = Number.parseInt(String(left?.messageId || "0"), 10);
  const rightMessage = Number.parseInt(String(right?.messageId || "0"), 10);
  if (Number.isFinite(leftMessage) && Number.isFinite(rightMessage) && leftMessage !== rightMessage) {
    return leftMessage - rightMessage;
  }
  return String(left?.messageId || "").localeCompare(String(right?.messageId || ""));
}

async function resolveRuntimeActiveTurnId(config, threadId) {
  const wsUrl = String(config?.appServerWsUrl || "").trim();
  const resolvedThreadId = String(threadId || "").trim();
  if (!wsUrl || !resolvedThreadId) {
    return "";
  }
  try {
    const result = await getActiveTurnIdOverWs({
      wsUrl,
      threadId: resolvedThreadId,
      timeoutMs: Math.min(Number(config.resumeTimeoutMs || 10000) || 10000, 5000)
    });
    return result?.ok ? String(result.activeTurnId || "").trim() : "";
  } catch {
    return "";
  }
}

function isQueueRetryReady(item) {
  const retryAt = Date.parse(String(item?.retryAfterAt || ""));
  return !Number.isFinite(retryAt) || retryAt <= Date.now();
}

function selectNextQueuedEntry(queue, options = {}) {
  const auto = Boolean(options.auto);
  const deferredMode = String(options.dispatchMode || "deferred").toLowerCase() !== "legacy";
  const submitAllQueued = Boolean(options.submitAllQueued);
  const queued = Array.isArray(queue)
    ? queue.filter((item) => item?.status === "queued" && isQueueRetryReady(item))
    : [];
  if (!auto || !deferredMode) {
    return queued.sort(compareQueuedDispatchOrder)[0] || null;
  }
  if (submitAllQueued) {
    return queued.sort(compareQueuedDispatchOrder)[0] || null;
  }
  const eligible = queued.filter((item) => {
    const relevance = String(item.relevance || "").toLowerCase();
    const chatType = String(item.chatType || "").toLowerCase();
    return relevance === "escalation" || chatType === "private" || relevance === "direct" || relevance === "lane";
  });
  return eligible.sort(compareQueuedDispatchOrder)[0] || null;
}

function isGroupChatEntry(entry) {
  const chatType = String(entry?.chatType || "").trim().toLowerCase();
  return chatType === "group" || chatType === "supergroup";
}

function parseTelegramEntryTimeMs(entry) {
  const raw = String(entry?.ts || entry?.createdAt || entry?.receivedAt || entry?.lastSeenAt || "").trim();
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shouldAttachAgentGroupContext(message) {
  if (!message || isTransportSmokeEntry(message)) {
    return false;
  }
  const relevance = String(message.relevance || "").toLowerCase();
  const chatType = String(message.chatType || "").toLowerCase();
  if (relevance === "observe") {
    return false;
  }
  return relevance === "direct" || relevance === "lane" || relevance === "escalation" || chatType === "private";
}

function isAgentGroupObserveContextEntry(entry) {
  if (!entry) {
    return false;
  }
  const relevance = String(entry.relevance || "").toLowerCase();
  if (relevance !== "observe") {
    return false;
  }
  const status = String(entry.status || "").toLowerCase();
  if (status && status !== "queued" && status !== "parked") {
    return false;
  }
  const chatType = String(entry.chatType || "").toLowerCase();
  if (chatType === "private") {
    return false;
  }
  if (entry.observeContextSurfacedAt || isTransportSmokeEntry(entry)) {
    return false;
  }
  const text = String(entry.sourceText || entry.text || "").replace(/\s+/g, " ").trim();
  return Boolean(text);
}

function compactAgentGroupContextText(entry, maxChars = 320) {
  const raw = String(entry?.sourceText || entry?.text || "").replace(/\s+/g, " ").trim();
  if (raw.length <= maxChars) {
    return raw;
  }
  return `${raw.slice(0, Math.max(0, maxChars - 1)).trim()}...`;
}

function collectAgentGroupContextEntries(queue, lead, maxEntries = 12) {
  if (!shouldAttachAgentGroupContext(lead)) {
    return [];
  }
  const explicitRefs = Array.isArray(lead?.catchupObserveRefs)
    ? lead.catchupObserveRefs.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (explicitRefs.length) {
    const byId = new Map((Array.isArray(queue) ? queue : [])
      .map((entry) => [String(entry?.messageId || "").trim(), entry])
      .filter(([id, entry]) => id && entry));
    return explicitRefs
      .map((id) => byId.get(id))
      .filter((entry) => {
        if (!entry || isTransportSmokeEntry(entry)) {
          return false;
        }
        const chatType = String(entry.chatType || "").toLowerCase();
        if (chatType === "private") {
          return false;
        }
        const text = String(entry.sourceText || entry.text || "").replace(/\s+/g, " ").trim();
        return Boolean(text);
      })
      .slice(0, Math.max(1, maxEntries));
  }
  const leadMs = parseTelegramEntryTimeMs(lead) || Date.now();
  const minMs = leadMs - (6 * 60 * 60 * 1000);
  return (Array.isArray(queue) ? queue : [])
    .filter(isAgentGroupObserveContextEntry)
    .filter((entry) => {
      const entryMs = parseTelegramEntryTimeMs(entry);
      if (!entryMs) {
        return true;
      }
      return entryMs >= minMs && entryMs <= leadMs + 15000;
    })
    .sort((left, right) => parseTelegramEntryTimeMs(left) - parseTelegramEntryTimeMs(right))
    .slice(-Math.max(1, maxEntries));
}

function attachAgentGroupContextBlock(config, state, message) {
  const configuredMax = Number.parseInt(String(message?.agentGroupContextMaxEntries || ""), 10);
  const maxEntries = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 12;
  const entries = collectAgentGroupContextEntries(state?.queue || [], message, maxEntries);
  if (!entries.length) {
    return message;
  }
  const lines = [
    "[Agentgruppen-Kontext: mitgelesene Gruppenmeldungen seit dem letzten Alfred-Turn. Nur als Kontext nutzen; nicht einzeln beantworten.]"
  ];
  for (const entry of entries) {
    const stamp = String(entry.ts || entry.createdAt || "").trim();
    const user = String(entry.user || "Telegram").trim() || "Telegram";
    const id = String(entry.messageId || "").trim();
    const prefix = `${stamp ? `[${stamp}] ` : ""}${user}${id ? ` #${id}` : ""}:`;
    lines.push(`- ${prefix} ${compactAgentGroupContextText(entry)}`);
  }
  message.agentGroupContextBlock = lines.join("\n");
  message.agentGroupContextQueueKeys = entries.map((entry) => queueKey(entry)).filter(Boolean);
  appendLog(
    config.paths.activityFile,
    `OBSERVE_CONTEXT_ATTACH message=${message.messageId || "-"} count=${entries.length} refs=${entries.map((entry) => entry.messageId).filter(Boolean).join(",")}`
  );
  return message;
}

function markAgentGroupContextSurfacedInPlace(state, message, surfacedAt = nowIso()) {
  const keys = new Set(Array.isArray(message?.agentGroupContextQueueKeys) ? message.agentGroupContextQueueKeys : []);
  if (!keys.size) {
    return 0;
  }
  let count = 0;
  for (const entry of Array.isArray(state?.queue) ? state.queue : []) {
    if (!entry || !keys.has(queueKey(entry))) {
      continue;
    }
    entry.observeContextSurfacedAt = surfacedAt;
    entry.observeContextSurfacedByMessageId = String(message?.messageId || "").trim() || null;
    count += 1;
  }
  return count;
}

function collectCatchupObserveEntries(state, sourceEntry, maxEntries = 24) {
  const sourceMs = Date.parse(String(sourceEntry?.createdAt || sourceEntry?.ts || sourceEntry?.sentAt || ""));
  const minMs = Number.isFinite(sourceMs) ? sourceMs : 0;
  const sourceChatId = String(sourceEntry?.chatId || "").trim();
  return (Array.isArray(state?.queue) ? state.queue : [])
    .filter(isAgentGroupObserveContextEntry)
    .filter((entry) => {
      if (sourceChatId && String(entry.chatId || "").trim() !== sourceChatId) {
        return false;
      }
      const entryMs = parseTelegramEntryTimeMs(entry);
      return !minMs || !entryMs || entryMs > minMs;
    })
    .sort((left, right) => parseTelegramEntryTimeMs(left) - parseTelegramEntryTimeMs(right))
    .slice(0, Math.max(1, maxEntries));
}

function hasCatchupQueuedForSource(state, sourceEntry) {
  const sourceMessageId = String(sourceEntry?.messageId || "").trim();
  if (!sourceMessageId) {
    return false;
  }
  return (Array.isArray(state?.queue) ? state.queue : []).some((entry) => {
    if (String(entry?.catchupForMessageId || "").trim() !== sourceMessageId) {
      return false;
    }
    const status = String(entry?.status || "").toLowerCase();
    return !["error", "expired", "ignored_bot", "suppressed_ack", "suppressed_private_reply"].includes(status);
  });
}

function enqueueCatchupTurnIfNeeded(config, state, sourceEntry) {
  if (!sourceEntry || String(sourceEntry.intent || "").toLowerCase() === "catchup") {
    return 0;
  }
  if (hasCatchupQueuedForSource(state, sourceEntry)) {
    return 0;
  }
  const entries = collectCatchupObserveEntries(state, sourceEntry, 24);
  if (!entries.length) {
    return 0;
  }
  const now = nowIso();
  const sourceMessageId = String(sourceEntry.messageId || "").trim();
  const catchupMessageId = `catchup-${sourceMessageId}-${Date.now()}`;
  const catchup = {
    id: `runtime:${catchupMessageId}`,
    source: "runtime",
    sourceMessageId: catchupMessageId,
    chatId: String(sourceEntry.chatId || "").trim(),
    messageId: catchupMessageId,
    replyToMessageId: String(sourceEntry.replyToMessageId || sourceEntry.messageId || "").trim(),
    telegramThreadId: normalizeTelegramThreadId(sourceEntry.telegramThreadId),
    chatType: String(sourceEntry.chatType || "").trim(),
    conversationKey: String(sourceEntry.conversationKey || "").trim(),
    groupTitle: String(sourceEntry.groupTitle || "").trim(),
    user: "codexlink",
    userId: "codexlink",
    senderIsBot: false,
    text: [
      "Catch-up nach direktem Telegram-Auftrag:",
      "Seit Start des letzten Alfred-Turns sind weitere Gruppenmeldungen eingetroffen.",
      "Verarbeite sie über den Agentgruppen-Kontext. Wenn der letzte Auftrag Wiederholen/Test war, liefere die fehlenden Meldungen vollständig nach; sonst antworte nur bei konkretem Mehrwert."
    ].join(" "),
    sourceText: "CodexLink catch-up turn for parked group messages.",
    relevance: "direct",
    intent: "catchup",
    status: "queued",
    ts: now,
    createdAt: now,
    availableAt: now,
    leaseUntil: null,
    updateType: "catchup",
    catchupForMessageId: sourceMessageId,
    catchupObserveRefs: entries.map((entry) => String(entry.messageId || "").trim()).filter(Boolean),
    agentGroupContextMaxEntries: 24
  };
  state.queue.push(catchup);
  appendLog(
    config.paths.activityFile,
    `CATCHUP_QUEUED source=${sourceMessageId || "-"} message=${catchup.messageId} count=${entries.length} refs=${catchup.catchupObserveRefs.join(",")}`
  );
  return entries.length;
}

export async function injectNext(threadId, options = {}) {
  const config = loadConfig();
  let state = loadState(config);
  const recoveredInjecting = recoverStaleInjectingEntriesInPlace(state.queue || []);
  const reclassified = reclassifyQueuedEntriesInPlace(config, state.queue || []);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  const runtimeOwner = getRuntimeOwner(config);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  const expiredPendingReplies = closeExpiredPendingRepliesInPlace(config, state.pendingReplies || []);
  if (expiredPendingReplies > 0 || parkedAmbient > 0 || reclassified.changed > 0 || recoveredInjecting > 0) {
    if (recoveredInjecting > 0) {
      appendLog(config.paths.activityFile, `INJECT_STALE_RECOVERED count=${recoveredInjecting}`);
    }
    if (reclassified.changed > 0) {
      appendLog(config.paths.activityFile, `QUEUE_RECLASSIFIED changed=${reclassified.changed} parked=${reclassified.parked}`);
    }
    if (parkedAmbient > 0) {
      appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    }
    appendLog(config.paths.activityFile, `PENDING_REPLY_EXPIRED count=${expiredPendingReplies}`);
    saveStateForConfig(config, state);
  }
  const auto = Boolean(options.auto);
  const useAppServer = Boolean(config.appServerWsUrl);
  const useRuntimeTurnQueue = auto && useAppServer && String(config.dispatchMode || "deferred").toLowerCase() !== "legacy";
  if (auto && useAppServer && runtimeOwner && !runtimeOwner.frontendAlive) {
    appendLog(config.paths.activityFile, `OWNER_OFFLINE frontend_pid=${runtimeOwner.frontendHostPid || 0}`);
    return {
      ok: false,
      status: "deferred",
      reason: "owner_offline",
      frontendHostPid: runtimeOwner.frontendHostPid || 0
    };
  }

  let next = selectNextQueuedEntry(state.queue || [], {
    auto,
    dispatchMode: config.dispatchMode,
    submitAllQueued: shouldSubmitEveryAllowedMessage(config)
  });

  if (!next) {
    return {
      ok: true,
      status: auto ? "deferred" : "empty",
      reason: auto ? "no_eligible_message" : undefined
    };
  }

  if (isTransportSmokeEntry(next)) {
    next.status = "delivered";
    next.deliveredAt = nowIso();
    next.threadId = null;
    next.turnId = null;
    next.responsePreview = "transport_smoke_skipped";
    next.stderr = "";
    next.stdout = "";
    markMatchingQueueEntriesInPlace(state, next, {
      status: next.status,
      deliveredAt: next.deliveredAt,
      threadId: next.threadId,
      turnId: next.turnId,
      responsePreview: next.responsePreview,
      stderr: next.stderr,
      stdout: next.stdout,
      injectFinishedAt: next.deliveredAt
    });
    appendLog(config.paths.activityFile, `TRANSPORT_SMOKE_SKIPPED chat=${next.chatId} message=${next.messageId}`);
    const latestState = loadState(config);
    saveStateForConfig(config, mergeStateSnapshots(latestState, state));
    return {
      ok: true,
      status: "delivered",
      reason: "transport_smoke_skipped",
      message: next
    };
  }

  if (shouldAckOnlyAddressPing() && isAddressOnlyPing(config, next.text) && !looksLikeBotSender(next) && !isGroupChatEntry(next)) {
    next.status = "delivered";
    next.deliveredAt = nowIso();
    next.threadId = null;
    next.turnId = null;
    next.responsePreview = "plugin_ping_ack";
    next.stderr = null;
    next.stdout = null;
    markMatchingQueueEntriesInPlace(state, next, {
      status: next.status,
      deliveredAt: next.deliveredAt,
      threadId: next.threadId,
      turnId: next.turnId,
      responsePreview: next.responsePreview,
      stderr: next.stderr,
      stdout: next.stdout
    });
    appendLog(config.paths.activityFile, `PING_ACK chat=${next.chatId} message=${next.messageId}`);
    if (isPrivateChatType(next.chatType) && isPrivateReplySuppressed(config)) {
      appendLog(config.paths.activityFile, `PING_ACK_SUPPRESSED_PRIVATE chat=${next.chatId} message=${next.messageId}`);
    } else {
      await sendOutboundChunks(config, state, {
        chatId: next.chatId,
        text: "Ja, ich bin da.",
        replyToMessageId: next.messageId,
        telegramThreadId: next.telegramThreadId,
        source: "ping_ack"
      });
    }
    const latestState = loadState(config);
    saveStateForConfig(config, mergeStateSnapshots(latestState, state));
    return {
      ok: true,
      status: "delivered",
      reason: "ping_ack",
      message: next
    };
  }

  const explicitThreadId = String(threadId || "").trim();
  const preferredThreadId = (
    threadId
    || (useAppServer ? config.currentThreadId : state.currentThreadId)
    || (useAppServer ? state.currentThreadId : config.currentThreadId)
    || ""
  ).trim();
  let resolvedThreadId = await resolveActiveThreadId(config, state, preferredThreadId, {
    forcePreferred: Boolean(explicitThreadId || config.currentThreadId)
  });
  if (!resolvedThreadId) {
    throw new Error("No bound thread id. Use runtime_bind_thread first.");
  }
  const staleThreadPendingReplies = closeStaleThreadPendingRepliesInPlace(state.pendingReplies || [], resolvedThreadId);
  if (staleThreadPendingReplies > 0) {
    appendLog(config.paths.activityFile, `PENDING_REPLY_STALE_THREAD count=${staleThreadPendingReplies} active_thread=${resolvedThreadId}`);
    saveStateForConfig(config, state);
  }

  const bypassDeferredGate = auto && next.relevance === "escalation";
  if (bypassDeferredGate) {
    appendLog(config.paths.activityFile, `ESCALATION_BYPASS chat=${next.chatId} message=${next.messageId} intent=${next.intent || "-"} relevance=${next.relevance || "-"}`);
  }
  if (auto && !bypassDeferredGate && String(config.dispatchMode || "deferred").toLowerCase() !== "legacy") {
    const openPendingReplies = countOpenPendingReplies(state, config);
    if (openPendingReplies > 0 && !useRuntimeTurnQueue) {
        const retryMs = Math.max(75, Number.parseInt(String(process.env.BLUN_TELEGRAM_ACTIVE_TURN_RETRY_MS || "75"), 10) || 75);
      const retryAfterAt = new Date(Date.now() + retryMs).toISOString();
      next.status = "queued";
      next.lastAttemptAt = nowIso();
      next.retryAfterAt = retryAfterAt;
      markMatchingQueueEntriesInPlace(state, next, {
        status: next.status,
        lastAttemptAt: next.lastAttemptAt,
        retryAfterAt
      });
      appendLog(config.paths.activityFile, `PENDING_REPLY_DEFER message=${next.messageId} open=${openPendingReplies} retry_after=${retryAfterAt}`);
      await maybeSendDeferredReceipt(config, state, next, "pending_reply");
      saveStateForConfig(config, state);
      return {
        ok: false,
        status: "deferred",
        reason: "pending_reply",
        pendingReplies: openPendingReplies
      };
    }

    if (!useRuntimeTurnQueue) {
      const sessionActivity = await resolveSessionActivity(config, resolvedThreadId, next);
      if (sessionActivity.active) {
        await maybeSendDeferredReceipt(config, state, next, "session_active");
        saveStateForConfig(config, state);
        return {
          ok: false,
          status: "deferred",
          reason: "session_active",
          quietMs: sessionActivity.quietMs,
          readyInMs: Math.max(0, Number(sessionActivity.cooldownMs || 0) - Number(sessionActivity.quietMs || 0))
        };
      }
    }
  }
  if (useRuntimeTurnQueue && !bypassDeferredGate) {
    appendLog(config.paths.activityFile, `RUNTIME_TURN_QUEUE chat=${next.chatId} message=${next.messageId} intent=${next.intent || "-"} relevance=${next.relevance || "-"}`);
    const activeTurnId = await resolveRuntimeActiveTurnId(config, resolvedThreadId);
    if (activeTurnId) {
      const retryMs = Math.max(75, Number.parseInt(String(process.env.BLUN_TELEGRAM_ACTIVE_TURN_RETRY_MS || "75"), 10) || 75);
      const retryAfterAt = new Date(Date.now() + retryMs).toISOString();
      const checkedAt = nowIso();
      next.status = "queued";
      next.lastAttemptAt = checkedAt;
      next.retryAfterAt = retryAfterAt;
      next.activeTurnId = activeTurnId;
      next.responsePreview = "waiting_for_active_turn";
      markMatchingQueueEntriesInPlace(state, next, {
        status: next.status,
        lastAttemptAt: next.lastAttemptAt,
        retryAfterAt,
        activeTurnId,
        responsePreview: next.responsePreview
      });
      appendLog(config.paths.activityFile, `RUNTIME_TURN_DEFER message=${next.messageId} active_turn=${activeTurnId} retry_after=${retryAfterAt}`);
      saveStateForConfig(config, state);
      return {
        ok: false,
        status: "deferred",
        reason: "runtime_active_turn",
        activeTurnId,
        retryAfterAt,
        message: next
      };
    }
  }
  const selectedQueueKey = queueKey(next);
  const latestBeforeClaim = loadState(config);
  state = mergeStateSnapshots(latestBeforeClaim, state);
  next = (state.queue || []).find((entry) => queueKey(entry) === selectedQueueKey) || null;
  if (!next || String(next.status || "").toLowerCase() !== "queued") {
    return {
      ok: true,
      status: "deferred",
      reason: "queue_item_no_longer_claimable"
    };
  }
  next = attachAgentGroupContextBlock(config, state, next);

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

  next.attempts = Number(next.attempts || 0) + 1;
  next.lastAttemptAt = nowIso();
  next.status = "injecting";
  next.injectStartedAt = next.lastAttemptAt;
  next.leasedAt = next.lastAttemptAt;
  next.leaseUntil = new Date(Date.now() + Math.max(60000, Number(config.resumeTimeoutMs || 15000) * 4)).toISOString();
  next.retryAfterAt = null;
  markMatchingQueueEntriesInPlace(state, next, {
    status: "injecting",
    attempts: next.attempts,
    lastAttemptAt: next.lastAttemptAt,
    injectStartedAt: next.injectStartedAt,
    leasedAt: next.leasedAt,
    leaseUntil: next.leaseUntil,
    retryAfterAt: null
  });
  let sessionPath = "";
  let sessionOffset = 0;
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
  let result = await injectIntoThread(config, next, resolvedThreadId);
  const injectErrorText = `${result.responseText || ""}\n${result.stderr || ""}`;
  if (useAppServer && !result.ok && /thread\s+not\s+found/i.test(injectErrorText)) {
    appendLog(config.paths.activityFile, `INJECT_THREAD_NOT_FOUND_RETRY old_thread=${resolvedThreadId} message=${next.messageId}`);
    const retryThreadId = await resolveActiveThreadId(config, state, "", {
      forcePreferred: false
    });
    if (retryThreadId && retryThreadId !== resolvedThreadId) {
      resolvedThreadId = retryThreadId;
      next.threadId = retryThreadId;
      markMatchingQueueEntriesInPlace(state, next, {
        threadId: retryThreadId
      });
      saveStateForConfig(config, state);
      appendLog(config.paths.activityFile, `INJECT_RETRY_START thread=${resolvedThreadId} message=${next.messageId}`);
      result = await injectIntoThread(config, next, resolvedThreadId);
    } else {
      appendLog(config.paths.activityFile, `INJECT_THREAD_NOT_FOUND_RETRY_SKIPPED thread=${resolvedThreadId} message=${next.messageId}`);
    }
  }
  if (result.busy) {
    const promotedThisAttempt = useAppServer ? false : promoteVisibleQueuedEntry(config, state, resolvedThreadId, next);
    const activeRetryMs = Math.max(75, Number.parseInt(String(process.env.BLUN_TELEGRAM_ACTIVE_TURN_RETRY_MS || "750"), 10) || 750);
    const overloadBaseMs = Math.max(250, Number(config.runtimeOverloadBaseMs || 500));
    const overloadDelayMs = Math.min(30000, overloadBaseMs * Math.pow(2, Math.min(6, Math.max(0, next.attempts - 1))));
    const retryMs = result.overloaded
      ? overloadDelayMs + Math.floor(Math.random() * Math.max(100, overloadBaseMs))
      : activeRetryMs;
    const retryAfterAt = new Date(Date.now() + retryMs).toISOString();
    next.status = promotedThisAttempt ? "submitted" : "queued";
    next.retryAfterAt = retryAfterAt;
    next.leaseUntil = null;
    markMatchingQueueEntriesInPlace(state, next, {
      status: next.status,
      injectFinishedAt: nowIso(),
      retryAfterAt,
      leaseUntil: null
    });
    appendLog(config.paths.activityFile, `INJECT_BUSY thread=${resolvedThreadId} message=${next.messageId} overloaded=${result.overloaded ? 1 : 0} retry_ms=${retryMs}`);
    const latestState = loadState(config);
    markMatchingQueueEntriesInPlace(latestState, next, {
      status: next.status,
      injectFinishedAt: next.injectFinishedAt || nowIso(),
      retryAfterAt
    });
    saveStateForConfig(config, mergeStateSnapshots(latestState, state));
    return {
      ok: false,
      status: promotedThisAttempt ? "submitted" : "busy",
      threadId: resolvedThreadId,
      message: next
    };
  }

  const injectFinishedAt = nowIso();
  next.status = result.ok ? "submitted" : "error";
  next.submittedAt = result.ok ? injectFinishedAt : null;
  next.deliveredAt = result.ok ? null : injectFinishedAt;
  next.retryAfterAt = null;
  next.leaseUntil = null;
  next.threadId = resolvedThreadId;
  next.turnId = String(result.turnId || "").trim() || null;
  next.responsePreview = result.responseText.slice(0, 400);
  next.stderr = result.stderr.slice(0, 400);
  next.stdout = result.stdout.slice(0, 400);
  const injectResultUpdates = {
    status: next.status,
    deliveredAt: next.deliveredAt,
    submittedAt: next.submittedAt,
    threadId: next.threadId,
    turnId: next.turnId,
    responsePreview: next.responsePreview,
    stderr: next.stderr,
    stdout: next.stdout,
    injectFinishedAt,
    retryAfterAt: null,
    leaseUntil: null
  };
  markMatchingDeliveryStateInPlace(state, next, injectResultUpdates);
  if (result.ok) {
    const surfaced = markAgentGroupContextSurfacedInPlace(state, next, next.deliveredAt);
    if (surfaced > 0) {
      appendLog(config.paths.activityFile, `OBSERVE_CONTEXT_SURFACED message=${next.messageId || "-"} count=${surfaced}`);
    }
  }
  if (useAppServer && result.ok) {
    const trackPendingReply = shouldTrackPendingReply(config, next);
    if (!trackPendingReply) {
      next.status = "delivered";
      next.deliveredAt = injectFinishedAt;
      markMatchingQueueEntriesInPlace(state, next, {
        status: next.status,
        deliveredAt: next.deliveredAt
      });
      appendLog(config.paths.activityFile, `REPLY_SKIP_CONTINUE thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}`);
    } else {
      const pendingReply = buildPendingReplyEntry(next, resolvedThreadId, next.turnId, sessionPath, sessionOffset);
      if (looksLikeBotSender(next) && shouldReplyToTeamBotSender(config, next)) {
        pendingReply.trustedTeamBotReply = true;
      }
      state.pendingReplies = mergePendingReplyLists(state.pendingReplies || [], [pendingReply]);
      const noTurnSuffix = next.turnId ? "" : " no_turn=1";
      appendLog(config.paths.activityFile, `REPLY_PENDING thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}${noTurnSuffix}`);
    }
  }
  await maybeSendRuntimeQueueNotice(config, state, next, result);
  state.lastInjectAt = nowIso();
  state.lastAutoDispatchAt = auto ? state.lastInjectAt : state.lastAutoDispatchAt;
  const latestState = loadState(config);
  markMatchingDeliveryStateInPlace(latestState, next, injectResultUpdates);
  if (result.ok) {
    markAgentGroupContextSurfacedInPlace(latestState, next, next.deliveredAt);
  }
  saveStateForConfig(config, mergeStateSnapshots(latestState, state));
  const injectPreview = normalizeWhitespace(result.responseText || result.stderr || "").slice(0, 220);
  if (injectPreview) {
    appendLog(config.paths.activityFile, `INJECT_RESULT thread=${resolvedThreadId} message=${next.messageId}: ${injectPreview}`);
  }
  appendLog(config.paths.activityFile, `INJECT_${result.ok ? "OK" : "ERROR"} thread=${resolvedThreadId} message=${next.messageId}`);
  return {
    ok: result.ok,
    status: result.ok ? next.status : "error",
    threadId: resolvedThreadId,
    message: next,
    responsePreview: result.responseText.slice(0, 400),
    stderr: result.stderr.slice(0, 400)
  };
}

export async function relayRepliesOnce() {
  const config = loadConfig();
  if (config.appServerWsUrl) {
    const state = loadState(config);
    return {
      ok: true,
      status: "app_server_events",
      delivered: 0,
      pending: (state.pendingReplies || []).filter((entry) => isNonTerminalPendingReply(entry)).length
    };
  }
  scheduleMnemoOutboundRetryDrain(config);
  const state = loadState(config);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  const supersededPendingReplies = supersedeOlderPendingRepliesInPlace(state.pendingReplies || []);
  closeExpiredPendingRepliesInPlace(config, state.pendingReplies || []);
  if (parkedAmbient > 0 || supersededPendingReplies > 0) {
    appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    if (supersededPendingReplies > 0) {
      appendLog(config.paths.activityFile, `PENDING_REPLY_SUPERSEDED count=${supersededPendingReplies}`);
    }
  }

  for (const entry of state.pendingReplies || []) {
    if (entry.sentAt || entry.status === "error") {
      continue;
    }
    if (!looksLikeBotSender(entry) || entry.trustedTeamBotReply === true || shouldReplyToTeamBotSender(config, entry)) {
      continue;
    }
    entry.status = "ignored_bot";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || "[ignored bot message]";
  }

  const pendingReplies = (state.pendingReplies || []).filter((entry) => isReplyAwaitingOutcome(entry));
  if (pendingReplies.length === 0) {
    saveStateForConfig(config, state);
    return { ok: true, status: "empty", delivered: 0 };
  }

  let delivered = 0;
  const usedTurnIds = new Set();
  const usedProgressKeys = new Set();
  const sessionSignals = new Map();

  for (const entry of pendingReplies) {
    if (isPrivateChatType(entry.chatType) && isPrivateReplySuppressed(config)) {
      entry.sentAt = nowIso();
      entry.status = "suppressed_private_reply";
      entry.responsePreview = entry.responsePreview || "[private Telegram replies suppressed by BLUN_TELEGRAM_PRIVATE_REPLY_MODE]";
      appendLog(config.paths.activityFile, `REPLY_SUPPRESSED_PRIVATE chat=${entry.chatId} source_message=${entry.messageId}`);
      continue;
    }

    if (!entry.sessionPath) {
      entry.sessionPath = await resolveThreadSessionPath(config, entry.threadId);
    }
    if (!entry.sessionPath || !existsSync(entry.sessionPath)) {
      continue;
    }

    if (!sessionSignals.has(entry.sessionPath)) {
      const fallbackOffset = pendingReplies
        .filter((candidate) => candidate.sessionPath === entry.sessionPath)
        .reduce((lowest, candidate) => Math.min(lowest, Number(candidate.sessionOffset || 0)), Number(entry.sessionOffset || 0));
      const savedOffset = Number((state.replyOffsets || {})[entry.sessionPath] ?? fallbackOffset);
      const currentOffset = Math.min(savedOffset, fallbackOffset);
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
      const turnCompletions = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "task_complete")
        .map((item) => ({
          turnId: String(item?.payload?.turn_id || "").trim(),
          message: String(item?.payload?.last_agent_message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.turnId || item.timestamp);
      const finalAnswers = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "agent_message" && String(item?.payload?.phase || "").trim().toLowerCase() === "final_answer")
        .map((item) => ({
          message: String(item?.payload?.message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.message);
      const commentaries = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "agent_message" && String(item?.payload?.phase || "").trim().toLowerCase() === "commentary")
        .map((item) => ({
          message: String(item?.payload?.message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.message);
      const aborts = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "turn_aborted")
        .map((item) => ({
          turnId: String(item?.payload?.turn_id || "").trim(),
          reason: String(item?.payload?.reason || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.timestamp);
      sessionSignals.set(entry.sessionPath, { completions, turnCompletions, finalAnswers, commentaries, aborts });
    }

    const signals = sessionSignals.get(entry.sessionPath) || { completions: [], turnCompletions: [], finalAnswers: [], commentaries: [], aborts: [] };
    const completions = signals.completions || [];
    const turnCompletions = signals.turnCompletions || [];
    const finalAnswers = signals.finalAnswers || [];
    const commentaries = signals.commentaries || [];
    const aborts = signals.aborts || [];
    const progressRelayMode = getProgressRelayMode(config);

    const abortedTurn = aborts.find((item) => {
      if (item.timestamp < entry.createdAt) {
        return false;
      }
      return !entry.turnId || !item.turnId || item.turnId === entry.turnId;
    });
    if (abortedTurn) {
      entry.sentAt = nowIso();
      entry.status = "aborted";
      entry.turnId = entry.turnId || abortedTurn.turnId || "";
      entry.responsePreview = abortedTurn.reason ? `[turn aborted: ${abortedTurn.reason}]` : "[turn aborted]";
      appendLog(config.paths.activityFile, `REPLY_ABORTED thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId}`);
      continue;
    }

    if (progressRelayMode === "commentary" && !entry.progressSentAt) {
      const progress = commentaries.find((item) => {
        const key = `${item.timestamp}|${item.message}`;
        return item.timestamp >= entry.createdAt && !usedProgressKeys.has(key);
      });
      if (progress) {
        const outboundProgress = await sendOutboundChunks(config, state, {
          chatId: entry.chatId,
          text: progress.message,
          replyToMessageId: entry.replyToMessageId,
          telegramThreadId: entry.telegramThreadId,
          source: "auto_progress",
          sourceTurnId: entry.turnId || null
        });
        entry.progressSentAt = nowIso();
        entry.lastSignalAt = entry.progressSentAt;
        entry.progressMode = "commentary";
        entry.progressPreview = progress.message.slice(0, 400);
        entry.progressMessageIds = outboundProgress.messageIds;
        entry.progressKey = `${progress.timestamp}|${progress.message}`;
        usedProgressKeys.add(`${progress.timestamp}|${progress.message}`);
        appendLog(config.paths.activityFile, `REPLY_PROGRESS_SENT thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundProgress.messageIds.join(",")}`);
      }
    }

    if (progressRelayMode !== "off" && !entry.progressSentAt && shouldSendFallbackProgress(config, entry, entry.sessionPath)) {
      const fallbackText = buildProgressFallbackText(entry);
      const outboundProgress = await sendOutboundChunks(config, state, {
        chatId: entry.chatId,
        text: fallbackText,
        replyToMessageId: entry.replyToMessageId,
        telegramThreadId: entry.telegramThreadId,
        source: "auto_progress",
        sourceTurnId: entry.turnId || null
      });
      entry.progressSentAt = nowIso();
      entry.lastSignalAt = entry.progressSentAt;
      entry.progressMode = "fallback";
      entry.progressPreview = fallbackText.slice(0, 400);
      entry.progressMessageIds = outboundProgress.messageIds;
      appendLog(config.paths.activityFile, `REPLY_PROGRESS_FALLBACK thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundProgress.messageIds.join(",")}`);
    }

    if (progressRelayMode === "commentary" && entry.progressSentAt) {
      const upgrade = commentaries.find((item) => {
        const key = `${item.timestamp}|${item.message}`;
        return item.timestamp >= entry.createdAt
          && key !== entry.progressKey
          && !usedProgressKeys.has(key)
          && shouldSendProgressUpgrade(entry, item);
      });
      if (upgrade) {
        const outboundUpgrade = await sendOutboundChunks(config, state, {
          chatId: entry.chatId,
          text: upgrade.message,
          replyToMessageId: entry.replyToMessageId,
          telegramThreadId: entry.telegramThreadId,
          source: "auto_progress",
          sourceTurnId: entry.turnId || null
        });
        entry.progressUpgradeSentAt = nowIso();
        entry.lastSignalAt = entry.progressUpgradeSentAt;
        entry.progressUpgradePreview = upgrade.message.slice(0, 400);
        entry.progressUpgradeMessageIds = outboundUpgrade.messageIds;
        entry.progressUpgradeKey = `${upgrade.timestamp}|${upgrade.message}`;
        usedProgressKeys.add(`${upgrade.timestamp}|${upgrade.message}`);
        appendLog(config.paths.activityFile, `REPLY_PROGRESS_UPGRADE thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundUpgrade.messageIds.join(",")}`);
      }
    }

    let match = null;
    const finalAnswer = finalAnswers.find((item) => item.timestamp >= entry.createdAt && !usedProgressKeys.has(`final|${item.timestamp}|${item.message}`));
    if (finalAnswer) {
      match = {
        turnId: entry.turnId || "",
        message: finalAnswer.message,
        timestamp: finalAnswer.timestamp,
        source: "final_answer"
      };
      usedProgressKeys.add(`final|${finalAnswer.timestamp}|${finalAnswer.message}`);
    }
    if (entry.turnId) {
      match = match || completions.find((item) => item.turnId === entry.turnId);
    } else {
      match = match || completions.find((item) => item.timestamp >= entry.createdAt && !usedTurnIds.has(item.turnId));
    }
    if (!match) {
      const completedTurn = turnCompletions.find((item) => {
        if (item.timestamp && item.timestamp < entry.createdAt) {
          return false;
        }
        return !entry.turnId || !item.turnId || item.turnId === entry.turnId;
      });
      if (completedTurn) {
        entry.sentAt = nowIso();
        entry.status = "no_reply_completed";
        entry.turnId = entry.turnId || completedTurn.turnId || "";
        entry.lastSignalAt = entry.sentAt;
        entry.responsePreview = "[turn completed without reply]";
        markMatchingQueueEntriesInPlace(state, entry, {
          status: "delivered",
          deliveredAt: entry.sentAt,
          threadId: entry.threadId,
          turnId: entry.turnId,
          responsePreview: entry.responsePreview
        });
        if (entry.turnId) {
          usedTurnIds.add(entry.turnId);
        }
        appendLog(config.paths.activityFile, `REPLY_NONE_COMPLETED thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId}`);
        enqueueCatchupTurnIfNeeded(config, state, entry);
      }
      continue;
    }

    if (entry.intent === "continue_nudge" && (looksLikeAckOnly(match.message) || looksLikeContextRequestOnly(match.message))) {
      entry.sentAt = nowIso();
      entry.status = "suppressed_ack";
      entry.turnId = entry.turnId || match.turnId;
      entry.responsePreview = match.message.slice(0, 400);
      usedTurnIds.add(match.turnId);
      appendLog(config.paths.activityFile, `REPLY_SUPPRESSED_CONTINUE_ACK thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId}`);
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
    entry.lastSignalAt = entry.sentAt;
    entry.responsePreview = match.message.slice(0, 400);
    entry.responseMessageIds = outboundResult.messageIds;
    markMatchingQueueEntriesInPlace(state, entry, {
      status: "delivered",
      deliveredAt: entry.sentAt,
      threadId: entry.threadId,
      turnId: entry.turnId,
      responsePreview: entry.responsePreview
    });
    usedTurnIds.add(match.turnId);
    appendLog(config.paths.activityFile, `REPLY_SENT thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundResult.messageIds.join(",")}`);
    enqueueCatchupTurnIfNeeded(config, state, entry);
    delivered += 1;
  }

  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  saveStateForConfig(config, state);
  return {
    ok: true,
    status: delivered > 0 ? "sent" : "pending",
    delivered,
    pending: (state.pendingReplies || []).filter((entry) => isNonTerminalPendingReply(entry)).length
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
    source: "manual",
    allowPrivateToGroup: options.allowPrivateToGroup,
    confirmGroupBroadcast: options.confirmGroupBroadcast
  });
  saveStateForConfig(config, state);
  return result;
}

export function enqueueRuntimeMessage(text, options = {}) {
  const config = loadConfig();
  const state = loadState(config);
  const value = String(text || "").trim();
  if (!value) {
    throw new Error("Runtime queue text is empty.");
  }
  if (value.length > 100000) {
    const error = new Error("Runtime queue text exceeds 100000 characters.");
    error.statusCode = 413;
    throw error;
  }
  const createdAt = nowIso();
  const messageId = String(options.messageId || randomUUID()).trim();
  const chatId = String(options.chatId || `runtime:${config.agentName}`).trim();
  const item = {
    id: `runtime:${messageId}`,
    source: String(options.source || "mcp"),
    sourceMessageId: messageId,
    chatId,
    messageId,
    replyToMessageId: "",
    telegramThreadId: "",
    chatType: "runtime",
    senderIsBot: false,
    conversationKey: String(options.conversationKey || `${chatId}:runtime`),
    groupTitle: "",
    user: String(options.user || "CodexLink MCP"),
    userId: "",
    text: value,
    ts: createdAt,
    createdAt,
    availableAt: createdAt,
    leaseUntil: null,
    intent: "message",
    relevance: "direct",
    updateType: "runtime",
    status: "queued",
    attempts: 0,
    lastAttemptAt: null,
    noTelegramReply: options.noTelegramReply !== false
  };
  if (hasKnownInboundMessage(state, item)) {
    return { ok: true, duplicate: true, item: state.queue.find((entry) => queueKey(entry) === queueKey(item)) || item };
  }
  state.queue.push(item);
  state.lastInbound = item;
  appendJsonl(config.paths.inboxFile, item);
  appendLog(config.paths.activityFile, `RUNTIME_ENQUEUE id=${item.id} source=${item.source}`);
  saveStateForConfig(config, state);
  return { ok: true, duplicate: false, item };
}

export function cancelRuntimeQueueItem(identifier) {
  const config = loadConfig();
  const state = loadState(config);
  const key = String(identifier || "").trim();
  if (!key) {
    throw new Error("Queue item id is required.");
  }
  const item = (state.queue || []).find((entry) => {
    return String(entry.id || "") === key
      || String(entry.messageId || "") === key
      || queueKey(entry) === key;
  });
  if (!item) {
    throw new Error(`Queue item not found: ${key}`);
  }
  if (!["queued", "parked", "error", "failed"].includes(String(item.status || "").toLowerCase())) {
    const error = new Error(`Queue item ${key} cannot be cancelled while status is ${item.status}.`);
    error.statusCode = 409;
    throw error;
  }
  item.status = "cancelled";
  item.cancelledAt = nowIso();
  item.leaseUntil = null;
  item.retryAfterAt = null;
  saveStateForConfig(config, state);
  appendLog(config.paths.activityFile, `RUNTIME_CANCEL id=${item.id || item.messageId}`);
  return { ok: true, item };
}

export async function completeRuntimeTurnFromEvent(event) {
  const config = loadConfig();
  const state = loadState(config);
  const turnId = String(event?.turnId || "").trim();
  const threadId = String(event?.threadId || "").trim();
  const status = String(event?.status || "completed").trim().toLowerCase();
  const finalText = String(event?.finalText || "").trim();
  const pending = (state.pendingReplies || []).find((entry) => {
    if (!isReplyAwaitingOutcome(entry)) {
      return false;
    }
    if (turnId && String(entry.turnId || "").trim() === turnId) {
      return true;
    }
    return !entry.turnId && threadId && String(entry.threadId || "").trim() === threadId;
  });

  if (!pending) {
    appendLog(config.paths.activityFile, `RUNTIME_TURN_EVENT_UNMATCHED thread=${threadId || "-"} turn=${turnId || "-"} status=${status}`);
    return { ok: true, matched: false, turnId, status };
  }

  pending.turnId = pending.turnId || turnId;
  pending.lastSignalAt = event.completedAt || nowIso();
  if (status !== "completed") {
    pending.sentAt = pending.lastSignalAt;
    pending.status = status === "interrupted" ? "aborted" : "error";
    pending.responsePreview = String(event?.error?.message || `[turn ${status}]`).slice(0, 400);
    markMatchingQueueEntriesInPlace(state, pending, {
      status: status === "interrupted" ? "cancelled" : "failed",
      deliveredAt: pending.sentAt,
      threadId: pending.threadId,
      turnId: pending.turnId,
      responsePreview: pending.responsePreview
    });
    saveStateForConfig(config, state);
    appendLog(config.paths.activityFile, `RUNTIME_TURN_${status.toUpperCase()} thread=${threadId || "-"} turn=${turnId || "-"}`);
    return { ok: true, matched: true, delivered: false, turnId, status };
  }

  if (!finalText) {
    pending.sentAt = pending.lastSignalAt;
    pending.status = "no_reply_completed";
    pending.responsePreview = "[turn completed without reply]";
    markMatchingQueueEntriesInPlace(state, pending, {
      status: "delivered",
      deliveredAt: pending.sentAt,
      threadId: pending.threadId,
      turnId: pending.turnId,
      responsePreview: pending.responsePreview
    });
    enqueueCatchupTurnIfNeeded(config, state, pending);
    saveStateForConfig(config, state);
    return { ok: true, matched: true, delivered: false, turnId, status };
  }

  if (pending.intent === "continue_nudge" && (looksLikeAckOnly(finalText) || looksLikeContextRequestOnly(finalText))) {
    pending.sentAt = pending.lastSignalAt;
    pending.status = "suppressed_ack";
    pending.responsePreview = finalText.slice(0, 400);
    markMatchingQueueEntriesInPlace(state, pending, {
      status: "delivered",
      deliveredAt: pending.sentAt,
      threadId: pending.threadId,
      turnId: pending.turnId,
      responsePreview: pending.responsePreview
    });
    saveStateForConfig(config, state);
    return { ok: true, matched: true, delivered: false, suppressed: true, turnId, status };
  }

  if (isPrivateChatType(pending.chatType) && isPrivateReplySuppressed(config)) {
    pending.sentAt = pending.lastSignalAt;
    pending.status = "suppressed_private_reply";
    pending.responsePreview = finalText.slice(0, 400);
    markMatchingQueueEntriesInPlace(state, pending, {
      status: "delivered",
      deliveredAt: pending.sentAt,
      threadId: pending.threadId,
      turnId: pending.turnId,
      responsePreview: pending.responsePreview
    });
    saveStateForConfig(config, state);
    return { ok: true, matched: true, delivered: false, suppressed: true, turnId, status };
  }

  const outbound = await sendOutboundChunks(config, state, {
    chatId: pending.chatId,
    text: finalText,
    replyToMessageId: pending.replyToMessageId,
    telegramThreadId: pending.telegramThreadId,
    source: "auto",
    sourceTurnId: pending.turnId
  });
  pending.sentAt = nowIso();
  pending.status = "sent";
  pending.responsePreview = finalText.slice(0, 400);
  pending.responseMessageIds = outbound.messageIds;
  markMatchingQueueEntriesInPlace(state, pending, {
    status: "replied",
    deliveredAt: pending.sentAt,
    threadId: pending.threadId,
    turnId: pending.turnId,
    responsePreview: pending.responsePreview
  });
  enqueueCatchupTurnIfNeeded(config, state, pending);
  saveStateForConfig(config, state);
  appendLog(config.paths.activityFile, `RUNTIME_REPLY_SENT thread=${threadId || "-"} turn=${turnId || "-"} outbound=${outbound.messageIds.join(",")}`);
  return { ok: true, matched: true, delivered: true, turnId, status, messageIds: outbound.messageIds };
}

export function tailActivity(lines = 20) {
  const config = loadConfig();
  return readTail(config.paths.activityFile, lines);
}
