import { readFileSync } from "node:fs";
import { ensureStateLayout, getPaths } from "./paths.js";

function readDotEnvFile(path) {
  const values = {};
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) {
        continue;
      }
      const [rawKey, ...rest] = line.split("=");
      values[rawKey.trim()] = rest.join("=").trim();
    }
  } catch {
    return values;
  }
  return values;
}

function parseAllowedChatIds(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseMentionNames(rawValue) {
  return Array.from(new Set(
    String(rawValue || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  ));
}

export function loadConfig() {
  ensureStateLayout();
  const paths = getPaths();
  const fileEnv = readDotEnvFile(paths.envFile);
  const legacyEnv = readDotEnvFile(`${paths.legacyRoot}\\.env`);
  const fallbackEnv = { ...legacyEnv };
  delete fallbackEnv.BLUN_TELEGRAM_AGENT_NAME;
  delete fallbackEnv.BLUN_TELEGRAM_STATE_DIR;
  delete fallbackEnv.BLUN_TELEGRAM_THREAD_ID;
  const env = { ...fallbackEnv, ...process.env, ...fileEnv };
  const allowedChatIds = parseAllowedChatIds(env.BLUN_TELEGRAM_ALLOWED_CHAT_ID || env.TELEGRAM_ALLOWED_CHAT_ID || "");
  const mentionNames = parseMentionNames(
    env.BLUN_TELEGRAM_MENTION_NAMES
    || env.BLUN_CODEX_AGENT
    || env.TELEGRAM_AGENT_NAME
    || env.BLUN_TELEGRAM_AGENT_NAME
    || ""
  );
  const otherAgentNames = parseMentionNames(
    env.BLUN_TELEGRAM_OTHER_AGENT_NAMES
    || env.BLUN_CODEX_OTHER_AGENTS
    || ""
  );
  return {
    paths,
    agentName: env.BLUN_TELEGRAM_AGENT_NAME?.trim() || env.TELEGRAM_AGENT_NAME?.trim() || "default",
    lane: env.BLUN_CODEX_LANE?.trim() || "",
    botToken: env.BLUN_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim() || "",
    allowedChatId: allowedChatIds[0] || "",
    allowedChatIds,
    mentionNames,
    otherAgentNames,
    codexBin: env.BLUN_TELEGRAM_CODEX_BIN?.trim() || "codex",
    appServerWsUrl: env.BLUN_TELEGRAM_APP_SERVER_WS_URL?.trim() || "",
    currentThreadId: env.BLUN_TELEGRAM_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim() || "",
    resumeTimeoutMs: Number.parseInt(env.BLUN_TELEGRAM_RESUME_TIMEOUT_MS || "15000", 10) || 15000,
    idleCooldownMs: Number.parseInt(env.BLUN_TELEGRAM_IDLE_COOLDOWN_MS || "3000", 10) || 3000,
    ambientQueueTtlMs: Number.parseInt(env.BLUN_TELEGRAM_AMBIENT_QUEUE_TTL_MS || "600000", 10) || 600000,
    pendingReplyTimeoutMs: Number.parseInt(env.BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS || "1800000", 10) || 1800000,
    progressFallbackMs: Number.parseInt(env.BLUN_TELEGRAM_PROGRESS_FALLBACK_MS || "20000", 10) || 20000,
    progressRelayMode: env.BLUN_TELEGRAM_PROGRESS_RELAY?.trim().toLowerCase() || "status",
    queueNoticeEnabled: /^(1|true|yes|on)$/i.test(env.BLUN_TELEGRAM_QUEUE_NOTICE || ""),
    dispatchMode: env.BLUN_TELEGRAM_DISPATCH_MODE?.trim() || "deferred",
    pluginMode: env.BLUN_TELEGRAM_PLUGIN_MODE?.trim() || "inherit",
    model: env.BLUN_CODEX_MODEL?.trim() || "",
    reasoningEffort: env.BLUN_CODEX_REASONING_EFFORT?.trim() || "",
    personality: env.BLUN_CODEX_PERSONALITY?.trim() || ""
  };
}
