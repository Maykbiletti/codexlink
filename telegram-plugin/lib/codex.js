import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startTextTurnWhenIdleOverWs } from "./app-server-client.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_QUEUE_MARKER = /\[CodexLink Queue ID:\s*([A-Za-z0-9._:-]{1,240})\]/i;
let runtimeTurnStarter = null;
let runtimeComposerInjector = null;

export function setRuntimeTurnStarter(starter) {
  runtimeTurnStarter = typeof starter === "function" ? starter : null;
}

export function setRuntimeComposerInjector(injector) {
  runtimeComposerInjector = typeof injector === "function" ? injector : null;
}

export function usesTuiComposerTransport(config) {
  const value = String(config?.inputTransport || "tui_composer").trim().toLowerCase();
  return !["app_server", "app-server", "turn_start", "turn-start"].includes(value);
}

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
    lines.push("Die Bilddatei wurde als lokaler Bild-Input an diesen Turn angehängt. Nutze sie direkt für Screenshot-/UI-Analyse.");
  } else {
    lines.push("Nutze die lokalen Pfade, wenn du den Inhalt der Datei prüfen oder weiterverarbeiten sollst.");
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

function buildPrompt(config, message) {
  const compactText = compactInboundText(message);
  const isBriefSummary = compactText.startsWith("Brief von ") || compactText.startsWith("Mnemo Idle");
  const label = isBriefSummary ? "" : compactInboundLabel(message);
  const header = [];

  if (label) {
    header.push(label);
  }
  header.push(compactText);
  const agentGroupContextBlock = String(message.agentGroupContextBlock || "").trim();
  if (agentGroupContextBlock) {
    header.push("", agentGroupContextBlock);
  }
  header.push(...formatAttachmentInstructions(message));

  if (message.intent === "continue_nudge") {
    header.push(
      "",
      "[Weiter-Signal: kein bloßes Ack senden. Nur antworten, wenn jetzt ein konkretes Ergebnis, Blocker oder eine Entscheidung sichtbar gemacht werden muss.]"
    );
  }

  if (String(message.relevance || "").toLowerCase() === "observe") {
    header.push(
      "",
      "[Kontext: still mitlesen. Nur handeln bei direkter Frage, eigener Zuständigkeit oder klarem Risiko.]"
    );
  }

  if (isAddressOnlyPing(config, compactText)) {
    header.push(
      "",
      "[Ping: Der User prüft nur, ob du erreichbar bist. Antworte kurz, dass du da bist. Starte keine Suche und keinen Tool-Lauf.]"
    );
  }

  return header.join("\n");
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

function runtimeQueueId(message) {
  return String(message?.id || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]/g, "_")
    .slice(0, 240);
}

function buildComposerText(config, message) {
  const prompt = buildPrompt(config, message);
  const queueId = runtimeQueueId(message);
  if (!queueId) {
    return prompt;
  }
  return `${prompt}\n\n[CodexLink Queue ID: ${queueId}]`;
}

function threadItemText(item) {
  if (!item || item.type !== "userMessage" || !Array.isArray(item.content)) {
    return "";
  }
  return item.content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("\n");
}

export function extractRuntimeQueueIdFromThreadItem(item) {
  return threadItemText(item).match(RUNTIME_QUEUE_MARKER)?.[1] || "";
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

function composerSubmitDelayMs(config, text) {
  const configuredMin = Number.parseInt(String(config.composerSubmitDelayMs || "260"), 10) || 260;
  const configuredMax = Number.parseInt(String(config.composerSubmitMaxDelayMs || "12000"), 10) || 12000;
  const safeMax = Math.max(configuredMin, Math.min(30000, configuredMax));
  const lineCount = (String(text || "").match(/\n/g) || []).length;
  const lengthDelay = Math.ceil(String(text || "").length / 1.2);
  return Math.min(safeMax, Math.max(configuredMin, 700, lengthDelay + lineCount * 120));
}

function injectThroughVisibleComposer(config, message) {
  if (process.platform !== "win32") {
    return { ok: false, reason: "not_windows" };
  }
  const runtime = readRuntime(config);
  const frontendPid = Number.parseInt(String(runtime?.frontend_host_pid || "0"), 10) || 0;
  if (!isPidAlive(frontendPid)) {
    return { ok: false, reason: "frontend_offline" };
  }
  const scriptPath = join(runtimeRoot, "telegram-console-input.ps1");
  if (!existsSync(scriptPath)) {
    return { ok: false, reason: "script_missing" };
  }
  const text = buildComposerText(config, message);
  if (!text.trim()) {
    return { ok: false, reason: "empty" };
  }
  const submitDelayMs = composerSubmitDelayMs(config, text);
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-TargetPid",
    String(frontendPid),
    "-Text",
    text,
    "-ClearBefore",
    "-Submit",
    "-SubmitDelayMs",
    String(submitDelayMs)
  ], {
    cwd: runtimeRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: Math.max(20000, submitDelayMs + 15000)
  });
  if (result.status === 0) {
    return { ok: true, frontendPid, submitDelayMs };
  }
  return {
    ok: false,
    reason: "script_failed",
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || result.error || "").trim()
  };
}

