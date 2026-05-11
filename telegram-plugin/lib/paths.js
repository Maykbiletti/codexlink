import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getStateDir() {
  return process.env.BLUN_TELEGRAM_STATE_DIR?.trim() || join(homedir(), ".codex", "channels", "codexlink-telegram");
}

export function getPaths() {
  const root = getStateDir();
  const codexHome = join(homedir(), ".codex");
  const agentName = process.env.BLUN_TELEGRAM_AGENT_NAME?.trim()
    || process.env.TELEGRAM_AGENT_NAME?.trim()
    || "default";
  const runtimeDir = join(codexHome, "runtimes", agentName);
  return {
    root,
    legacyRoot: join(codexHome, "channels", "codexlink-telegram"),
    codexHome,
    runtimeDir,
    currentRuntimeFile: join(runtimeDir, "current-remote-runtime.json"),
    sessionsDir: join(codexHome, "sessions"),
    envFile: join(root, ".env"),
    stateFile: join(root, "state.json"),
    inboxFile: join(root, "inbox.jsonl"),
    outboxFile: join(root, "outbox.jsonl"),
    activityFile: join(root, "activity.log"),
    pollerPidFile: join(root, "poller.pid"),
    dispatcherPidFile: join(root, "dispatcher.pid"),
    responderPidFile: join(root, "responder.pid"),
    pollerStdoutFile: join(root, "poller.stdout.log"),
    pollerStderrFile: join(root, "poller.stderr.log"),
    dispatcherStdoutFile: join(root, "dispatcher.stdout.log"),
    dispatcherStderrFile: join(root, "dispatcher.stderr.log"),
    responderStdoutFile: join(root, "responder.stdout.log"),
    responderStderrFile: join(root, "responder.stderr.log"),
    historyFile: join(codexHome, "history.jsonl"),
    promptsDir: join(root, "prompts"),
    responsesDir: join(root, "responses")
  };
}

export function ensureStateLayout() {
  const paths = getPaths();
  for (const dir of [paths.root, paths.promptsDir, paths.responsesDir, paths.runtimeDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  return paths;
}
