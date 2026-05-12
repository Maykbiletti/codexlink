import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { startTextTurnOverWs } from "./app-server-client.js";

function repairMojibake(value) {
  const input = String(value || "");
  if (!input || !/[ÃÂâð]/.test(input)) {
    return input;
  }
  try {
    const repaired = Buffer.from(input, "latin1").toString("utf8");
    if (!repaired || repaired.includes("\uFFFD")) {
      return input;
    }
    return repaired;
  } catch {
    return input;
  }
}

function compactInboundLabel(message) {
  const user = repairMojibake(String(message.user || "Unbekannt")).trim() || "Unbekannt";
  const group = repairMojibake(String(message.groupTitle || "")).trim();
  const chatType = String(message.chatType || "").trim();

  if (group || chatType === "group" || chatType === "supergroup") {
    return `${user} @ ${group || "Gruppe"} schrieb:`;
  }

  return `${user} schrieb:`;
}

function normalizeWhitespace(text) {
  return repairMojibake(String(text || ""))
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMeaningfulLine(lines) {
  for (const raw of lines) {
    const line = String(raw || "").trim();
    if (!line) {
      continue;
    }
    if (/^---\s*BRIEF/i.test(line) || /^---\s*BRIEF END/i.test(line)) {
      continue;
    }
    if (/^##\s*(Title|Project|Request|Constraints|Acceptance|Report Back)\s*$/i.test(line)) {
      continue;
    }
    return line;
  }
  return "";
}

function summarizeBrief(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/);
  const briefHeader = lines.find((line) => /^---\s*BRIEF\b/i.test(String(line || "").trim())) || "";
  const idMatch = briefHeader.match(/\bid=(\d+)/i);
  const fromMatch = briefHeader.match(/\bfrom=([^\s]+)/i);
  const titleIndex = lines.findIndex((line) => /^##\s*Title\s*$/i.test(String(line || "").trim()));
  const titleLine = titleIndex >= 0 ? firstMeaningfulLine(lines.slice(titleIndex + 1, titleIndex + 4)) : "";
  const firstLine = firstMeaningfulLine(lines);
  let detail = titleLine || firstLine || "Neuer Brief";
  detail = detail.replace(/^\[IDLE-CYCLE\]\s*/i, "IDLE-CYCLE: ");
  detail = normalizeWhitespace(detail);
  const from = fromMatch ? fromMatch[1] : "Brief";
  const idPart = idMatch ? ` #${idMatch[1]}` : "";
  if (from === "mnemo-idle-loop") {
    const compactIdle = detail
      .replace(/^IDLE-CYCLE:\s*/i, "")
      .replace(/^Pull project_state,\s*/i, "")
      .replace(/generate proposals via mem_propose,\s*/i, "proposals, ")
      .replace(/ship if ship_eligible\.?/i, "ship-check")
      .replace(/Mode:\s*autonomous\.?/i, "auto")
      .trim();
    return `Mnemo Idle${idPart}: ${compactIdle || "IDLE-CYCLE"}`;
  }
  return `Brief von ${from}${idPart}: ${detail}`;
}

function compactInboundText(message) {
  const text = String(message.text || "").trim();
  if (!text) {
    return "";
  }
  if (/^---\s*BRIEF\b/i.test(text)) {
    return summarizeBrief(text);
  }
  return text;
}

function normalizeAddressText(value) {
  return repairMojibake(String(value || ""))
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAddressOnlyPing(config, text) {
  const normalizedText = normalizeAddressText(text);
  if (!normalizedText || normalizedText.includes(" ")) {
    return false;
  }

  const names = [
    ...(Array.isArray(config.mentionNames) ? config.mentionNames : []),
    config.agentName
  ]
    .map((value) => normalizeAddressText(value))
    .filter((value) => value && value !== "default");

  return names.includes(normalizedText);
}

function buildPrompt(config, message) {
  const compactText = compactInboundText(message);
  const isBriefSummary = compactText.startsWith("Brief von ") || compactText.startsWith("Mnemo Idle");
  const label = isBriefSummary ? "" : compactInboundLabel(message);
  const header = [];

  if (label) {
    header.push(label);
  }
  header.push(compactText);

  if (message.intent === "continue_nudge") {
    header.push(
      "",
      "[Weiter-Signal: kein bloßes Ack senden. Nur antworten, wenn jetzt ein konkretes Ergebnis, Blocker oder eine Entscheidung sichtbar gemacht werden muss.]"
    );
  }

  if (isAddressOnlyPing(config, compactText)) {
    header.push(
      "",
      "[Ping: Der User prueft nur, ob du erreichbar bist. Antworte kurz, dass du da bist. Starte keine Suche und keinen Tool-Lauf.]"
    );
  }

  return header.join("\n");
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