export async function injectIntoThread(config, message, threadId) {
  const promptMessage = Object.assign({}, message, { mnemoContextBlock: "" });
  const turnInput = buildTurnInput(config, promptMessage);
  if (config.appServerWsUrl) {
    if (usesTuiComposerTransport(config)) {
      const injectComposer = runtimeComposerInjector || injectThroughVisibleComposer;
      const result = await injectComposer(config, promptMessage, { threadId });
      if (result?.ok) {
        return {
          ok: true,
          busy: false,
          turnId: "",
          code: 0,
          signal: null,
          responseText: `composer_submitted thread=${threadId} frontend_pid=${result.frontendPid || "test"} key=enter`,
          stdout: String(result.stdout || ""),
          stderr: "",
          queuedInComposer: true,
          queueItemId: runtimeQueueId(promptMessage)
        };
      }
      const reason = String(result?.reason || "unavailable");
      return {
        ok: false,
        busy: true,
        turnId: "",
        code: null,
        signal: null,
        responseText: "",
        stdout: String(result?.stdout || ""),
        stderr: `composer_transport_unavailable reason=${reason}${result?.stderr ? ` ${result.stderr}` : ""}`
      };
    }
    const startTurn = runtimeTurnStarter || startTextTurnWhenIdleOverWs;
    const result = await startTurn({
      wsUrl: config.appServerWsUrl,
      threadId,
      text: turnInput.prompt,
      input: turnInput.input,
      model: config.model || null,
      effort: config.reasoningEffort || null,
      personality: config.personality || null,
      timeoutMs: config.resumeTimeoutMs,
      overloadBaseMs: config.runtimeOverloadBaseMs || 500
    });

    if (result.ok) {
      return {
        ok: true,
        busy: result.busy,
        turnId: result.turnId || "",
        code: 0,
        signal: null,
        responseText: `turn_started thread=${threadId} app_server=turn_start`,
        stdout: "",
        stderr: "",
        activeTurnId: result.activeTurnId || ""
      };
    }

    return {
      ok: false,
      busy: result.busy || result.overloaded,
      overloaded: Boolean(result.overloaded),
      turnId: result.turnId || "",
      code: null,
      signal: null,
      responseText: "",
      stdout: "",
      stderr: result.error ? String(result.error.message || result.error) : ""
    };
  }
  return {
    ok: false,
    busy: false,
    code: null,
    signal: null,
    responseText: "",
    stdout: "",
    stderr: "CodexLink requires BLUN_TELEGRAM_APP_SERVER_WS_URL; hidden codex exec sessions are disabled."
  };
}
