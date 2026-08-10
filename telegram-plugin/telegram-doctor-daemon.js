#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { loadConfig } from "./lib/env.js";
import { ensureStateLayout } from "./lib/paths.js";
import { doctorStateTransition, runTelegramDoctor } from "./lib/doctor.js";
import { writeSidecarOwnership } from "./lib/sidecars.js";
import { currentProcessInstanceId } from "./lib/state-lock.js";
import { appendLog, loadJson, nowIso, saveJson } from "./lib/storage.js";

ensureStateLayout();
let stopping = false;
let running = false;

async function cycle() {
  if (stopping || running) return;
  running = true;
  try {
    const config = loadConfig();
    const previous = loadJson(config.paths.doctorStateFile, null);
    const report = await runTelegramDoctor(config, {
      repair: config.doctorAutoRepair !== false,
      rpcTimeoutMs: config.doctorRpcTimeoutMs
    });
    const previousSignature = String(previous?.signature || "");
    const transition = doctorStateTransition(previousSignature, report.signature);
    if (transition?.type === "recovered") {
      appendLog(config.paths.activityFile, `TELEGRAM_DOCTOR_RECOVERED previous=${transition.previous}`);
    } else if (transition?.type === "alert") {
      appendLog(config.paths.activityFile, `TELEGRAM_DOCTOR_ALERT signature=${transition.next}`);
    } else if (transition?.type === "changed") {
      appendLog(config.paths.activityFile, `TELEGRAM_DOCTOR_ALERT_CHANGED previous=${transition.previous} signature=${transition.next}`);
    }
    saveJson(config.paths.doctorStateFile, {
      version: 1,
      signature: report.signature,
      ok: report.ok,
      checkedAt: nowIso(),
      issues: report.issues,
      actions: report.actions
    });
  } catch (error) {
    const config = loadConfig();
    appendLog(config.paths.activityFile, `TELEGRAM_DOCTOR_ERROR ${String(error?.message || error).replace(/\s+/g, " ").slice(0, 500)}`);
  } finally {
    running = false;
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  const config = loadConfig();
  appendLog(config.paths.activityFile, `TELEGRAM_DOCTOR_STOP signal=${signal}`);
  try {
    if (existsSync(config.paths.doctorPidFile)) {
      const pid = Number.parseInt(readFileSync(config.paths.doctorPidFile, "utf8").trim(), 10);
      if (pid === process.pid) {
        unlinkSync(config.paths.doctorPidFile);
        try { unlinkSync(`${config.paths.doctorPidFile}.meta.json`); } catch {}
      }
    }
  } catch {}
}

process.on("SIGINT", () => void shutdown("SIGINT").finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown("SIGTERM").finally(() => process.exit(0)));

const initialConfig = loadConfig();
writeSidecarOwnership(initialConfig.paths.doctorPidFile, {
  pid: process.pid,
  scriptName: "telegram-doctor-daemon.js",
  agentName: initialConfig.agentName || "default",
  stateDir: initialConfig.paths.root,
  instanceId: currentProcessInstanceId(),
  startedAt: nowIso(),
  writtenBy: "telegram-doctor-daemon"
});
appendLog(initialConfig.paths.activityFile, `TELEGRAM_DOCTOR_START pid=${process.pid} interval_ms=${initialConfig.doctorIntervalMs}`);
await cycle();
const timer = setInterval(() => void cycle(), initialConfig.doctorIntervalMs);
await new Promise(() => {});
