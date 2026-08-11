import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { appendLog, nowIso } from "./storage.js";

const PROCESS_INSTANCE_ID = String(
  process.env.BLUN_CODEXLINK_PROCESS_INSTANCE_ID || randomUUID()
).trim();

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function compactReason(value) {
  return String(value || "unknown").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 80);
}

function processIsAlive(pid) {
  const value = Number.parseInt(String(pid || "0"), 10);
  if (!value || value <= 0) {
    return false;
  }
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockSnapshot(lockPath) {
  try {
    const stats = statSync(lockPath);
    const raw = readFileSync(lockPath, "utf8");
    let metadata = null;
    try {
      metadata = raw.trim() ? JSON.parse(raw) : null;
    } catch {
      metadata = null;
    }
    return {
      exists: true,
      lockPath,
      raw,
      metadata,
      mtimeMs: Number(stats.mtimeMs || 0),
      size: Number(stats.size || 0)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, lockPath };
    }
    throw error;
  }
}

function sameSnapshot(left, right) {
  return Boolean(left?.exists && right?.exists)
    && left.raw === right.raw
    && left.mtimeMs === right.mtimeMs
    && left.size === right.size;
}

export function stateLockPath(stateFile) {
  return `${stateFile}.lock`;
}

export function inspectStateLock(stateFile, options = {}) {
  const lockPath = stateLockPath(stateFile);
  const snapshot = readLockSnapshot(lockPath);
  if (!snapshot.exists) {
    return {
      locked: false,
      recoverable: false,
      reason: "unlocked",
      lockPath
    };
  }

  const now = Number(options.nowMs || Date.now());
  const invalidGraceMs = Math.max(250, Number(options.invalidGraceMs || 2000));
  const staleAfterMs = Math.max(invalidGraceMs, Number(options.staleAfterMs || 30000));
  const ageMs = Math.max(0, now - Number(snapshot.mtimeMs || now));
  const metadata = snapshot.metadata;
  const pid = Number.parseInt(String(metadata?.pid || "0"), 10) || 0;
  const ownerAlive = pid > 0 ? processIsAlive(pid) : false;
  const acquiredAtMs = Date.parse(String(metadata?.acquiredAt || ""));
  const leaseUntilMs = Date.parse(String(metadata?.leaseUntil || ""));
  const metadataValid = Boolean(
    metadata
    && Number(metadata.version) === 1
    && pid > 0
    && String(metadata.instanceId || "").trim()
    && String(metadata.lockId || "").trim()
  );

  let recoverable = false;
  let reason = "active_owner";
  if (!metadataValid) {
    recoverable = ageMs >= invalidGraceMs;
    reason = recoverable ? "invalid_or_empty_lock" : "lock_initializing";
  } else if (pid === process.pid && String(metadata.instanceId) !== PROCESS_INSTANCE_ID) {
    recoverable = true;
    reason = "same_pid_previous_instance";
  } else if (!ownerAlive) {
    recoverable = true;
    reason = "owner_process_dead";
  } else if (Number.isFinite(leaseUntilMs) && leaseUntilMs <= now) {
    recoverable = true;
    reason = "lease_expired";
  } else if (!Number.isFinite(leaseUntilMs) && ageMs >= staleAfterMs) {
    recoverable = true;
    reason = "legacy_lock_expired";
  } else if (Number.isFinite(acquiredAtMs) && acquiredAtMs > now + staleAfterMs && ageMs >= invalidGraceMs) {
    recoverable = true;
    reason = "invalid_future_timestamp";
  }

  return {
    locked: true,
    recoverable,
    reason,
    lockPath,
    ageMs,
    pid,
    ownerAlive,
    instanceId: String(metadata?.instanceId || ""),
    lockId: String(metadata?.lockId || ""),
    acquiredAt: metadata?.acquiredAt || null,
    leaseUntil: metadata?.leaseUntil || null,
    metadataValid,
    snapshot
  };
}

