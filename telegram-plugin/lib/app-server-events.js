import { AppServerClient } from "./app-server-client.js";
import { extractRuntimeQueueIdFromThreadItem } from "./codex.js";
import { appendJsonl, appendLog, nowIso } from "./storage.js";

const DECISION_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval"
]);

function compactError(error) {
  return String(error?.message || error || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function notificationThreadId(message) {
  return String(message?.params?.threadId || message?.params?.thread?.id || "").trim();
}

function notificationTurnId(message) {
  return String(message?.params?.turnId || message?.params?.turn?.id || "").trim();
}

function normalizeThreadStatus(value) {
  const raw = typeof value === "string" ? value : value?.type;
  const normalized = String(raw || "").trim().toLowerCase();
  if (normalized === "notloaded") {
    return "notLoaded";
  }
  if (normalized === "systemerror") {
    return "systemError";
  }
  return ["active", "idle"].includes(normalized) ? normalized : "unknown";
}

function activeTurnFromThread(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const active = [...turns].reverse().find((turn) => {
    return ["inprogress", "active", "running"].includes(String(turn?.status || "").trim().toLowerCase());
  });
  return String(active?.id || "").trim();
}

export class AppServerEventBridge {
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.client = null;
    this.threadId = "";
    this.finalAnswers = new Map();
    this.pendingApprovals = new Map();
    this.connected = false;
    this.connecting = null;
    this.threadStatus = "unknown";
    this.activeTurnId = "";
    this.ownedTurnId = "";
    this.awaitingTurnCompletion = false;
    this.dispatchInFlight = false;
    this.statusUpdatedAt = null;
  }

  async ensureConnected(threadId = "") {
    const requestedThreadId = String(threadId || this.threadId || "").trim();
    if (this.connected && this.client && (!requestedThreadId || requestedThreadId === this.threadId)) {
      return this.client;
    }
    if (this.connecting) {
      await this.connecting;
      if (!requestedThreadId || requestedThreadId === this.threadId) {
        return this.client;
      }
    }

    this.connecting = this._connect(requestedThreadId);
    try {
      await this.connecting;
      return this.client;
    } finally {
      this.connecting = null;
    }
  }

  async _connect(threadId) {
    const previousClient = this.client;
    this.client = null;
    this.connected = false;
    this.threadStatus = "unknown";
    this.activeTurnId = "";
    this.ownedTurnId = "";
    this.awaitingTurnCompletion = false;
    this.dispatchInFlight = false;
    if (previousClient) {
      await previousClient.close().catch(() => {});
    }
    const client = new AppServerClient(this.config.appServerWsUrl, {
      timeoutMs: this.config.resumeTimeoutMs || 20000,
      onNotification: (message) => this._handleNotification(message),
      onServerRequest: (message, respond) => this._handleServerRequest(message, respond),
      onClose: () => {
        if (this.client === client) {
          this.connected = false;
        }
      }
    });
    this.client = client;
    this.threadId = threadId;
    try {
      await client.connect();
      if (threadId) {
        await client.resumeThread(threadId, { timeoutMs: this.config.resumeTimeoutMs || 20000 });
        await this._recoverCompletedTurns(client, threadId);
      }
    } catch (error) {
      if (this.client === client) {
        this.client = null;
      }
      await client.close().catch(() => {});
      throw error;
    }
    this.connected = true;
    appendLog(this.config.paths.activityFile, `APP_EVENT_STREAM_CONNECTED thread=${threadId || "-"}`);
  }

  async _recoverCompletedTurns(client, threadId) {
    try {
      const response = await client.request("thread/read", {
        threadId,
        includeTurns: true
      }, { timeoutMs: this.config.resumeTimeoutMs || 20000 });
      const thread = response?.result?.thread || {};
      const turns = Array.isArray(thread.turns) ? thread.turns : [];
      this._setThreadStatus(thread.status, {
        threadId,
        turnId: activeTurnFromThread(thread),
        source: "thread/read"
      });
      if (!this.handlers.onTurnCompleted) {
        return;
      }
      for (const turn of turns.slice(-20)) {
        const status = String(turn?.status || "").trim().toLowerCase();
        if (!["completed", "interrupted", "failed"].includes(status)) {
          continue;
        }
        const items = Array.isArray(turn.items) ? turn.items : [];
        const userItem = items.find((item) => item?.type === "userMessage");
        const queueItemId = extractRuntimeQueueIdFromThreadItem(userItem);
        if (queueItemId && this.handlers.onUserMessageObserved) {
          await this.handlers.onUserMessageObserved({
            threadId,
            turnId: String(turn.id || "").trim(),
            queueItemId,
            observedAt: nowIso(),
            recovered: true
          });
        }
        const finalItem = [...items].reverse().find((item) => {
          return item?.type === "agentMessage" && String(item.phase || "final_answer") === "final_answer";
        });
        await this.handlers.onTurnCompleted({
          threadId,
          turnId: String(turn.id || "").trim(),
          status,
          finalText: String(finalItem?.text || "").trim(),
          error: turn.error || null,
          completedAt: nowIso(),
          recovered: true
        });
      }
    } catch (error) {
      appendLog(this.config.paths.activityFile, `APP_EVENT_RECOVERY_ERROR thread=${threadId} ${compactError(error)}`);
    }
  }

  async startTurn(options) {
    const threadId = String(options.threadId || "").trim();
    const client = await this.ensureConnected(threadId);
    const dispatchState = this.getDispatchState(threadId);
    if (!dispatchState.ready) {
      return {
        ok: false,
        busy: true,
        overloaded: false,
        waitingForIdle: true,
        reason: dispatchState.reason,
        activeTurnId: dispatchState.activeTurnId || ""
      };
    }
    this.dispatchInFlight = true;
    try {
      const result = await client.startTurn(options);
      const startedTurnId = String(result?.turnId || "").trim();
      this.threadStatus = "active";
      this.activeTurnId = startedTurnId || "active";
      this.ownedTurnId = startedTurnId || "pending-turn-id";
      this.awaitingTurnCompletion = true;
      this.statusUpdatedAt = nowIso();
      return result;
    } catch (error) {
      const details = compactError(error).toLowerCase();
      const busy = details.includes("active turn")
        || details.includes("already running")
        || details.includes("cannot accept")
        || details.includes("busy");
      if (busy) {
        this.threadStatus = "active";
        this.activeTurnId = this.activeTurnId || "active";
        this.awaitingTurnCompletion = true;
        this.statusUpdatedAt = nowIso();
      }
      return {
        ok: false,
        busy,
        overloaded: Number(error?.code) === -32001 || details.includes("server overloaded"),
        error
      };
    } finally {
      this.dispatchInFlight = false;
    }
  }

  async checkDispatchReady(threadId = "") {
    const requestedThreadId = String(threadId || this.threadId || "").trim();
    if (!requestedThreadId) {
      return {
        ready: false,
        reason: "thread_unbound",
        threadStatus: "unknown",
        activeTurnId: ""
      };
    }
    try {
      await this.ensureConnected(requestedThreadId);
    } catch (error) {
      return {
        ready: false,
        reason: "event_stream_unavailable",
        threadStatus: "unknown",
        activeTurnId: "",
        error: compactError(error)
      };
    }
    return this.getDispatchState(requestedThreadId);
  }

  getDispatchState(threadId = "") {
    const requestedThreadId = String(threadId || this.threadId || "").trim();
    const sameThread = Boolean(requestedThreadId && requestedThreadId === this.threadId);
    let reason = "ready";
    if (!this.connected || !sameThread) {
      reason = "event_stream_unavailable";
    } else if (this.dispatchInFlight) {
      reason = "dispatch_in_flight";
    } else if (this.ownedTurnId) {
      reason = "turn_completion_pending";
    } else if (this.threadStatus === "active") {
      reason = "active_turn";
    } else if (this.awaitingTurnCompletion) {
      reason = "turn_completion_pending";
    } else if (this.threadStatus !== "idle") {
      reason = "status_unknown";
    }
    return {
      ready: reason === "ready",
      reason,
      threadId: requestedThreadId || null,
      threadStatus: sameThread ? this.threadStatus : "unknown",
      activeTurnId: sameThread ? (this.activeTurnId || this.ownedTurnId || "") : "",
      ownedTurnId: sameThread ? this.ownedTurnId : "",
      awaitingTurnCompletion: sameThread ? this.awaitingTurnCompletion : false,
      dispatchInFlight: this.dispatchInFlight,
      statusUpdatedAt: this.statusUpdatedAt
    };
  }

  _setThreadStatus(status, options = {}) {
    const threadId = String(options.threadId || this.threadId || "").trim();
    if (!threadId || threadId !== this.threadId) {
      return;
    }
    const normalized = normalizeThreadStatus(status);
    this.threadStatus = normalized;
    this.statusUpdatedAt = nowIso();
    if (normalized === "active") {
      this.activeTurnId = String(options.turnId || this.activeTurnId || "active").trim();
      this.awaitingTurnCompletion = true;
    } else if (normalized === "idle") {
      this.activeTurnId = "";
      if (options.source === "thread/read") {
        this.awaitingTurnCompletion = false;
      }
    }
    appendLog(
      this.config.paths.activityFile,
      `APP_THREAD_STATUS thread=${threadId} status=${normalized} source=${options.source || "event"} active_turn=${this.activeTurnId || "-"}`
    );
  }

  async _handleNotification(message) {
    const method = String(message?.method || "");
    const threadId = notificationThreadId(message) || this.threadId;
    const turnId = notificationTurnId(message);
    appendJsonl(this.config.paths.runtimeEventsFile, {
      ts: nowIso(),
      method,
      threadId: threadId || null,
      turnId: turnId || null,
      params: message?.params || {}
    });

    if (method === "thread/status/changed") {
      this._setThreadStatus(message?.params?.status, {
        threadId,
        turnId,
        source: method
      });
    }

    if (method === "turn/started") {
      this._setThreadStatus("active", {
        threadId,
        turnId,
        source: method
      });
    }

    if (method === "item/started" || method === "item/completed") {
      const item = message?.params?.item || {};
      const queueItemId = extractRuntimeQueueIdFromThreadItem(item);
      if (queueItemId && turnId && this.handlers.onUserMessageObserved) {
        await this.handlers.onUserMessageObserved({
          threadId,
          turnId,
          queueItemId,
          observedAt: nowIso(),
          recovered: false
        });
      }
    }

    if (method === "item/completed") {
      const item = message?.params?.item || {};
      if (item.type === "agentMessage" && String(item.phase || "final_answer") === "final_answer" && turnId) {
        this.finalAnswers.set(turnId, String(item.text || "").trim());
      }
    }

    if (method === "serverRequest/resolved") {
      const requestId = String(message?.params?.requestId || "").trim();
      if (requestId) {
        this.pendingApprovals.delete(requestId);
      }
    }

    if (method === "turn/completed") {
      const turn = message?.params?.turn || {};
      const completedTurnId = String(turn.id || turnId || "").trim();
      const completedUserItem = Array.isArray(turn.items)
        ? turn.items.find((item) => item?.type === "userMessage")
        : null;
      const completedQueueItemId = extractRuntimeQueueIdFromThreadItem(completedUserItem);
      if (completedQueueItemId && completedTurnId && this.handlers.onUserMessageObserved) {
        await this.handlers.onUserMessageObserved({
          threadId,
          turnId: completedTurnId,
          queueItemId: completedQueueItemId,
          observedAt: nowIso(),
          recovered: false
        });
      }
      const trackedActiveTurnId = this.activeTurnId;
      if (completedTurnId && this.ownedTurnId === completedTurnId) {
        this.ownedTurnId = "";
      }
      if (completedTurnId && this.ownedTurnId === "pending-turn-id") {
        this.ownedTurnId = "";
      }
      if (completedTurnId && this.activeTurnId === completedTurnId) {
        this.activeTurnId = "";
      }
      if (!trackedActiveTurnId || trackedActiveTurnId === "active" || trackedActiveTurnId === completedTurnId) {
        this.awaitingTurnCompletion = false;
      }
      if (this.threadStatus !== "idle") {
        this.threadStatus = "unknown";
        this.statusUpdatedAt = nowIso();
      }
      const finalText = this.finalAnswers.get(completedTurnId) || "";
      this.finalAnswers.delete(completedTurnId);
      if (this.handlers.onTurnCompleted) {
        const completion = {
          threadId,
          turnId: completedTurnId,
          status: String(turn.status || "completed"),
          finalText,
          error: turn.error || null,
          completedAt: nowIso()
        };
        const result = await this.handlers.onTurnCompleted(completion);
        if (result?.matched === false) {
          this._retryUnmatchedCompletion(completion, 1);
        }
      }
    }
  }

  _retryUnmatchedCompletion(completion, attempt) {
    if (attempt > 8 || !this.handlers.onTurnCompleted) {
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const result = await this.handlers.onTurnCompleted(completion);
        if (result?.matched === false) {
          this._retryUnmatchedCompletion(completion, attempt + 1);
        }
      } catch (error) {
        appendLog(this.config.paths.activityFile, `APP_EVENT_COMPLETION_RETRY_ERROR turn=${completion.turnId || "-"} ${compactError(error)}`);
      }
    }, Math.min(2000, 100 * Math.pow(2, attempt - 1)));
    timer.unref?.();
  }

  async _handleServerRequest(message, respond) {
    const requestId = String(message?.id || "").trim();
    if (!requestId) {
      return;
    }
    const approval = {
      requestId,
      method: String(message.method || ""),
      threadId: notificationThreadId(message) || this.threadId,
      turnId: notificationTurnId(message),
      params: message.params || {},
      createdAt: nowIso(),
      respond
    };
    this.pendingApprovals.set(requestId, approval);
    if (this.handlers.onApproval) {
      await this.handlers.onApproval(this.serializeApproval(approval));
    }
  }

  serializeApproval(approval) {
    if (!approval) {
      return null;
    }
    const { respond, ...safe } = approval;
    return safe;
  }

  listApprovals() {
    return Array.from(this.pendingApprovals.values()).map((entry) => this.serializeApproval(entry));
  }

  async decideApproval(requestId, decision) {
    const key = String(requestId || "").trim();
    const approval = this.pendingApprovals.get(key);
    if (!approval) {
      throw new Error(`Unknown or resolved approval request: ${key}`);
    }
    const value = String(decision || "").trim();
    if (!DECISION_APPROVAL_METHODS.has(approval.method)) {
      throw new Error(`Request ${key} uses ${approval.method} and cannot be resolved with an approval decision.`);
    }
    const allowed = new Set(["accept", "acceptForSession", "decline", "cancel"]);
    if (!allowed.has(value)) {
      throw new Error("Decision must be accept, acceptForSession, decline, or cancel.");
    }
    const advertised = Array.isArray(approval.params?.availableDecisions)
      ? approval.params.availableDecisions.filter((entry) => typeof entry === "string")
      : [];
    if (advertised.length > 0 && !advertised.includes(value)) {
      throw new Error(`Decision ${value} is not available for request ${key}.`);
    }
    await approval.respond({ decision: value });
    this.pendingApprovals.delete(key);
    return { ok: true, requestId: key, decision: value };
  }

  status() {
    return {
      connected: this.connected,
      threadId: this.threadId || null,
      pendingApprovals: this.pendingApprovals.size,
      ...this.getDispatchState(this.threadId)
    };
  }

  async close() {
    this.connected = false;
    if (this.client) {
      await this.client.close().catch((error) => {
        appendLog(this.config.paths.activityFile, `APP_EVENT_STREAM_CLOSE_ERROR ${compactError(error)}`);
      });
    }
    this.client = null;
    this.threadStatus = "unknown";
    this.activeTurnId = "";
    this.ownedTurnId = "";
    this.awaitingTurnCompletion = false;
    this.dispatchInFlight = false;
  }
}
