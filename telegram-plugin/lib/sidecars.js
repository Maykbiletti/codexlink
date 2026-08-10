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

function readPidMeta(pidFile) {
  try {
    return JSON.parse(readFileSync(`${pidFile}.meta.json`, "utf8"));
  } catch {
    return null;
  }
}

function writePidMeta(pidFile, meta) {
  try {
    writeFileSync(`${pidFile}.meta.json`, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch {
    // Metadata is a safety aid; sidecar ownership still falls back to pid.
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

function readProcessCommandLine(pid) {
  if (!pid || pid <= 0 || process.platform !== "win32") {
    return "";
  }
  try {
    return String(execFileSync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`
    ], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"]
    })).trim();
  } catch {
    return "";
  }
}

function isOwnedSidecar(pid, scriptName, pidFile, config) {
  const meta = readPidMeta(pidFile);
  if (!meta) {
    return false;
  }
  if (Number(meta.pid || 0) !== Number(pid)) {
    return false;
  }
  if (String(meta.scriptName || "") !== String(scriptName || "")) {
    return false;
  }
  if (String(meta.agentName || "") !== String(config.agentName || "")) {
    return false;
  }
  if (String(meta.stateDir || "") !== String(config.paths.root || "")) {
    return false;
  }

  const commandLine = readProcessCommandLine(pid).toLowerCase();
  if (commandLine && !commandLine.includes(String(scriptName || "").toLowerCase())) {
    return false;
  }
  return true;
}

function stopOwnedSidecar(pid, scriptName, pidFile, config) {
  if (!isPidAlive(pid)) {
    return { stopped: true, reason: "not_running" };
  }
  if (!isOwnedSidecar(pid, scriptName, pidFile, config)) {
    return { stopped: false, reason: "ownership_unverified" };
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { stopped: false, reason: "sigterm_failed" };
  }
  return { stopped: true, reason: "sigterm_sent" };
}

function ensureSidecar(scriptName, pidFile, stdoutFile, stderrFile, config, options = {}) {
  const forceRestart = Boolean(options.forceRestart);
  const existingPid = readPid(pidFile);
  if (isPidAlive(existingPid)) {
    if (!isOwnedSidecar(existingPid, scriptName, pidFile, config)) {
      appendLog(config.paths.activityFile, `SIDECAR_REUSE_SKIPPED script=${scriptName} pid=${existingPid} reason=ownership_unverified`);
      return { started: false, pid: existingPid, reason: "ownership_unverified" };
    }
    if (!forceRestart) {
      return { started: false, pid: existingPid, reason: "already_running" };
    }
    const stopped = stopOwnedSidecar(existingPid, scriptName, pidFile, config);
    if (!stopped.stopped) {
      appendLog(config.paths.activityFile, `SIDECAR_RESTART_SKIPPED script=${scriptName} pid=${existingPid} reason=${stopped.reason}`);
      return { started: false, pid: existingPid, reason: `restart_skipped_${stopped.reason}` };
    }
  }

  const env = {
    ...process.env,
    BLUN_TELEGRAM_AGENT_NAME: config.agentName || "default",
    BLUN_TELEGRAM_STATE_DIR: config.paths.root,
    BLUN_TELEGRAM_BOT_TOKEN: config.botToken || "",
    BLUN_TELEGRAM_ALLOWED_UPDATES: config.allowedUpdates || "",
    BLUN_TELEGRAM_ALLOWED_CHAT_ID: Array.isArray(config.allowedChatIds) ? config.allowedChatIds.join(",") : (config.allowedChatId || ""),
    BLUN_TELEGRAM_MENTION_NAMES: Array.isArray(config.mentionNames) ? config.mentionNames.join(",") : "",
    BLUN_TELEGRAM_OTHER_AGENT_NAMES: Array.isArray(config.otherAgentNames) ? config.otherAgentNames.join(",") : "",
    BLUN_TELEGRAM_APP_SERVER_WS_URL: config.appServerWsUrl || "",
    BLUN_CODEX_DISPLAY_NAME: config.displayName || "",
    BLUN_CODEX_LANE: config.lane || "",
    BLUN_CODEX_AGENT_PROMPT: config.agentPrompt || "",
    BLUN_TELEGRAM_RESUME_TIMEOUT_MS: String(config.resumeTimeoutMs || 15000),
    BLUN_TELEGRAM_POLL_INTERVAL_MS: String(config.pollIntervalMs || 700),
    BLUN_TELEGRAM_INJECT_INTERVAL_MS: String(config.injectIntervalMs || 700),
    BLUN_CODEXLINK_RUNTIME_PORT: String(config.runtimePort || 0),
    BLUN_CODEXLINK_RUNTIME_RPC_TIMEOUT_MS: String(config.runtimeRpcTimeoutMs || 65000),
    BLUN_CODEXLINK_OVERLOAD_BASE_MS: String(config.runtimeOverloadBaseMs || 500),
    BLUN_TELEGRAM_GETUPDATES_TIMEOUT: String(config.getUpdatesTimeout || 0),
    BLUN_TELEGRAM_ACTIVE_TURN_RETRY_MS: String(config.activeTurnRetryMs || 750),
    BLUN_TELEGRAM_IDLE_COOLDOWN_MS: String(config.idleCooldownMs || 15000),
    BLUN_TELEGRAM_PROGRESS_FALLBACK_MS: String(config.progressFallbackMs || 20000),
    BLUN_TELEGRAM_QUEUE_NOTICE: config.queueNoticeEnabled ? "1" : "0",
    BLUN_TELEGRAM_DISPATCH_MODE: config.dispatchMode || "deferred",
    BLUN_TELEGRAM_GROUP_DELIVERY: config.groupDeliveryMode || "observe",
    BLUN_TELEGRAM_PRIVATE_REPLY_MODE: config.privateReplyMode || "auto",
    BLUN_TELEGRAM_TEAM_RELAY_MODE: config.teamRelayMode || "off",
    BLUN_TELEGRAM_TEAM_RELAY_FILE: config.teamRelayFile || "",
    BLUN_TELEGRAM_TEAM_RELAY_URL: config.teamRelayUrl || "",
    BLUN_TELEGRAM_TEAM_RELAY_SECRET: config.teamRelaySecret || "",
    BLUN_TELEGRAM_TEAM_RELAY_PRIVATE: config.teamRelayPrivate || "0",
    BLUN_TELEGRAM_TEAM_RELAY_START: config.teamRelayStart || "tail",
    BLUN_TELEGRAM_TEAM_RELAY_TIMEOUT_MS: String(config.teamRelayTimeoutMs || 750),
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
  writePidMeta(pidFile, {
    pid: child.pid,
    scriptName,
    agentName: config.agentName || "default",
    stateDir: config.paths.root,
    startedAt: new Date().toISOString()
  });
  return { started: true, pid: child.pid, reason: "spawned" };
}

export function ensureBackgroundSidecars(config, options = {}) {
  if (config.pluginMode !== "plugin" && options.forceRuntime !== true) {
    return { ok: true, enabled: false, reason: "plugin_mode_not_enabled" };
  }
  if (!config.botToken) {
    appendLog(config.paths.activityFile, "RUNTIME_TELEGRAM_DISABLED missing_bot_token");
  }

  for (const legacy of [
    ["poller.js", config.paths.pollerPidFile],
    ["dispatcher.js", config.paths.dispatcherPidFile],
    ["responder.js", config.paths.responderPidFile],
    ["team-relay-consumer.js", config.paths.teamRelayPidFile]
  ]) {
    const pid = readPid(legacy[1]);
    if (pid > 0) {
      stopOwnedSidecar(pid, legacy[0], legacy[1], config);
    }
  }

  const runtime = ensureSidecar(
    "runtime-daemon.js",
    config.paths.runtimePidFile,
    config.paths.runtimeStdoutFile,
    config.paths.runtimeStderrFile,
    config,
    { forceRestart: config.sidecarForceRestart }
  );
  const disabled = { started: false, pid: 0, reason: "owned_by_runtime_daemon" };
  const poller = disabled;
  const dispatcher = disabled;
  const responder = disabled;
  const teamRelay = disabled;

  appendLog(
    config.paths.activityFile,
    `PLUGIN_AUTOSTART runtime=${runtime.pid || 0}:${runtime.reason} legacy_sidecars=disabled`
  );

  return {
    ok: true,
    enabled: true,
    runtime,
    poller,
    dispatcher,
    responder,
    teamRelay
  };
}