export function quarantineStaleStateLock(stateFile, options = {}) {
  const inspected = inspectStateLock(stateFile, options);
  if (!inspected.locked || !inspected.recoverable) {
    return {
      recovered: false,
      reason: inspected.reason,
      status: inspected
    };
  }

  const current = readLockSnapshot(inspected.lockPath);
  if (!sameSnapshot(inspected.snapshot, current)) {
    return {
      recovered: false,
      reason: "lock_changed_during_recovery",
      status: inspectStateLock(stateFile, options)
    };
  }

  const stamp = nowIso().replace(/[:.]/g, "-");
  const quarantinePath = `${inspected.lockPath}.stale-${stamp}-${compactReason(inspected.reason)}-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(inspected.lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { recovered: false, reason: "already_released", status: inspectStateLock(stateFile, options) };
    }
    throw error;
  }

  if (options.activityFile) {
    appendLog(
      options.activityFile,
      `STATE_LOCK_QUARANTINED reason=${inspected.reason} owner_pid=${inspected.pid || 0} owner_alive=${inspected.ownerAlive ? 1 : 0} age_ms=${Math.round(inspected.ageMs || 0)} file=${quarantinePath}`
    );
  }
  return {
    recovered: true,
    reason: inspected.reason,
    quarantinePath,
    status: inspected
  };
}

export function withStateFileLock(config, callback, options = {}) {
  const stateFile = config.paths.stateFile;
  const lockPath = stateLockPath(stateFile);
  const timeoutMs = Math.max(250, Number(options.timeoutMs || 15000));
  const staleAfterMs = Math.max(timeoutMs, Number(options.staleAfterMs || 30000));
  const deadline = Date.now() + timeoutMs;
  const lockId = randomUUID();
  let descriptor = null;

  while (descriptor === null) {
    let createdLock = false;
    try {
      descriptor = openSync(lockPath, "wx", 0o600);
      createdLock = true;
      const acquiredAtMs = Date.now();
      const metadata = {
        version: 1,
        pid: process.pid,
        instanceId: PROCESS_INSTANCE_ID,
        lockId,
        acquiredAt: new Date(acquiredAtMs).toISOString(),
        leaseUntil: new Date(acquiredAtMs + staleAfterMs).toISOString(),
        stateFile
      };
      writeFileSync(descriptor, `${JSON.stringify(metadata)}\n`, "utf8");
      fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch {}
        descriptor = null;
      }
      if (createdLock) {
        try { unlinkSync(lockPath); } catch {}
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const recovery = quarantineStaleStateLock(stateFile, {
        activityFile: config.paths.activityFile,
        staleAfterMs,
        invalidGraceMs: options.invalidGraceMs
      });
      if (recovery.recovered) {
        continue;
      }
      if (Date.now() >= deadline) {
        const status = inspectStateLock(stateFile, { staleAfterMs });
        const timeout = new Error(`Timed out waiting for Telegram state lock: ${lockPath}`);
        timeout.code = "STATE_LOCK_TIMEOUT";
        timeout.lockStatus = status;
        throw timeout;
      }
      sleepSync(Math.min(100, Math.max(10, Number(options.retryMs || 25))));
    }
  }

  try {
    return callback();
  } finally {
    try { closeSync(descriptor); } catch {}
    try {
      const current = readLockSnapshot(lockPath);
      if (current.metadata?.lockId === lockId && current.metadata?.instanceId === PROCESS_INSTANCE_ID) {
        unlinkSync(lockPath);
      } else if (existsSync(lockPath) && config.paths.activityFile) {
        appendLog(config.paths.activityFile, `STATE_LOCK_RELEASE_SKIPPED reason=ownership_changed lock=${lockPath}`);
      }
    } catch {
      // A recovered or concurrently released lock is already gone.
    }
  }
}

export function currentProcessInstanceId() {
  return PROCESS_INSTANCE_ID;
}
