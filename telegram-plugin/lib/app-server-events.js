import { AppServerClient } from "./app-server-client.js";
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
    this.threadId = threadId;
    this.connected = true;
    appendLog(this.config.paths.activityFile, `APP_EVENT_STREAM_CONNECTED thread=${threadId || "-"}`);
  }

  async _recoverCompletedTurns(client, threadId) {
    if (!this.handlers.onTurnCompleted) {
      return;
    }
    try {
      const response = await client.request("thread/read", {
        threadId,
        includeTurns: true
      }, { timeoutMs: this.config.resumeTimeoutMs || 20000 });
      const turns = Array.isArray(response?.result?.thread?.turns) ? response.result.thread.turns : [];
      for (const turn of turns.slice(-20)) {
        const status = String(turn?.status || "").trim().toLowerCase();
        if (!["completed", "interrupted", "failed"].includes(status)) {
          continue;
        }
        const items = Array.isArray(turn.items) ? turn.items : [];
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
    try {
      return await client.startTurn(options);
    } catch (error) {
      const details = compactError(error).toLowerCase();
      return {
        ok: false,
        busy: details.includes("active turn")
          || details.includes("already running")
          || details.includes("cannot accept")
          || details.includes("busy"),
        overloaded: Number(error?.code) === -32001 || details.includes("server overloaded"),
        error
      };
    }
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
      pendingApprovals: this.pendingApprovals.size
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
  }
}
