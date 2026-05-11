import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startTextTurnOverWs } from "./app-server-client.js";

function buildPrompt(config, message) {
  return [
    "[BLUN Telegram Inbound]",
    `Agent: ${config.agentName}`,
    ...(config.lane ? [`Lane: ${config.lane}`] : []),
    `Chat ID: ${message.chatId}`,
    `Message ID: ${message.messageId}`,
    `User: ${message.user || "unknown"}`,
    `Chat Type: ${message.chatType || "unknown"}`,
    `Conversation Key: ${message.conversationKey || `${message.chatId}:dm`}`,
    ...(message.groupTitle ? [`Group: ${message.groupTitle}`] : []),
    ...(message.telegramThreadId ? [`Telegram Thread ID: ${message.telegramThreadId}`] : []),
    `Timestamp: ${message.ts}`,
    "",
    "Treat the following as a real inbound user message for this exact existing thread.",
    "Reply naturally in-thread. Do not mention bridge transport unless relevant.",
    "If this came from a group or topic, keep the reply scoped to that exact conversation.",
    ...(config.lane ? [`Stay strictly inside your assigned lane (${config.lane}). Do not claim ownership or make decisions for other lanes.`] : []),
    "",
    "Message:",
    message.text
  ].join("\n");
}

export async function injectIntoThread(config, message, threadId) {
  if (config.appServerWsUrl) {
    const result = await startTextTurnOverWs({
      wsUrl: config.appServerWsUrl,
      threadId,
      text: buildPrompt(config, message),
      model: config.model || null,
      effort: config.reasoningEffort || null,
      personality: config.personality || null,
      timeoutMs: config.resumeTimeoutMs
    });

    return {
      ok: result.ok,
      busy: result.busy,
      turnId: result.turnId || "",
      code: result.ok ? 0 : null,
      signal: null,
      responseText: result.ok ? `turn_started thread=${threadId}` : "",
      stdout: "",
      stderr: result.error ? String(result.error.message || result.error) : ""
    };
  }

  const safeKey = `${message.chatId}_${message.messageId}`.replace(/[^0-9A-Za-z_-]/g, "_");
  const promptFile = `${config.paths.promptsDir}\\${safeKey}.md`;
  const responseFile = `${config.paths.responsesDir}\\${safeKey}.txt`;
  writeFileSync(promptFile, buildPrompt(config, message), "utf8");

  return await new Promise((resolve) => {
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const command = resolveCodexCommand(config.codexBin);
    const child = spawn(
      command.file,
      command.args.concat([
        "exec",
        "resume",
        "--skip-git-repo-check",
        "-o",
        responseFile,
        threadId,
        "-"
      ]),
      command.options
    );

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    child.on("error", (error) => {
      finish({
        ok: false,
        busy: false,
        code: null,
        signal: null,
        responseText: "",
        stdout: stdout.trim(),
        stderr: `${stderr}\n${error}`.trim()
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 3000);
      hardKill.unref?.();
    }, config.resumeTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.write(readFileSync(promptFile, "utf8"));
    child.stdin.end();

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const responseText = existsSync(responseFile) ? readFileSync(responseFile, "utf8").trim() : "";
      if (timedOut) {
        finish({
          ok: false,
          busy: true,
          code,
          signal,
          responseText,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
        return;
      }
      finish({
        ok: code === 0,
        busy: false,
        code,
        signal,
        responseText,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function resolveCodexCommand(rawCodexBin) {
  const requested = (rawCodexBin || "codex").trim();
  if (process.platform !== "win32") {
    return {
      file: requested,
      args: [],
      options: {}
    };
  }

  const appData = process.env.APPDATA || "";
  const preferredCandidates = [
    requested,
    requested.endsWith(".cmd") ? requested : `${requested}.cmd`,
    appData ? join(appData, "npm", "codex.cmd") : "",
    appData ? join(appData, "npm", "codex") : ""
  ].filter(Boolean);

  for (const candidate of preferredCandidates) {
    if (candidate === requested || existsSync(candidate)) {
      if (candidate.toLowerCase().endsWith(".cmd")) {
        return {
          file: process.env.ComSpec || "cmd.exe",
          args: ["/d", "/s", "/c", candidate],
          options: { windowsHide: true }
        };
      }
      return {
        file: candidate,
        args: [],
        options: { windowsHide: true }
      };
    }
  }

  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", requested],
    options: { windowsHide: true }
  };
}
