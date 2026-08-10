import { existsSync } from "node:fs";
import { loadJson, nowIso, saveJson } from "./storage.js";

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Math.min(maximum, Math.max(1, Number.isFinite(parsed) ? parsed : fallback));
}

export class RuntimeController {
  constructor(config, operations, eventBridge = null) {
    this.config = config;
    this.operations = operations;
    this.eventBridge = eventBridge;
    const saved = loadJson(config.paths.runtimeControlFile, {});
    this.paused = saved?.paused === true;
    this.startedAt = nowIso();
    this.lastTickAt = null;
  }

  saveControl() {
    saveJson(this.config.paths.runtimeControlFile, {
      version: 1,
      paused: this.paused,
      updatedAt: nowIso()
    });
  }

  health() {
    const recoveryFile = this.config.paths.stateRecoveryFile;
    const stateRecovery = recoveryFile && existsSync(recoveryFile)
      ? loadJson(recoveryFile, { status: "recovery_required", intakeStopped: true })
      : null;
    return {
      ok: !stateRecovery,
      pid: process.pid,
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      paused: this.paused,
      intakeStopped: Boolean(stateRecovery?.intakeStopped),
      stateRecovery,
      appServerEvents: this.eventBridge?.status?.() || null
    };
  }

  async invoke(method, params = {}) {
    switch (method) {
      case "runtime_health":
        return this.health();
      case "runtime_status":
        try {
          return {
            ...this.operations.status(),
            runtime: this.health()
          };
        } catch (error) {
          if (error?.code !== "STATE_RECOVERY_REQUIRED") {
            throw error;
          }
          return {
            ok: false,
            status: "state_recovery_required",
            intakeStopped: true,
            error: String(error.message || error),
            runtime: this.health()
          };
        }
      case "runtime_queue_list":
        return this.operations.listQueue(boundedInteger(params.limit, 20, 200));
      case "runtime_queue_enqueue":
        return this.operations.enqueue(String(params.text || ""), {
          messageId: params.message_id,
          conversationKey: params.conversation_key,
          user: params.user,
          source: "mcp",
          noTelegramReply: true
        });
      case "runtime_queue_cancel":
        return this.operations.cancel(String(params.id || ""));
      case "runtime_bind_thread":
        return this.operations.bindThread(String(params.thread_id || ""));
      case "runtime_poll_once":
        return this.operations.poll();
      case "runtime_dispatch_once":
        if (this.paused) {
          return { ok: true, status: "paused" };
        }
        return this.operations.dispatch(String(params.thread_id || ""), { auto: true });
      case "runtime_reply":
        return this.operations.reply(String(params.text || ""), {
          chatId: params.chat_id,
          replyToMessageId: params.reply_to_message_id,
          telegramThreadId: params.telegram_thread_id,
          allowPrivateToGroup: params.allow_private_to_group === true,
          confirmGroupBroadcast: params.confirm_group_broadcast === true
        });
      case "runtime_relay_once":
        return this.operations.relayReplies();
      case "runtime_team_relay_once":
        return this.operations.teamRelay();
      case "runtime_tail_activity":
        return this.operations.tailActivity(boundedInteger(params.lines, 20, 500));
      case "runtime_pause":
        this.paused = true;
        this.saveControl();
        return { ok: true, paused: true };
      case "runtime_resume":
        this.paused = false;
        this.saveControl();
        return { ok: true, paused: false };
      case "runtime_approvals_list":
        return this.eventBridge?.listApprovals?.() || [];
      case "runtime_approval_decide":
        if (!this.eventBridge) {
          throw new Error("App-server event bridge is not connected.");
        }
        return this.eventBridge.decideApproval(params.request_id, params.decision);
      default:
        throw new Error(`Unknown runtime method: ${method}`);
    }
  }
}
