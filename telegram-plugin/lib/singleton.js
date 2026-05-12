import { readFileSync } from "node:fs";
import { getPaths } from "./paths.js";

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

export function isCurrentSidecarPid(kind) {
  const paths = getPaths();
  const pidFiles = {
    poller: paths.pollerPidFile,
    dispatcher: paths.dispatcherPidFile,
    responder: paths.responderPidFile
  };
  const pidFile = pidFiles[kind];
  if (!pidFile) {
    return true;
  }

  const currentPid = readPid(pidFile);
  if (!currentPid || currentPid === process.pid) {
    return true;
  }

  // The parent writes the pid file just after spawn. Give a fresh child a
  // short grace window so it does not exit before its pid has been recorded.
  if (process.uptime() < 2) {
    return true;
  }

  return !isPidAlive(currentPid);
}
