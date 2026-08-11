import { readFileSync } from "node:fs";
import { inspectStateLock, quarantineStaleStateLock } from "./state-lock.js";
import { callRuntimeRpc, loadRuntimeEndpoint } from "./runtime-rpc.js";
import { ensureDoctorWatchdog, ensureRuntimeDaemon, writeSidecarOwnership } from "./sidecars.js";
import { loadJson, nowIso } from "./storage.js";

function readPid(path) {
  try {
    return Number.parseInt(readFileSync(path, "utf8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function readJson(path) {
  return loadJson(path, null);
}

function pidIsAlive(pid) {
  const value = Number.parseInt(String(pid || "0"), 10) || 0;
  if (!value) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function ageMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? Math.max(0, Date.now() - parsed) : null;
}

function compactError(error) {
  return String(error?.message || error || "unknown error").replace(/\s+/g, " ").trim().slice(0, 500);
}

function issue(code, severity, detail, repairable = false) {
  return { code, severity, detail, repairable };
}

function queueSnapshot(config) {
  const state = readJson(config.paths.stateFile) || {};
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const pendingReplies = Array.isArray(state.pendingReplies) ? state.pendingReplies : [];
  const terminalPendingStatuses = new Set([
    "sent",
    "suppressed_ack",
    "suppressed_private_reply",
    "error",
    "ignored_bot",
    "superseded",
    "timeout",
    "stale_thread",
    "aborted",
    "no_reply_completed",
    "orphaned"
  ]);
  const terminalQueueStatuses = new Set([
    "replied",
    "cancelled",
    "error",
    "failed",
    "reply_timeout",
    "ignored_bot",
    "suppressed_ack",
    "stale_thread"
  ]);
  const timeoutMs = Math.max(0, Number(config.pendingReplyTimeoutMs || 1800000));
  const pending = pendingReplies.map((entry) => {
    const status = String(entry?.status || "pending").trim().toLowerCase();
    const hasResponse = Array.isArray(entry?.responseMessageIds) && entry.responseMessageIds.some(Boolean);
    const legacyExpired = status === "expired" && !hasResponse;
    const open = (legacyExpired || !terminalPendingStatuses.has(status))
      && (legacyExpired || !entry?.sentAt)
      && !hasResponse;
    const activityAt = entry?.lastSignalAt || entry?.progressSentAt || entry?.createdAt || "";
    const pendingAgeMs = ageMs(activityAt);
    const queueItemId = String(entry?.queueItemId || "").trim();
    const queueEntry = queue.find((candidate) => {
      if (queueItemId && String(candidate?.id || "").trim() === queueItemId) return true;
      return String(candidate?.chatId || "") === String(entry?.chatId || "")
        && String(candidate?.messageId || "") === String(entry?.messageId || "");
    });
    const queueStatus = String(queueEntry?.status || "").trim().toLowerCase();
    const retryAfterMs = Date.parse(String(entry?.replyRetryAfterAt || ""));
    const timeoutRetryDue = status === "timeout_retry"
      && (!Number.isFinite(retryAfterMs) || retryAfterMs <= Date.now());
    return {
      status,
      open,
      ageMs: pendingAgeMs,
      stalled: legacyExpired
        || timeoutRetryDue
        || (open && timeoutMs > 0 && pendingAgeMs !== null && pendingAgeMs >= timeoutMs),
      orphaned: open && (!queueEntry || terminalQueueStatuses.has(queueStatus)),
      expiredUnreconciled: legacyExpired
    };
  });
  return {
    depth: queue.filter((entry) => String(entry.status || "") === "queued").length,
    injecting: queue.filter((entry) => String(entry.status || "") === "injecting").length,
    submitted: queue.filter((entry) => ["submitted", "running"].includes(String(entry.status || ""))).length,
    lastPollAt: state.lastPollAt || null,
    lastInjectAt: state.lastInjectAt || null,
    lastInboundAt: state.lastInbound?.ts || state.lastInbound?.createdAt || null,
    pendingReplyOpen: pending.filter((entry) => entry.open).length,
    pendingReplyExpired: pending.filter((entry) => entry.status === "expired").length,
    pendingReplyStalled: pending.filter((entry) => entry.stalled).length,
    pendingReplyOrphaned: pending.filter((entry) => entry.orphaned).length,
    pendingReplyExpiredUnreconciled: pending.filter((entry) => entry.expiredUnreconciled).length,
    oldestPendingReplyAgeMs: pending
      .filter((entry) => entry.open && entry.ageMs !== null)
      .reduce((oldest, entry) => Math.max(oldest, entry.ageMs), 0)
  };
}

export async function inspectTelegramDoctor(config, options = {}) {
  const lock = inspectStateLock(config.paths.stateFile);
  const pid = readPid(config.paths.runtimePidFile);
  const pidMeta = readJson(`${config.paths.runtimePidFile}.meta.json`);
  const endpoint = loadRuntimeEndpoint(config);
  const pidAlive = pidIsAlive(pid);
  const doctorPid = readPid(config.paths.doctorPidFile);
  const doctorAlive = pidIsAlive(doctorPid);
  const doctorMeta = readJson(`${config.paths.doctorPidFile}.meta.json`);
  const doctorState = readJson(config.paths.doctorStateFile);
  const queue = queueSnapshot(config);
  const issues = [];

  let runtimeHealth = null;
  let runtimeError = null;
  try {
    runtimeHealth = await callRuntimeRpc(config, "runtime_health", {}, {
      timeoutMs: Number(options.rpcTimeoutMs || config.doctorRpcTimeoutMs || 1500)
    });
  } catch (error) {
    runtimeError = compactError(error);
  }

  const healthPid = Number(runtimeHealth?.pid || 0);
  const endpointPid = Number(endpoint?.pid || 0);
  const healthInstanceId = String(runtimeHealth?.instanceId || endpoint?.instanceId || "").trim();
  const pidMetaMatches = Boolean(
    pid > 0
    && Number(pidMeta?.pid || 0) === pid
    && String(pidMeta?.scriptName || "") === "runtime-daemon.js"
    && String(pidMeta?.agentName || "") === String(config.agentName || "")
    && String(pidMeta?.stateDir || "") === String(config.paths.root || "")
    && (!healthInstanceId || String(pidMeta?.instanceId || "") === healthInstanceId)
  );
  const runtimeIdentityConsistent = Boolean(
    runtimeHealth
    && healthPid > 0
    && endpointPid === healthPid
    && pid === healthPid
    && pidMetaMatches
  );
  const runtimeStarting = pidAlive
    && !runtimeHealth
    && ageMs(pidMeta?.startedAt) !== null
    && ageMs(pidMeta?.startedAt) < 10000;
  const doctorMetaMatches = Boolean(
    doctorPid > 0
    && Number(doctorMeta?.pid || 0) === doctorPid
    && String(doctorMeta?.scriptName || "") === "telegram-doctor-daemon.js"
    && String(doctorMeta?.agentName || "") === String(config.agentName || "")
    && String(doctorMeta?.stateDir || "") === String(config.paths.root || "")
  );
  const doctorHeartbeatAgeMs = ageMs(doctorState?.checkedAt);
  const doctorStartedAgeMs = ageMs(doctorMeta?.startedAt);
  const doctorHeartbeatThresholdMs = Math.max(15000, Number(config.doctorIntervalMs || 5000) * 3);
  const doctorHeartbeatStalled = doctorAlive
    && doctorPid !== process.pid
    && doctorStartedAgeMs !== null
    && doctorStartedAgeMs > doctorHeartbeatThresholdMs
    && (doctorHeartbeatAgeMs === null || doctorHeartbeatAgeMs > doctorHeartbeatThresholdMs);

  if (lock.locked && lock.recoverable) {
    issues.push(issue(
      "stale_state_lock",
      "critical",
      `${lock.reason}; owner_pid=${lock.pid || 0}; age_ms=${Math.round(lock.ageMs || 0)}`,
      true
    ));
  } else if (lock.locked) {
    issues.push(issue(
      "active_state_lock",
      "info",
      `${lock.reason}; owner_pid=${lock.pid || 0}; age_ms=${Math.round(lock.ageMs || 0)}`,
      false
    ));
  }

  if (!runtimeHealth && runtimeStarting) {
    issues.push(issue("runtime_starting", "info", `pid=${pid}; rpc_not_ready`, false));
  } else if (!runtimeHealth) {
    issues.push(issue("runtime_rpc_unreachable", "critical", runtimeError || "runtime_health failed", !pidAlive));
  }
  if (!pidAlive) {
    issues.push(issue("runtime_daemon_down", "critical", `pid=${pid || 0}`, true));
  }
  if (runtimeHealth && !runtimeIdentityConsistent) {
    issues.push(issue(
      "runtime_pid_record_mismatch",
      "critical",
      `pid_file=${pid || 0}; endpoint_pid=${endpointPid || 0}; health_pid=${healthPid || 0}`,
      true
    ));
  }

  if (config.doctorWatchEnabled !== false && !doctorAlive) {
    issues.push(issue("telegram_doctor_watch_down", "critical", `pid=${doctorPid || 0}`, true));
  } else if (config.doctorWatchEnabled !== false && !doctorMetaMatches) {
    issues.push(issue("telegram_doctor_pid_record_mismatch", "critical", `pid=${doctorPid || 0}`, false));
  } else if (config.doctorWatchEnabled !== false && doctorHeartbeatStalled) {
    issues.push(issue(
      "telegram_doctor_heartbeat_stalled",
      "critical",
      `pid=${doctorPid}; heartbeat_age_ms=${doctorHeartbeatAgeMs === null ? "unknown" : Math.round(doctorHeartbeatAgeMs)}`,
      true
    ));
  }

  const tickAgeMs = ageMs(runtimeHealth?.lastTickAt);
  if (runtimeHealth && tickAgeMs !== null && tickAgeMs > Math.max(15000, Number(config.doctorQueueStallMs || 60000))) {
    issues.push(issue("runtime_tick_stalled", "critical", `last_tick_age_ms=${Math.round(tickAgeMs)}`, false));
  }

  const events = runtimeHealth?.appServerEvents || null;
  const boundThreadId = String(events?.threadId || config.currentThreadId || "").trim();
  if (config.appServerWsUrl && boundThreadId && runtimeHealth && events?.connected !== true) {
    issues.push(issue("app_server_event_stream_down", "critical", `thread=${boundThreadId}; reason=${events?.reason || "disconnected"}`, false));
  }
  const blockedReason = String(events?.reason || "");
  const statusAgeMs = ageMs(events?.statusUpdatedAt);
  const staleGateAge = statusAgeMs === null || statusAgeMs > Number(config.doctorQueueStallMs || 60000);
  const completionMissingWhileIdle = blockedReason === "turn_completion_pending"
    && String(events?.threadStatus || "") === "idle";
  const activeTurnStalled = ["active_turn", "turn_completion_pending"].includes(blockedReason)
    && String(events?.threadStatus || "") === "active"
    && staleGateAge;
  if (activeTurnStalled) {
    issues.push(issue(
      "active_turn_stalled",
      "critical",
      `turn=${events?.activeTurnId || "unknown"}; status_age_ms=${statusAgeMs === null ? "unknown" : Math.round(statusAgeMs)}`,
      true
    ));
  }
  const stalledGate = (
    ["event_stream_unavailable", "status_unknown"].includes(blockedReason)
    || completionMissingWhileIdle
  ) && staleGateAge;
  if (queue.depth > 0 && stalledGate) {
    issues.push(issue(
      "queue_dispatch_gate_stalled",
      "critical",
      `queued=${queue.depth}; reason=${blockedReason}; status_age_ms=${statusAgeMs === null ? "unknown" : Math.round(statusAgeMs)}`,
      false
    ));
  }
  const stalePendingReplyCount = queue.pendingReplyStalled
    + queue.pendingReplyOrphaned
    + queue.pendingReplyExpiredUnreconciled;
  if (stalePendingReplyCount > 0) {
    issues.push(issue(
      "pending_reply_stalled",
      "critical",
      `open=${queue.pendingReplyOpen}; stalled=${queue.pendingReplyStalled}; orphaned=${queue.pendingReplyOrphaned}; expired_unreconciled=${queue.pendingReplyExpiredUnreconciled}; oldest_age_ms=${Math.round(queue.oldestPendingReplyAgeMs || 0)}`,
      true
    ));
  }

  const actionableIssues = issues.filter((entry) => entry.severity !== "info");
  const signature = actionableIssues.map((entry) => entry.code).sort().join(",") || "healthy";
  return {
    ok: actionableIssues.length === 0,
    checkedAt: nowIso(),
    profile: config.agentName,
    stateDir: config.paths.root,
    signature,
    issues,
    stateLock: {
      locked: lock.locked,
      recoverable: lock.recoverable,
      reason: lock.reason,
      ownerPid: lock.pid || 0,
      ownerAlive: Boolean(lock.ownerAlive),
      ageMs: Math.round(lock.ageMs || 0),
      leaseUntil: lock.leaseUntil || null
    },
    runtime: {
      pidFile: pid,
      pidAlive,
      pidMetaMatches,
      endpointPid,
      healthPid,
      identityConsistent: runtimeIdentityConsistent,
      rpcReachable: Boolean(runtimeHealth),
      rpcError: runtimeError,
      health: runtimeHealth
    },
    doctorWatch: {
      enabled: config.doctorWatchEnabled !== false,
      pid: doctorPid,
      alive: doctorAlive || doctorPid === process.pid,
      pidMetaMatches: doctorMetaMatches,
      heartbeatAgeMs: doctorHeartbeatAgeMs === null ? null : Math.round(doctorHeartbeatAgeMs),
      heartbeatStalled: doctorHeartbeatStalled
    },
    queue
  };
}

function repairRuntimeOwnership(config, report) {
  const pid = Number(report.runtime.healthPid || 0);
  if (!pid || !report.runtime.rpcReachable) {
    return null;
  }
  const instanceId = String(
    report.runtime.health?.instanceId
    || loadRuntimeEndpoint(config)?.instanceId
    || ""
  ).trim();
  writeSidecarOwnership(config.paths.runtimePidFile, {
    pid,
    scriptName: "runtime-daemon.js",
    agentName: config.agentName || "default",
    stateDir: config.paths.root,
    instanceId,
    startedAt: report.runtime.health?.startedAt || nowIso(),
    repairedAt: nowIso(),
    repairedBy: "telegram-doctor"
  });
  return `runtime_pid_record_repaired pid=${pid}`;
}

export async function runTelegramDoctor(config, options = {}) {
  const repair = options.repair === true;
  const before = await inspectTelegramDoctor(config, options);
  const actions = [];

  if (repair && before.stateLock.locked && before.stateLock.recoverable) {
    const recovered = quarantineStaleStateLock(config.paths.stateFile, {
      activityFile: config.paths.activityFile
    });
    if (recovered.recovered) {
      actions.push(`state_lock_quarantined reason=${recovered.reason} file=${recovered.quarantinePath}`);
    }
  }

  if (repair && before.runtime.rpcReachable && !before.runtime.identityConsistent) {
    const action = repairRuntimeOwnership(config, before);
    if (action) actions.push(action);
  }

  if (repair && !before.runtime.rpcReachable && !before.runtime.pidAlive) {
    const started = ensureRuntimeDaemon(config, { forceRestart: false });
    actions.push(`runtime_daemon_${started.reason} pid=${started.pid || 0}`);
  }

  if (repair && before.doctorWatch.enabled && (
    !before.doctorWatch.alive
    || before.doctorWatch.heartbeatStalled
  )) {
    const started = ensureDoctorWatchdog(config, { forceRestart: false });
    actions.push(`telegram_doctor_${started.reason} pid=${started.pid || 0}`);
  }

  const shouldReconcilePendingReplies = repair
    && before.runtime.rpcReachable
    && before.issues.some((entry) => entry.code === "pending_reply_stalled");
  if (shouldReconcilePendingReplies) {
    try {
      const result = await callRuntimeRpc(config, "runtime_pending_replies_reconcile", {}, {
        timeoutMs: Math.max(2000, Number(config.doctorRpcTimeoutMs || 1500) * 3)
      });
      actions.push(`pending_replies_reconciled retrying=${result?.retrying || 0} timeout=${result?.timedOut || 0} orphaned=${result?.orphaned || 0} superseded=${result?.superseded || 0} open=${result?.open || 0}`);
    } catch (error) {
      actions.push(`pending_replies_reconcile_failed error=${compactError(error)}`);
    }
  }

  const shouldReconcileEvents = repair
    && before.runtime.rpcReachable
    && before.issues.some((entry) => ["app_server_event_stream_down", "queue_dispatch_gate_stalled", "active_turn_stalled", "pending_reply_stalled"].includes(entry.code));
  if (shouldReconcileEvents) {
    try {
      const result = await callRuntimeRpc(config, "runtime_events_reconcile", {
        thread_id: before.runtime.health?.appServerEvents?.threadId || config.currentThreadId || ""
      }, { timeoutMs: Math.max(2000, Number(config.doctorRpcTimeoutMs || 1500) * 3) });
      actions.push(`app_server_events_reconciled ok=${result?.ok ? 1 : 0} reason=${result?.reason || "unknown"}`);
    } catch (error) {
      actions.push(`app_server_events_reconcile_failed error=${compactError(error)}`);
    }
  }

  const after = actions.length > 0
    ? await inspectTelegramDoctor(config, options)
    : before;
  return {
    ...after,
    repaired: actions.length > 0,
    actions,
    beforeSignature: before.signature
  };
}

export function doctorStateTransition(previousSignature, nextSignature) {
  const previous = String(previousSignature || "");
  const next = String(nextSignature || "healthy");
  if (previous === next) return null;
  if (next === "healthy") {
    return previous && previous !== "healthy"
      ? { type: "recovered", previous, next }
      : null;
  }
  return {
    type: previous && previous !== "healthy" ? "changed" : "alert",
    previous,
    next
  };
}
