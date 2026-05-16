import { readFileSync } from "node:fs";
import { join } from "node:path";
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

function parseGroupDeliveryMode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (["mention", "mentions", "addressed", "strict"].includes(value)) {
    return "mentions";
  }
  if (["observe", "observer", "listen", "context", "all-context", "all_context"].includes(value)) {
    return "observe";
  }
  if (["ambient", "queue", "park"].includes(value)) {
    return "ambient";
  }
  return "all";
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
  const defaultTeamRelayFile = join(paths.codexHome, "channels", "blun-team-relay.jsonl");
  const teamRelayUrl = env.BLUN_TELEGRAM_TEAM_RELAY_URL?.trim() || "";
  const teamRelayFile = env.BLUN_TELEGRAM_TEAM_RELAY_FILE?.trim() || (teamRelayUrl ? "" : defaultTeamRelayFile);
  const teamRelayMode = env.BLUN_TELEGRAM_TEAM_RELAY_MODE?.trim().toLowerCase() || "both";
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
    displayName: env.BLUN_CODEX_DISPLAY_NAME?.trim() || env.BLUN_TELEGRAM_AGENT_NAME?.trim() || env.TELEGRAM_AGENT_NAME?.trim() || "CodexLink",
    lane: env.BLUN_CODEX_LANE?.trim() || "",
    agentPrompt: env.BLUN_CODEX_AGENT_PROMPT?.trim() || "",
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
    attachmentMaxBytes: Number.parseInt(env.BLUN_TELEGRAM_ATTACHMENT_MAX_BYTES || "52428800", 10) || 52428800,
    progressFallbackMs: Number.parseInt(env.BLUN_TELEGRAM_PROGRESS_FALLBACK_MS || "20000", 10) || 20000,
    progressRelayMode: env.BLUN_TELEGRAM_PROGRESS_RELAY?.trim().toLowerCase() || "status",
    teamRelayMode,
    teamRelayFile,
    teamRelayUrl,
    teamRelaySecret: env.BLUN_TELEGRAM_TEAM_RELAY_SECRET?.trim() || "",
    teamRelayPrivate: env.BLUN_TELEGRAM_TEAM_RELAY_PRIVATE?.trim() || "0",
    teamRelayStart: env.BLUN_TELEGRAM_TEAM_RELAY_START?.trim().toLowerCase() || "tail",
    queueNoticeEnabled: /^(1|true|yes|on)$/i.test(env.BLUN_TELEGRAM_QUEUE_NOTICE || ""),
    dispatchMode: env.BLUN_TELEGRAM_DISPATCH_MODE?.trim() || "deferred",
    groupDeliveryMode: parseGroupDeliveryMode(
      env.BLUN_TELEGRAM_GROUP_DELIVERY
      || env.TELEGRAM_GROUP_DELIVERY
      || env.BLUN_TELEGRAM_RELEVANCE_MODE
      || "all"
    ),
    privateDmGroupGuard: !/^(0|false|no|off)$/i.test(String(env.BLUN_TELEGRAM_PRIVATE_DM_GROUP_GUARD || "1")),
    privateReplyMode: env.BLUN_TELEGRAM_PRIVATE_REPLY_MODE?.trim().toLowerCase() || "auto",
    pluginMode: env.BLUN_TELEGRAM_PLUGIN_MODE?.trim() || "inherit",
    model: env.BLUN_CODEX_MODEL?.trim() || "",
    reasoningEffort: env.BLUN_CODEX_REASONING_EFFORT?.trim() || "",
    personality: env.BLUN_CODEX_PERSONALITY?.trim() || ""
  };
}
