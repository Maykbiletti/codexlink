import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startOrSteerTextTurnOverWs } from "./app-server-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(here, "..", "..");

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
    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      return "hat eine Datei per Telegram gesendet.";
    }
    return "";
  }
  if (/^---\s*BRIEF\b/i.test(text)) {
    return summarizeBrief(text);
  }
  return text;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "";
  }
  if (value < 1024) {
    return `${Math.round(value)} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentInstructions(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.length === 0) {
    return [];
  }

  const lines = [
    "",
    "Telegram-Anhang:"
  ];

  for (const attachment of attachments) {
    if (attachment?.error) {
      lines.push(`- ${attachment.kind || "Datei"} konnte nicht geladen werden: ${attachment.error}`);
      continue;
    }
    const label = attachment.isImage ? "Bild/Screenshot" : (attachment.kind || "Datei");
    const meta = [
      attachment.mimeType,
      formatBytes(attachment.sizeBytes)
    ].filter(Boolean).join(", ");
    const name = attachment.originalName || attachment.safeName || "telegram-file";
    lines.push(`- ${label}: ${name}${meta ? ` (${meta})` : ""}`);
    lines.push(`  Lokaler Pfad: ${attachment.localPath}`);
  }

  if (attachments.some((attachment) => attachment?.isImage && attachment?.localPath)) {
    lines.push("Die Bilddatei wurde als lokaler Bild-Input an diesen Turn angehaengt. Nutze sie direkt fuer Screenshot-/UI-Analyse.");
  } else {
    lines.push("Nutze die lokalen Pfade, wenn du den Inhalt der Datei pruefen oder weiterverarbeiten sollst.");
  }

  return lines;
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

function buildAgentRuntimeContext(config) {
  const name = repairMojibake(String(config.displayName || config.agentName || "CodexLink")).trim() || "CodexLink";
  const lane = repairMojibake(String(config.lane || "")).trim();
  const customPrompt = repairMojibake(String(config.agentPrompt || "")).trim();
  const lines = [
    `[CodexLink Agent Context: You are ${name}.`,
    lane ? `Assigned lane: ${lane}. Stay inside this lane unless the user explicitly redirects you.` : "Stay inside your assigned profile scope.",
    "Treat short greetings or name-only pings as reachability checks, not translation/correction tasks.",
    "For a greeting, reply briefly and naturally as this agent. Do not ask whether to translate, correct, or rewrite unless the user asks for that."
  ];
  if (customPrompt) {
    lines.push(customPrompt);
  }
  lines[lines.length - 1] = `${lines[lines.length - 1]}]`;
  return lines.join("\n");
}

function buildPrompt(config, message) {
  const compactText = compactInboundText(message);
  const isBriefSummary = compactText.startsWith("Brief von ") || compactText.startsWith("Mnemo Idle");
  const label = isBriefSummary ? "" : compactInboundLabel(message);
  const header = [buildAgentRuntimeContext(config), ""];

  if (label) {
    header.push(label);
  }
  header.push(compactText);
  header.push(...formatAttachmentInstructions(message));

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

function buildVisibleConsoleText(config, message) {
  const compactText = compactInboundText(message);
  const isBriefSummary = compactText.startsWith("Brief von ") || compactText.startsWith("Mnemo Idle");
  const parts = [];
  if (!isBriefSummary) {
    parts.push(compactInboundLabel(message));
  }
  parts.push(compactText);
  parts.push(...formatAttachmentInstructions(message));
  if (message.intent === "continue_nudge") {
    parts.push("Weiter-Signal: Bitte den laufenden Arbeitsfluss fortsetzen und nur antworten, wenn es ein konkretes Ergebnis, einen Blocker oder eine Entscheidung gibt.");
  }
  return parts
    .join("\n")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function readRuntime(config) {
  try {
    if (!config?.paths?.currentRuntimeFile || !existsSync(config.paths.currentRuntimeFile)) {
      return null;
    }
    return JSON.parse(readFileSync(config.paths.currentRuntimeFile, "utf8"));
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const parsed = Number.parseInt(String(pid || "0"), 10);
  if (!parsed || parsed <= 0) {
    return false;
  }
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function getVisibleConsoleSkipReason(config, message) {
  if (process.platform !== "win32") {
    return "not_windows";
  }
  if (!config.appServerWsUrl) {
    return "no_app_server";
  }
  const visibleConsoleMode = String(process.env.BLUN_TELEGRAM_VISIBLE_CONSOLE_INJECT || "0").trim().toLowerCase();
  if (visibleConsoleMode !== "force") {
    return "env_disabled";
  }
  if (Array.isArray(message.attachments) && message.attachments.some((attachment) => attachment?.isImage && attachment?.localPath && !attachment.error)) {
    return "image_attachment";
  }
  return "";
}

function injectVisibleConsole(config, message) {
  const skipReason = getVisibleConsoleSkipReason(config, message);
  if (skipReason) {
    return { ok: false, skipped: true, reason: skipReason };
  }

  const runtime = readRuntime(config);
  const frontendPid = Number.parseInt(String(runtime?.frontend_host_pid || "0"), 10) || 0;
  if (!isPidAlive(frontendPid)) {
    return { ok: false, skipped: true, reason: "frontend_offline" };
  }

  const scriptPath = join(runtimeRoot, "telegram-console-input.ps1");
  if (!existsSync(scriptPath)) {
    return { ok: false, skipped: true, reason: "script_missing" };
  }

  const visibleText = buildVisibleConsoleText(config, message);
  if (!visibleText) {
    return { ok: false, skipped: true, reason: "empty" };
  }

  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-TargetPid",
    String(frontendPid),
    "-Text",
    visibleText,
    "-ClearBefore",
    "-Submit"
  ], {
    cwd: runtimeRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000
  });

  if (result.status === 0) {
    return {
      ok: true,
      frontendPid,
      visibleText
    };
  }

  return {
    ok: false,
    skipped: false,
    reason: "script_failed",
    stderr: String(result.stderr || result.error || "").trim(),
    stdout: String(result.stdout || "").trim()
  };
}

function buildTurnInput(config, message) {
  const prompt = buildPrompt(config, message);
  const input = [
    {
      type: "text",
      text: prompt,
      text_elements: []
    }
  ];

  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const attachment of attachments) {
    if (!attachment?.isImage || !attachment.localPath || attachment.error) {
      continue;
    }
    input.push({
      type: "localImage",
      path: attachment.localPath
    });
  }

  return {
    prompt,
    input
  };
}

export async function injectIntoThread(config, message, threadId) {
  const turnInput = buildTurnInput(config, message);
  if (config.appServerWsUrl) {
    const consoleResult = injectVisibleConsole(config, message);
    if (consoleResult.ok) {
      return {
        ok: true,
        busy: false,
        turnId: "",
        code: 0,
        signal: null,
        responseText: `console_injected thread=${threadId} frontend_pid=${consoleResult.frontendPid}`,
        stdout: "",
        stderr: ""
      };
    }

    const result = await startOrSteerTextTurnOverWs({
      wsUrl: config.appServerWsUrl,
      threadId,
      text: turnInput.prompt,
      input: turnInput.input,
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
      responseText: result.ok
        ? `${result.steered ? "turn_steered" : "turn_started"} thread=${threadId} console_${consoleResult.skipped ? "skip" : "fail"}=${consoleResult.reason || "unknown"}`
        : "",
      stdout: "",
      stderr: result.error ? String(result.error.message || result.error) : ""
    };
  }

  const safeKey = `${message.chatId}_${message.messageId}`.replace(/[^0-9A-Za-z_-]/g, "_");
  const promptFile = `${config.paths.promptsDir}\\${safeKey}.md`;
  const responseFile = `${config.paths.responsesDir}\\${safeKey}.txt`;
  writeFileSync(promptFile, turnInput.prompt, "utf8");

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
