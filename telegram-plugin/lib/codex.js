import { startQueuedTextTurnOverWs } from "./app-server-client.js";

let runtimeTurnStarter = null;

export function setRuntimeTurnStarter(starter) {
  runtimeTurnStarter = typeof starter === "function" ? starter : null;
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

export async function injectIntoThread(config, message, threadId) {
  const promptMessage = Object.assign({}, message, { mnemoContextBlock: "" });
  const turnInput = buildTurnInput(config, promptMessage);
  if (config.appServerWsUrl) {
    const startTurn = runtimeTurnStarter || startQueuedTextTurnOverWs;
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
        responseText: `turn_queued thread=${threadId} app_server=turn_start${result.queuedBehindActiveTurn ? " behind_active_turn=1" : ""}`,
        stdout: "",
        stderr: "",
        queuedBehindActiveTurn: Boolean(result.queuedBehindActiveTurn),
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
