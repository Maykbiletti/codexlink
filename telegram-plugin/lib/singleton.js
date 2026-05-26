import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPaths } from "./paths.js";

function readPid(path) {
  try {
    return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function writePid(path) {
  try {
    writeFileSync(path, `${process.pid}\n`, "utf8");
  } catch {
    // Best-effort self-heal only; the sidecar can still keep running.
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort lock metadata only; Telegram itself remains authoritative.
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

export function isCurrentTokenPoller(config = {}) {
  const token = String(config.botToken || "").trim();
  if (!token) {
    return true;
  }

  const paths = config.paths || getPaths();
  const locksDir = join(paths.codexHome, "channels", "telegram-poller-locks");
  mkdirSync(locksDir, { recursive: true });

  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 16);
  const lockPath = join(locksDir, `${tokenHash}.poller.json`);
  const current = readJson(lockPath);
  const currentPid = Number.parseInt(String(current?.pid || "0"), 10) || 0;

  if (currentPid === process.pid) {
    writeJson(lockPath, {
      ...current,
      pid: process.pid,
      agentName: config.agentName || "",
      stateDir: paths.root || "",
      updatedAt: new Date().toISOString()
    });
    return true;
  }

  if (isPidAlive(currentPid)) {
    return false;
  }

  writeJson(lockPath, {
    pid: process.pid,
    agentName: config.agentName || "",
    stateDir: paths.root || "",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  return true;
}

export function isCurrentSidecarPid(kind) {
  const paths = getPaths();
  const pidFiles = {
    poller: paths.pollerPidFile,
    dispatcher: paths.dispatcherPidFile,
    responder: paths.responderPidFile,
    teamRelay: paths.teamRelayPidFile
  };
  const pidFile = pidFiles[kind];
  if (!pidFile) {
    return true;
  }

  const currentPid = readPid(pidFile);
  if (!currentPid) {
    writePid(pidFile);
    return true;
  }

  if (currentPid === process.pid) {
    return true;
  }

  // The parent writes the pid file just after spawn. Give a fresh child a
  // short grace window so it does not exit before its pid has been recorded.
  if (process.uptime() < 2) {
    return true;
  }

  if (!isPidAlive(currentPid)) {
    writePid(pidFile);
    return true;
  }

  return false;
}
