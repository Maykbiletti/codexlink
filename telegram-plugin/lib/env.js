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
  return {
    paths,
    agentName: env.BLUN_TELEGRAM_AGENT_NAME?.trim() || env.TELEGRAM_AGENT_NAME?.trim() || "default",
    lane: env.BLUN_CODEX_LANE?.trim() || "",
    botToken: env.BLUN_TELEGRAM_BOT_TOKEN?.trim() || env.TELEGRAM_BOT_TOKEN?.trim() || "",
    allowedChatId: allowedChatIds[0] || "",
    allowedChatIds,
    codexBin: env.BLUN_TELEGRAM_CODEX_BIN?.trim() || "codex",
    appServerWsUrl: env.BLUN_TELEGRAM_APP_SERVER_WS_URL?.trim() || "",
    currentThreadId: env.BLUN_TELEGRAM_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim() || "",
    resumeTimeoutMs: Number.parseInt(env.BLUN_TELEGRAM_RESUME_TIMEOUT_MS || "15000", 10) || 15000,
    pluginMode: env.BLUN_TELEGRAM_PLUGIN_MODE?.trim() || "inherit",
    model: env.BLUN_CODEX_MODEL?.trim() || "",
    reasoningEffort: env.BLUN_CODEX_REASONING_EFFORT?.trim() || "",
    personality: env.BLUN_CODEX_PERSONALITY?.trim() || ""
  };
}
