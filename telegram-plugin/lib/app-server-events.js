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

function finalTextFromAgentItem(item) {
  if (item?.type !== "agentMessage" || String(item.phase || "final_answer") !== "final_answer") {
    return "";
  }
  const direct = String(item.text || "").trim();
  if (direct) return direct;
  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map((entry) => String(entry?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function finalTextFromTurn(turn) {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const finalItem = [...items].reverse().find((item) => finalTextFromAgentItem(item));
  return finalTextFromAgentItem(finalItem);
}

export class AppServerEventBridge {
  constructor(config, handlers = {}) {
    this.config = config;
    this.handlers = handlers;
    this.client = null;
    this.threadId = "";
    this.finalAnswers = new Map();
    this.pendingFinalCompletions = new Map();
    this.pendingApprovals = new Map();
    this.connected = false;
    this.connecting = null;
    this.threadStatus = "unknown";
    this.activeTurnId = "";
    this.ownedTurnId = "";
    this.ownedQueueItemId = "";
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
    this.ownedQueueItemId = "";
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
      const staleTurnId = String(this.ownedTurnId || this.activeTurnId || "").trim();
      const staleQueueItemId = String(this.ownedQueueItemId || "").trim();
      const hadStaleActiveState = Boolean(
        this.threadStatus === "active"
        || this.awaitingTurnCompletion
        || this.ownedTurnId
        || this.activeTurnId
      );
      const authoritativeStatus = normalizeThreadStatus(thread.status);
      const recoveredTurnIds = new Set();
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
        const completion = {
          threadId,
          turnId: String(turn.id || "").trim(),
          status,
          finalText: finalTextFromTurn(turn),
          error: turn.error || null,
          completedAt: nowIso(),
          recovered: true
        };
        recoveredTurnIds.add(String(turn.id || "").trim());
        const completionResult = await this.handlers.onTurnCompleted(completion);
        if (completionResult?.matched === false) {
          this._retryUnmatchedCompletion(completion, 1);
        } else if (completionResult?.awaitingFinal) {
          this._scheduleMissingFinalCompletion(completion);
        }
        const recoveredTurnId = String(turn.id || "").trim();
        const matchesOwnedTurn = Boolean(recoveredTurnId) && (
          this.ownedTurnId === recoveredTurnId
          || (
            this.ownedTurnId === "pending-turn-id"
            && queueItemId
            && queueItemId === this.ownedQueueItemId
          )
        );
        if (matchesOwnedTurn) {
          this.ownedTurnId = "";
          this.ownedQueueItemId = "";
          this.awaitingTurnCompletion = false;
          if (this.activeTurnId === recoveredTurnId || this.activeTurnId === "pending-turn-id") {
            this.activeTurnId = "";
          }
          appendLog(
            this.config.paths.activityFile,
            `APP_EVENT_RECOVERED_OWNED_TURN thread=${threadId} turn=${recoveredTurnId} queue=${queueItemId || "-"}`
          );
        }
      }
      if (authoritativeStatus === "idle" && hadStaleActiveState) {
        const persistedTurn = [...turns].reverse().find((turn) => {
          const candidateTurnId = String(turn?.id || "").trim();
          if (staleTurnId && !["active", "pending-turn-id"].includes(staleTurnId) && candidateTurnId === staleTurnId) {
            return true;
          }
          if (!staleQueueItemId) return false;
          const userItem = (Array.isArray(turn?.items) ? turn.items : []).find((item) => item?.type === "userMessage");
          return extractRuntimeQueueIdFromThreadItem(userItem) === staleQueueItemId;
        });
        const recoveredTurnId = String(
          persistedTurn?.id
          || (!["active", "pending-turn-id"].includes(staleTurnId) ? staleTurnId : "")
        ).trim();
        if (recoveredTurnId && !recoveredTurnIds.has(recoveredTurnId) && this.handlers.onTurnCompleted) {
          const userItem = (Array.isArray(persistedTurn?.items) ? persistedTurn.items : [])
            .find((item) => item?.type === "userMessage");
          const queueItemId = extractRuntimeQueueIdFromThreadItem(userItem) || staleQueueItemId;
          if (queueItemId && this.handlers.onUserMessageObserved) {
            await this.handlers.onUserMessageObserved({
              threadId,
              turnId: recoveredTurnId,
              queueItemId,
              observedAt: nowIso(),
              recovered: true
            });
          }
          const completion = {
            threadId,
            turnId: recoveredTurnId,
            status: "completed",
            finalText: finalTextFromTurn(persistedTurn),
            error: null,
            completedAt: nowIso(),
            recovered: true,
            synthesizedFromIdle: true
          };
          const result = await this.handlers.onTurnCompleted(completion);
          if (result?.matched === false) {
            this._retryUnmatchedCompletion(completion, 1);
          } else if (result?.awaitingFinal) {
            this._scheduleMissingFinalCompletion(completion);
          }
          appendLog(
            this.config.paths.activityFile,
            `APP_EVENT_IDLE_COMPLETION_RECOVERED thread=${threadId} turn=${recoveredTurnId} queue=${queueItemId || "-"}`
          );
        }
        if (this.threadStatus === "idle") {
          this.activeTurnId = "";
          this.ownedTurnId = "";
          this.ownedQueueItemId = "";
          this.awaitingTurnCompletion = false;
          this.dispatchInFlight = false;
        }
      }
    } catch (error) {
      appendLog(this.config.paths.activityFile, `APP_EVENT_RECOVERY_ERROR thread=${threadId} ${compactError(error)}`);
    }
  }

  async reconcileThread(threadId = "") {
    const requestedThreadId = String(threadId || this.threadId || "").trim();
    if (!requestedThreadId) {
      return { ok: false, reason: "thread_unbound" };
    }
    try {
      const client = await this.ensureConnected(requestedThreadId);
      await this._recoverCompletedTurns(client, requestedThreadId);
      const state = this.getDispatchState(requestedThreadId);
      appendLog(
        this.config.paths.activityFile,
        `APP_EVENT_RECONCILED thread=${requestedThreadId} reason=${state.reason} status=${state.threadStatus}`
      );
      return { ok: true, ...state };
    } catch (error) {
      appendLog(this.config.paths.activityFile, `APP_EVENT_RECONCILE_ERROR thread=${requestedThreadId} ${compactError(error)}`);
      return { ok: false, reason: "event_stream_unavailable", error: compactError(error) };
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
      this.ownedQueueItemId = "";
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

  async claimComposerDispatch(threadId, queueItemId) {
    const requestedThreadId = String(threadId || this.threadId || "").trim();
    const requestedQueueItemId = String(queueItemId || "").trim();
    if (!requestedQueueItemId) {
      return {
        ready: false,
        reason: "queue_item_unbound",
        threadStatus: this.threadStatus,
        activeTurnId: this.activeTurnId || ""
      };
    }
    const dispatchState = await this.checkDispatchReady(requestedThreadId);
    if (!dispatchState.ready) {
      return dispatchState;
    }

    this.dispatchInFlight = true;
    this.ownedQueueItemId = requestedQueueItemId;
    this.ownedTurnId = "pending-turn-id";
    this.awaitingTurnCompletion = true;
    this.threadStatus = "active";
    this.activeTurnId = "pending-turn-id";
    this.statusUpdatedAt = nowIso();
    appendLog(
      this.config.paths.activityFile,
      `APP_COMPOSER_DISPATCH_CLAIMED thread=${requestedThreadId} queue=${requestedQueueItemId}`
    );
    return {
      ready: true,
      reason: "claimed",
      threadId: requestedThreadId,
      threadStatus: "active",
      activeTurnId: "pending-turn-id",
      queueItemId: requestedQueueItemId
    };
  }

  settleComposerDispatch(threadId, queueItemId, result = {}) {
    const requestedThreadId = String(threadId || "").trim();
    const requestedQueueItemId = String(queueItemId || "").trim();
    if (requestedThreadId !== this.threadId || requestedQueueItemId !== this.ownedQueueItemId) {
      return { ok: true, matched: false };
    }

    this.dispatchInFlight = false;
    const submitted = result?.ok === true && result?.busy !== true;
    if (!submitted && this.ownedTurnId === "pending-turn-id") {
      this.ownedTurnId = "";
      this.ownedQueueItemId = "";
      this.awaitingTurnCompletion = false;
      if (this.activeTurnId === "pending-turn-id") {
        this.activeTurnId = "";
      }
      this.threadStatus = "idle";
      this.statusUpdatedAt = nowIso();
    }
    appendLog(
      this.config.paths.activityFile,
      `APP_COMPOSER_DISPATCH_SETTLED thread=${requestedThreadId} queue=${requestedQueueItemId} submitted=${submitted ? 1 : 0}`
    );
    return { ok: true, matched: true, submitted };
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
      ownedQueueItemId: sameThread ? this.ownedQueueItemId : "",
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
      if (queueItemId && turnId && queueItemId === this.ownedQueueItemId) {
        this.ownedTurnId = turnId;
        this.activeTurnId = turnId;
        this.threadStatus = "active";
        this.awaitingTurnCompletion = true;
        this.dispatchInFlight = false;
        this.statusUpdatedAt = nowIso();
      }
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
        const finalText = finalTextFromAgentItem(item);
        if (finalText) {
          this.finalAnswers.set(turnId, finalText);
          const waiting = this.pendingFinalCompletions.get(turnId);
          if (waiting && this.handlers.onTurnCompleted) {
            clearTimeout(waiting.timer);
            this.pendingFinalCompletions.delete(turnId);
            this.finalAnswers.delete(turnId);
            const result = await this.handlers.onTurnCompleted({
              ...waiting.completion,
              finalText,
              recovered: false
            });
            if (result?.matched === false) {
              this._retryUnmatchedCompletion({ ...waiting.completion, finalText }, 1);
            }
          }
        }
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
      if (completedQueueItemId && completedTurnId && completedQueueItemId === this.ownedQueueItemId) {
        this.ownedTurnId = completedTurnId;
      }
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
      const completionMatchesOwnedTurn = Boolean(completedTurnId) && (
        this.ownedTurnId === completedTurnId
        || (
          this.ownedTurnId === "pending-turn-id"
          && (!this.ownedQueueItemId || completedQueueItemId === this.ownedQueueItemId)
        )
      );
      if (completionMatchesOwnedTurn) {
        this.ownedTurnId = "";
        this.ownedQueueItemId = "";
      }
      if (completedTurnId && this.activeTurnId === completedTurnId) {
        this.activeTurnId = "";
      }
      const completionMatchesTrackedTurn = !trackedActiveTurnId
        || trackedActiveTurnId === "active"
        || trackedActiveTurnId === completedTurnId;
      if (completionMatchesOwnedTurn || (!this.ownedTurnId && completionMatchesTrackedTurn)) {
        this.awaitingTurnCompletion = false;
      }
      if (this.threadStatus !== "idle") {
        this.threadStatus = "unknown";
        this.statusUpdatedAt = nowIso();
      }
      const finalText = this.finalAnswers.get(completedTurnId) || finalTextFromTurn(turn);
      if (finalText) this.finalAnswers.delete(completedTurnId);
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
        } else if (result?.awaitingFinal) {
          this._scheduleMissingFinalCompletion(completion);
        }
      }
    }
  }

  _scheduleMissingFinalCompletion(completion) {
    const turnId = String(completion?.turnId || "").trim();
    if (!turnId || !this.handlers.onTurnCompleted || this.pendingFinalCompletions.has(turnId)) {
      return;
    }
    const timer = setTimeout(async () => {
      this.pendingFinalCompletions.delete(turnId);
      let finalText = this.finalAnswers.get(turnId) || "";
      this.finalAnswers.delete(turnId);
      if (!finalText && this.client && completion.threadId) {
        try {
          const response = await this.client.request("thread/read", {
            threadId: completion.threadId,
            includeTurns: true
          }, { timeoutMs: this.config.resumeTimeoutMs || 20000 });
          const turns = Array.isArray(response?.result?.thread?.turns)
            ? response.result.thread.turns
            : [];
          const persistedTurn = turns.find((turn) => String(turn?.id || "").trim() === turnId);
          finalText = finalTextFromTurn(persistedTurn);
        } catch (error) {
          appendLog(this.config.paths.activityFile, `APP_EVENT_FINAL_RECOVERY_ERROR turn=${turnId} ${compactError(error)}`);
        }
      }
      try {
        const result = await this.handlers.onTurnCompleted({
          ...completion,
          finalText,
          finalMissingConfirmed: !finalText,
          recovered: true
        });
        if (result?.matched === false) {
          this._retryUnmatchedCompletion({ ...completion, finalText }, 1);
        }
      } catch (error) {
        appendLog(this.config.paths.activityFile, `APP_EVENT_FINAL_RETRY_ERROR turn=${turnId} ${compactError(error)}`);
      }
    }, 1000);
    timer.unref?.();
    this.pendingFinalCompletions.set(turnId, { completion, timer });
    appendLog(this.config.paths.activityFile, `APP_EVENT_WAITING_FINAL turn=${turnId}`);
  }

  _retryUnmatchedCompletion(completion, attempt) {
    if (attempt > 8 || !this.handlers.onTurnCompleted) {
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const finalText = completion.finalText || this.finalAnswers.get(completion.turnId) || "";
        if (finalText) this.finalAnswers.delete(completion.turnId);
        const retriedCompletion = { ...completion, finalText };
        const result = await this.handlers.onTurnCompleted(retriedCompletion);
        if (result?.matched === false) {
          this._retryUnmatchedCompletion(completion, attempt + 1);
        } else if (result?.awaitingFinal) {
          this._scheduleMissingFinalCompletion(retriedCompletion);
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
    for (const waiting of this.pendingFinalCompletions.values()) {
      clearTimeout(waiting.timer);
    }
    this.pendingFinalCompletions.clear();
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
    this.ownedQueueItemId = "";
    this.awaitingTurnCompletion = false;
    this.dispatchInFlight = false;
  }
}
