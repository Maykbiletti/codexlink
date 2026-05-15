import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { appendLog } from "./storage.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");

function readPid(path) {
  try {
    return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopPid(pid) {
  if (!isPidAlive(pid)) {
    return false;
  }
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may already be gone.
  }
  return true;
}

function ensureSidecar(scriptName, pidFile, stdoutFile, stderrFile, config, options = {}) {
  const forceRestart = Boolean(options.forceRestart);
  const existingPid = readPid(pidFile);
  if (isPidAlive(existingPid)) {
    if (!forceRestart) {
      return { started: false, pid: existingPid, reason: "already_running" };
    }
    stopPid(existingPid);
  }

  const env = {
    ...process.env,
    BLUN_TELEGRAM_AGENT_NAME: config.agentName || "default",
    BLUN_TELEGRAM_STATE_DIR: config.paths.root,
    BLUN_TELEGRAM_BOT_TOKEN: config.botToken || "",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: Array.isArray(config.allowedChatIds) ? config.allowedChatIds.join(",") : (config.allowedChatId || ""),
    BLUN_TELEGRAM_OTHER_AGENT_NAMES: Array.isArray(config.otherAgentNames) ? config.otherAgentNames.join(",") : "",
    BLUN_TELEGRAM_APP_SERVER_WS_URL: config.appServerWsUrl || "",
    BLUN_TELEGRAM_CODEX_BIN: config.codexBin || "codex",
    BLUN_CODEX_DISPLAY_NAME: config.displayName || "",
    BLUN_CODEX_LANE: config.lane || "",
    BLUN_CODEX_AGENT_PROMPT: config.agentPrompt || "",
    BLUN_TELEGRAM_RESUME_TIMEOUT_MS: String(config.resumeTimeoutMs || 15000),
    BLUN_TELEGRAM_IDLE_COOLDOWN_MS: String(config.idleCooldownMs || 15000),
    BLUN_TELEGRAM_PROGRESS_FALLBACK_MS: String(config.progressFallbackMs || 20000),
    BLUN_TELEGRAM_QUEUE_NOTICE: config.queueNoticeEnabled ? "1" : "0",
    BLUN_TELEGRAM_DISPATCH_MODE: config.dispatchMode || "deferred",
    BLUN_TELEGRAM_GROUP_DELIVERY: config.groupDeliveryMode || "all",
    BLUN_TELEGRAM_PLUGIN_MODE: config.pluginMode || "plugin",
    BLUN_CODEX_MODEL: config.model || "",
    BLUN_CODEX_REASONING_EFFORT: config.reasoningEffort || "",
    BLUN_CODEX_PERSONALITY: config.personality || ""
  };

  if (config.currentThreadId) {
    env.BLUN_TELEGRAM_THREAD_ID = config.currentThreadId;
  }

  const child = spawn(
    process.execPath,
    [join(pluginRoot, scriptName)],
    {
      cwd: pluginRoot,
      env,
      detached: true,
      windowsHide: true,
      stdio: [
        "ignore",
        openSync(stdoutFile, "a"),
        openSync(stderrFile, "a")
      ]
    }
  );
  child.unref();
  writeFileSync(pidFile, `${child.pid}\n`, "utf8");
  return { started: true, pid: child.pid, reason: "spawned" };
}

export function ensureBackgroundSidecars(config) {
  if (config.pluginMode !== "plugin") {
    return { ok: true, enabled: false, reason: "plugin_mode_not_enabled" };
  }
  if (!config.botToken) {
    appendLog(config.paths.activityFile, "PLUGIN_AUTOSTART_SKIPPED missing_bot_token");
    return { ok: false, enabled: false, reason: "missing_bot_token" };
  }

  const poller = ensureSidecar(
    "poller.js",
    config.paths.pollerPidFile,
    config.paths.pollerStdoutFile,
    config.paths.pollerStderrFile,
    config,
    { forceRestart: true }
  );
  const dispatcher = ensureSidecar(
    "dispatcher.js",
    config.paths.dispatcherPidFile,
    config.paths.dispatcherStdoutFile,
    config.paths.dispatcherStderrFile,
    config,
    { forceRestart: true }
  );
  const responder = ensureSidecar(
    "responder.js",
    config.paths.responderPidFile,
    config.paths.responderStdoutFile,
    config.paths.responderStderrFile,
    config,
    { forceRestart: true }
  );

  appendLog(
    config.paths.activityFile,
    `PLUGIN_AUTOSTART poller=${poller.pid || 0}:${poller.reason} dispatcher=${dispatcher.pid || 0}:${dispatcher.reason} responder=${responder.pid || 0}:${responder.reason}`
  );

  return {
    ok: true,
    enabled: true,
    poller,
    dispatcher,
    responder
  };
}
