import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { listLoadedThreadsOverWs, readThreadOverWs } from "./app-server-client.js";
import { loadConfig } from "./env.js";
import { injectIntoThread, isAddressOnlyPing } from "./codex.js";
import { downloadFileBuffer, getFileInfo, getUpdates, sendChatAction, sendMessage } from "./telegram.js";
import { appendJsonl, appendLog, defaultState, loadJson, nowIso, readTail, saveJson } from "./storage.js";

function loadState(config) {
  const state = loadJson(config.paths.stateFile, defaultState());
  return scrubIdleBriefArtifactsInPlace(state);
}

function saveStateForConfig(config, state) {
  saveJson(config.paths.stateFile, scrubIdleBriefArtifactsInPlace(state));
}

function persistActiveThreadBinding(config, threadId) {
  const value = String(threadId || "").trim();
  if (!value) {
    return;
  }

  try {
    const envPath = config.paths.envFile;
    const existing = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
    let wroteThread = false;
    const lines = existing
      .filter((line, index, all) => index < all.length - 1 || line.trim() !== "")
      .map((line) => {
        if (/^\s*BLUN_TELEGRAM_THREAD_ID\s*=/.test(line)) {
          wroteThread = true;
          return `BLUN_TELEGRAM_THREAD_ID=${value}`;
        }
        return line;
      });
    if (!wroteThread) {
      lines.push(`BLUN_TELEGRAM_THREAD_ID=${value}`);
    }
    writeFileSync(envPath, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // Runtime binding is a self-heal path; dispatch can continue with state.
  }

  try {
    const runtimePath = config.paths.currentRuntimeFile;
    const runtime = loadJson(runtimePath, null);
    if (runtime && (!config.appServerWsUrl || !runtime.ws_url || String(runtime.ws_url).trim() === String(config.appServerWsUrl).trim())) {
      runtime.thread_id = value;
      saveJson(runtimePath, runtime);
    }
  } catch {
    // Best effort only.
  }
}

function queueKey(entry) {
  return `${entry.chatId}:${entry.messageId}`;
}

function hasKnownInboundMessage(state, inbound) {
  const key = queueKey(inbound);
  return [
    ...(state.queue || []),
    ...(state.pendingReplies || [])
  ].some((entry) => queueKey(entry) === key);
}

function pendingReplyKey(entry) {
  return entry.turnId || `${entry.threadId || ""}:${entry.chatId}:${entry.messageId}`;
}

function containsToken(text, token) {
  const value = String(token || "").trim();
  if (!value) {
    return false;
  }
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, "i").test(String(text || ""));
}

function shouldAckOnlyAddressPing() {
  return String(process.env.BLUN_TELEGRAM_PING_ACK_ONLY || "").trim() === "1";
}

function looksLikeEscalation(text) {
  const value = foldTriggerText(text);
  if (!value) {
    return false;
  }
  if ([
    "eskalation",
    "escalation",
    "urgent",
    "emergency",
    "prio 0",
    "p0",
    "blocker"
  ].some((token) => containsToken(value, token))) {
    return true;
  }
  return containsToken(value, "sofort") && !/\bab sofort\b/u.test(value);
}

const UNIVERSAL_AGENT_COMMANDS = new Set([
  "ai",
  "assistant",
  "bot",
  "agent",
  "helper",
  "copilot",
  "codex",
  "claude",
  "gpt",
  "llm",
  "ask",
  "chat",
  "prompt",
  "debug",
  "fix",
  "review",
  "explain",
  "summarize",
  "summarise",
  "translate",
  "analyze",
  "analyse",
  "optimize",
  "optimise",
  "refactor",
  "test",
  "hilfe",
  "hilf",
  "frage",
  "frag",
  "erklar",
  "erklaer",
  "erklare",
  "erklaere",
  "pruf",
  "pruef",
  "prufe",
  "pruefe",
  "reparier",
  "repariere",
  "behebe",
  "korrigiere",
  "ubersetz",
  "uebersetz",
  "zusammenfassen",
  "analysiere",
  "optimiere",
  "teste",
  "hjalp",
  "fraga",
  "forklar",
  "oversatt",
  "sammanfatta",
  "analysera",
  "granska",
  "fixa",
  "ayuda",
  "pregunta",
  "explica",
  "traducir",
  "traduce",
  "resumir",
  "resume",
  "analiza",
  "revisar",
  "arregla",
  "corrige",
  "aide",
  "explique",
  "traduire",
  "traduis",
  "resumer",
  "analyse",
  "corriger",
  "aiuto",
  "spiega",
  "traduci",
  "riassumi",
  "analizza",
  "correggi",
  "sistema",
  "ajuda",
  "explica",
  "traduz",
  "analisa",
  "corrigir",
  "uitleg",
  "vertaal",
  "samenvatten",
  "analyseer",
  "pomoc",
  "wyjasnij",
  "przetlumacz",
  "podsumuj",
  "analizuj",
  "napraw",
  "yardim",
  "acikla",
  "cevir",
  "ozetle",
  "analiz",
  "duzelt"
]);

const UNIVERSAL_AGENT_PATTERNS = [
  /\b(can someone|could someone|please|pls)\s+(explain|help|debug|review|fix|summari[sz]e|translate|analy[sz]e)\b/u,
  /\b(help me|help with this|what does this do|fix this error|review this code|write tests|create solution)\b/u,
  /\b(kann jemand|kannst du|bitte)\s+(helfen|erklaren|erklaeren|prufen|pruefen|fixen|reparieren|ubersetzen|uebersetzen|analysieren)\b/u,
  /\b(hilf mir|was bedeutet das|schau dir das an|pruf das|pruef das|fix das|debug das|fass das zusammen)\b/u,
  /\b(kan nagon|kan du)\s+(hjalpa|forklara|granska|fixa|oversatta|sammanfatta)\b/u,
  /\b(ayudame|puedes|puede alguien)\s+(explicar|revisar|arreglar|traducir|resumir|analizar)\b/u,
  /\b(aide moi|peux tu|quelqu un peut)\s+(expliquer|corriger|traduire|resumer|analyser)\b/u
];

function groupDeliveryMode(config) {
  return String(config.groupDeliveryMode || "all").trim().toLowerCase();
}

function shouldDeliverAllGroupMessages(config) {
  return groupDeliveryMode(config) === "all";
}

function looksLikeUniversalAgentIntent(text) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return false;
  }

  const words = normalized.split(/\s+/).filter(Boolean);
  const first = words[0] || "";
  if (UNIVERSAL_AGENT_COMMANDS.has(first)) {
    return true;
  }

  return UNIVERSAL_AGENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

const CONTINUE_NEGATIVE_ONLY = new Set([
  "ok",
  "okay",
  "ja",
  "yes",
  "si",
  "oui",
  "passt",
  "gut",
  "nice",
  "cool",
  "danke",
  "thanks",
  "merci",
  "gracias",
  "verstanden",
  "perfekt",
  "super",
  "top",
  "alles klar",
  "sieht gut aus",
  "hort sich gut an",
  "hoert sich gut an"
]);

const CONTINUE_BLOCK_PATTERNS = [
  /\bweiter so\b/u,
  /^status\b/u,
  /\bexplizites go\b/u,
  /\bohne\b[\s\S]{0,24}\bgo\b/u
];

const CONTINUE_PATTERN_GROUPS = [
  { weight: 4, patterns: [/\bmach weiter\b/u, /\bleg los\b/u, /\blos geht'?s\b/u, /\bfeuer frei\b/u, /\bsetz(?:e)? es um\b/u, /\bfu(?:eh|h)re es aus\b/u, /\bimplementiere es\b/u, /\bfix das\b/u, /\bfix den fehler\b/u, /\bbeheb(?:e)? das\b/u, /\breparier das\b/u, /\bteste es\b/u, /\bdebugge es\b/u] },
  { weight: 4, patterns: [/\bgo ahead\b/u, /\bcontinue\b/u, /\bkeep going\b/u, /\bexecute it\b/u, /\bimplement it\b/u, /\bfix it\b/u, /\bpatch it\b/u, /\bdebug it\b/u, /\btest it\b/u, /\brun it\b/u, /\bsend it\b/u, /\bship it\b/u, /\bkeep cooking\b/u, /\bfinish the implementation\b/u] },
  { weight: 4, patterns: [/\bdale\b/u, /\bvas y\b/u, /\bfais le\b/u, /\bcontinua\b/u, /\bvai avanti\b/u, /\bvamos\b/u, /\bga door\b/u, /\bkontynuuj\b/u, /\bdevam et\b/u] },
  { weight: 3, patterns: [/\bund weiter\b/u, /\barbeite weiter\b/u, /\bsetz(?:e)? fort\b/u, /\bn(?:ae|a)chster schritt\b/u, /\bmach den n(?:ae|a)chsten schritt\b/u, /\bweiter trotz fehler\b/u, /\bnicht abbrechen\b/u, /\bnochmal versuchen\b/u, /\bbrief f(?:ue|u)r dich\b/u, /\bbrief\b[\s\S]{0,30}\babruf(?:en)?\b/u, /\bbrief\b[\s\S]{0,30}\bpull\b/u] },
  { weight: 3, patterns: [/\bgib gas\b/u, /\bhau rein\b/u, /\bzieh durch\b/u, /\bzieh komplett durch\b/u, /\bnicht quatschen machen\b/u, /\bballer weiter\b/u, /\bmach den rest\b/u, /\bmach alleine weiter\b/u, /\bfull send\b/u, /\bfuck it we ball\b/u, /\byolo\b/u] }
];

const CONTINUE_ACTION_WORDS = [
  "mach",
  "start",
  "weiter",
  "los",
  "arbeite",
  "setz",
  "setze",
  "fuhre",
  "fuehre",
  "implementiere",
  "fix",
  "teste",
  "debugge",
  "patch",
  "bau",
  "ander",
  "aender",
  "schreib",
  "go",
  "continue",
  "deploy",
  "ship",
  "baller",
  "vollgas",
  "cook",
  "run"
];

const WORK_CONTEXT_HINTS = [
  "auth",
  "middleware",
  "datei",
  "file",
  "code",
  "anderung",
  "aenderung",
  "brief",
  "abruf",
  "pull",
  "commit",
  "test",
  "debug",
  "fehler",
  "bug",
  "fix",
  "patch",
  "implement",
  "umsetzen",
  "refactor",
  "deploy",
  "ui",
  "portal",
  "gruppe",
  "konsole",
  "plugin"
];

function normalizeTriggerText(text) {
  return String(text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[â€™']/g, "'")
    .replace(/[â€œâ€â€ž"]/g, "\"")
    .replace(/[â€“â€”]/g, "-")
    .replace(/[^\p{L}\p{N}@_"'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function foldTriggerText(text) {
  return normalizeTriggerText(text)
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "");
}

function tokenCount(text) {
  if (!text) {
    return 0;
  }
  return text.split(/\s+/).filter(Boolean).length;
}

function looksLikeWorkContextText(text) {
  const normalized = foldTriggerText(text);
  if (!normalized || CONTINUE_NEGATIVE_ONLY.has(normalized)) {
    return false;
  }
  return WORK_CONTEXT_HINTS.some((token) => containsToken(normalized, token));
}

function hasRecentWorkContext(context = {}) {
  const currentConversationKey = String(context.conversationKey || "").trim();
  const recentEntries = Array.isArray(context.recentEntries) ? context.recentEntries : [];
  if (context.hasRecentWorkContext === true) {
    return true;
  }
  if (context.hasPendingReplies) {
    return true;
  }
  if (recentEntries.some((entry) => String(entry.intent || "").trim().toLowerCase() !== "continue_nudge")) {
    return true;
  }

  if (currentConversationKey) {
    const recentConversationEntries = recentEntries.filter((entry) => String(entry.conversationKey || "").trim() === currentConversationKey);
    if (recentConversationEntries.some((entry) => looksLikeWorkContextText(entry.text || entry.sourceText || ""))) {
      return true;
    }
  }

  if (looksLikeWorkContextText(context.lastUserWorkText || "")) {
    return true;
  }

  return false;
}

function getContinueTriggerScore(text, context = {}) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return 0;
  }
  if (CONTINUE_NEGATIVE_ONLY.has(normalized)) {
    return 0;
  }
  if (looksLikeStatusBroadcast(normalized)) {
    return 0;
  }

  const words = tokenCount(normalized);
  let score = 0;

  for (const pattern of CONTINUE_BLOCK_PATTERNS) {
    if (pattern.test(normalized)) {
      score -= 2;
    }
  }

  for (const group of CONTINUE_PATTERN_GROUPS) {
    for (const pattern of group.patterns) {
      if (pattern.test(normalized)) {
        score += group.weight;
      }
    }
  }

  for (const actionWord of CONTINUE_ACTION_WORDS) {
    if (containsToken(normalized, actionWord)) {
      score += 1;
    }
  }

  if (words > 0 && words <= 4 && score > 0) {
    score += 1;
  }

  if (hasRecentWorkContext(context) && score > 0) {
    score += 1;
  }

  if (/[!?]/.test(String(text || "")) && score < 3) {
    score -= 1;
  }

  if (words > 12 && score < 3) {
    score = Math.min(score, 1);
  }

  return Math.max(0, score);
}

function looksLikeContinueNudge(text, context = {}) {
  const score = getContinueTriggerScore(text, context);
  if (score >= 3) {
    return true;
  }
  return score >= 1 && hasRecentWorkContext(context);
}

function looksLikeAckOnly(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value) {
    return true;
  }
  if (value.length > 220) {
    return false;
  }
  return [
    "ok",
    "okay",
    "ja",
    "verstanden",
    "alles klar",
    "mache ich",
    "ich arbeite weiter",
    "ich mache weiter",
    "ich bin dran",
    "ich bin da",
    "weiter",
    "alles klar, ich mache weiter",
    "verstanden. ich arbeite weiter."
  ].includes(value);
}

function looksLikeContextRequestOnly(text) {
  const value = String(text || "").trim().toLowerCase();
  if (!value || value.length > 280) {
    return false;
  }
  return [
    "mir fehlt in diesem chat gerade der konkrete arbeitskontext. schick mir bitte den letzten stand oder die aufgabe kurz hier rein, dann setze ich direkt fort.",
    "schick mir kurz den letzten stand oder den punkt, ab dem ich anknÃ¼pfen soll.",
    "schick mir bitte den letzten stand.",
    "mir fehlt gerade der konkrete arbeitskontext.",
    "welcher punkt genau?",
    "womit genau soll ich weitermachen?"
  ].includes(value);
}

function uniqueAgentMentionNames(config) {
  const values = [
    ...(Array.isArray(config.mentionNames) ? config.mentionNames : []),
    config.agentName
  ];
  return Array.from(new Set(
    values
      .map((value) => foldTriggerText(value))
      .filter((value) => value && value !== "default")
  ));
}

function uniqueOtherAgentMentionNames(config) {
  const ownNames = new Set(uniqueAgentMentionNames(config));
  const values = Array.isArray(config.otherAgentNames) ? config.otherAgentNames : [];
  return Array.from(new Set(
    values
      .map((value) => foldTriggerText(value))
      .filter((value) => value && value !== "default" && !ownNames.has(value))
  ));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function startsWithAgentAddress(normalized, mention) {
  // normalizeTriggerText strips most punctuation, so this covers "Agent?",
  // "Agent:", "/agent", "!agent", "#agent" and "[agent]" as "agent".
  return new RegExp(`^@?${mention}\\b(?:\\s|$)`, "u").test(normalized);
}

function startsWithTeamAddressList(normalized, mention) {
  // Group chats often address multiple agents in one breath:
  // "designer, codex ...". Keep this conservative: only treat it as direct
  // if this agent is in the first small address block at the beginning.
  return new RegExp(`^(?:@?[a-z][a-z0-9_-]{1,24}\\b\\s+){1,3}@?${mention}\\b(?:\\s|$)`, "u").test(normalized);
}

function looksLikeStatusBroadcast(text) {
  const normalized = foldTriggerText(text);
  if (/^status(?:\s|$|[~:.-])/u.test(normalized)) {
    return true;
  }
  if (/^status\s+~?\s*\d{1,2}\s+\d{2}\b/u.test(normalized)) {
    return true;
  }
  return /^[a-z][a-z0-9_-]{1,24}\s+~?\s*\d{1,2}\s+\d{2}\b/u.test(normalized);
}

function isAgentAddressed(config, text) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return false;
  }

  const mentionNames = uniqueAgentMentionNames(config);
  if (mentionNames.length === 0) {
    return false;
  }

  for (const name of mentionNames) {
    const mention = escapeRegExp(name);
    const startsAddressed = startsWithAgentAddress(normalized, mention) || startsWithTeamAddressList(normalized, mention);
    if (startsAddressed) {
      return true;
    }

    const routedToAgent = new RegExp(`\\b(?:fuer|fur|for|an|to)\\s+@?${mention}\\b`, "u").test(normalized);
    if (routedToAgent) {
      return true;
    }

    const briefDirective = new RegExp(`\\bbrief\\b(?:\\s+#?\\d+)?\\s+(?:fuer|fur|for|an|to)\\s+@?${mention}\\b|\\b@?${mention}\\b\\s*[-:,]?\\s*brief\\b`, "u").test(normalized);
    if (briefDirective) {
      return true;
    }

    const imperativeAfterMention = new RegExp(`\\b@?${mention}\\b\\s+(?:bitte|please|du|kannst|kann|sollst|soll|bekommst|bekommt|kriegst|erhaeltst|erhaltst|brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|mach|setz|starte|aktivier|antwort|melde|bescheid)\\b`, "u").test(normalized);
    if (imperativeAfterMention) {
      return true;
    }

    const workDirective = new RegExp(`\\b@?${mention}\\b[\\s\\S]{0,120}\\b(?:bitte|please|du|kannst|kann|sollst|soll|bekommst|bekommt|kriegst|erhaeltst|erhaltst|brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content)\\b|\\b(?:brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content)\\b[\\s\\S]{0,120}\\b@?${mention}\\b`, "u").test(normalized);
    if (workDirective) {
      return true;
    }

    if (containsToken(normalized, name)) {
      return true;
    }
  }

  return false;
}

function isOtherAgentAddressed(config, text) {
  const normalized = foldTriggerText(text);
  if (!normalized) {
    return false;
  }

  const mentionNames = uniqueOtherAgentMentionNames(config);
  if (mentionNames.length === 0) {
    return false;
  }

  for (const name of mentionNames) {
    const mention = escapeRegExp(name);
    const startsAddressed = startsWithAgentAddress(normalized, mention) || startsWithTeamAddressList(normalized, mention);
    if (startsAddressed) {
      return true;
    }

    const routedToAgent = new RegExp(`\\b(?:fuer|fur|for|an|to)\\s+@?${mention}\\b`, "u").test(normalized);
    if (routedToAgent) {
      return true;
    }

    const briefDirective = new RegExp(`\\bbrief\\b(?:\\s+#?\\d+)?\\s+(?:fuer|fur|for|an|to)\\s+@?${mention}\\b|\\b@?${mention}\\b\\s*[-:,]?\\s*brief\\b`, "u").test(normalized);
    if (briefDirective) {
      return true;
    }

    const workDirective = new RegExp(`\\b@?${mention}\\b[\\s\\S]{0,120}\\b(?:bitte|please|du|kannst|kann|sollst|soll|bekommst|bekommt|kriegst|erhaeltst|erhaltst|brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content|uebersetz|ubersetz|translate)\\b|\\b(?:brauchst|brauche|hilf|unterstuetz|unterstuetze|sag|schick|send|weiter|continue|mach|pull|abruf|abrufen|zieh|hol|hole|pruef|pruf|teste|test|debugge|fix|patch|setz|starte|aktivier|antwort|melde|bescheid|signal|live|stream|chunk|content|uebersetz|ubersetz|translate)\\b[\\s\\S]{0,120}\\b@?${mention}\\b`, "u").test(normalized);
    if (workDirective) {
      return true;
    }
  }

  return false;
}

function classifyInboundRelevance(config, inbound) {
  const text = String(inbound.text || "");
  const isStatusBroadcast = looksLikeStatusBroadcast(text);
  const isGroupChat = String(inbound.chatType || "") !== "private";

  if (!isStatusBroadcast && isAgentAddressed(config, text)) {
    return "direct";
  }

  if (!isStatusBroadcast && looksLikeUniversalAgentIntent(text)) {
    return "direct";
  }

  if (!isStatusBroadcast && isOtherAgentAddressed(config, text)) {
    return "ambient";
  }

  if (String(inbound.chatType || "") === "private") {
    return "direct";
  }

  if (isStatusBroadcast) {
    return "ambient";
  }

  if (looksLikeEscalation(text)) {
    return "escalation";
  }

  const lane = String(config.lane || "").trim();
  if (lane && lane.toLowerCase() !== "general" && containsToken(text, lane)) {
    return "lane";
  }

  if (isGroupChat && shouldDeliverAllGroupMessages(config)) {
    return "direct";
  }

  if (inbound.senderIsBot) {
    return "ambient";
  }

  return "ambient";
}

function statusWeight(status) {
  switch (status) {
    case "delivered":
    case "error":
      return 4;
    case "submitted":
      return 2;
    case "parked":
      return 0;
    case "queued":
    default:
      return 1;
  }
}

function pickIsoLater(left, right) {
  if (!left) {
    return right || null;
  }
  if (!right) {
    return left || null;
  }
  return left >= right ? left : right;
}

function pickLatestRecord(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }
  const currentStamp = current.ts || current.deliveredAt || current.lastAttemptAt || "";
  const incomingStamp = incoming.ts || incoming.deliveredAt || incoming.lastAttemptAt || "";
  if (incomingStamp > currentStamp) {
    return { ...incoming };
  }
  if (incomingStamp < currentStamp) {
    return { ...current };
  }
  const currentId = Number(current.messageId || 0);
  const incomingId = Number(incoming.messageId || 0);
  return incomingId >= currentId ? { ...incoming } : { ...current };
}

function isoAgeMs(isoString) {
  const millis = Date.parse(isoString || "");
  if (Number.isNaN(millis)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Date.now() - millis);
}

function isNonTerminalPendingReply(entry) {
  return Boolean(entry)
    && !entry.sentAt
    && !["error", "ignored_bot", "superseded", "expired", "stale_thread"].includes(String(entry.status || ""));
}

function hasResponseMessageIds(entry) {
  return Array.isArray(entry?.responseMessageIds)
    && entry.responseMessageIds.filter(Boolean).length > 0;
}

function isReplyAwaitingOutcome(entry) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  const status = String(entry.status || "").trim().toLowerCase();
  if (["sent", "suppressed_ack", "error", "ignored_bot", "superseded", "expired", "stale_thread"].includes(status)) {
    return false;
  }
  return !hasResponseMessageIds(entry);
}

function closeStaleThreadPendingRepliesInPlace(pendingReplies, activeThreadId) {
  const threadId = String(activeThreadId || "").trim();
  if (!threadId) {
    return 0;
  }
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  let closed = 0;
  for (const entry of replies) {
    if (!isNonTerminalPendingReply(entry)) {
      continue;
    }
    const entryThreadId = String(entry.threadId || "").trim();
    if (!entryThreadId || entryThreadId === threadId) {
      continue;
    }
    entry.status = "stale_thread";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || `[stale pending reply from previous thread ${entryThreadId}]`;
    closed += 1;
  }
  return closed;
}

function supersedeOlderPendingRepliesInPlace(pendingReplies) {
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  const newestByConversation = new Map();

  for (const entry of replies) {
    if (!isReplyAwaitingOutcome(entry)) {
      continue;
    }
    const key = [
      String(entry.chatId || "").trim(),
      String(entry.conversationKey || "").trim(),
      String(entry.telegramThreadId || "").trim()
    ].join("|");
    const current = newestByConversation.get(key);
    const stamp = String(entry.createdAt || "");
    if (!current || stamp > current.stamp) {
      newestByConversation.set(key, { entry, stamp });
    }
  }

  let superseded = 0;
  for (const entry of replies) {
    if (!isReplyAwaitingOutcome(entry)) {
      continue;
    }
    const key = [
      String(entry.chatId || "").trim(),
      String(entry.conversationKey || "").trim(),
      String(entry.telegramThreadId || "").trim()
    ].join("|");
    const newest = newestByConversation.get(key)?.entry || null;
    if (!newest || newest === entry) {
      continue;
    }
    entry.status = "superseded";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || "[superseded by newer message]";
    superseded += 1;
  }

  return superseded;
}

function isPrivateIdleBriefArtifact(entry) {
  if (!entry) {
    return false;
  }
  if (String(entry.chatType || "").toLowerCase() !== "private") {
    return false;
  }
  return looksLikeMnemoIdleLoopBrief(entry.text || entry.sourceText || "");
}

function scrubIdleBriefArtifactsInPlace(state) {
  if (!state || typeof state !== "object") {
    return state;
  }

  const queue = Array.isArray(state.queue) ? state.queue : [];
  state.queue = mergeQueueLists([], queue.filter((entry) => !isPrivateIdleBriefArtifact(entry)));

  const pendingReplies = Array.isArray(state.pendingReplies) ? state.pendingReplies : [];
  state.pendingReplies = mergePendingReplyLists([], pendingReplies.filter((entry) => !isPrivateIdleBriefArtifact(entry)));

  if (isPrivateIdleBriefArtifact(state.lastInbound)) {
    state.lastInbound = [...state.queue]
      .filter((entry) => !isPrivateIdleBriefArtifact(entry))
      .sort((left, right) => {
        const leftStamp = String(left?.ts || left?.deliveredAt || left?.lastAttemptAt || "");
        const rightStamp = String(right?.ts || right?.deliveredAt || right?.lastAttemptAt || "");
        if (leftStamp !== rightStamp) {
          return rightStamp.localeCompare(leftStamp);
        }
        return Number(right?.messageId || 0) - Number(left?.messageId || 0);
      })[0] || null;
  }

  return state;
}

function closeExpiredPendingRepliesInPlace(config, pendingReplies) {
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  const timeoutMs = getEffectivePendingReplyTimeoutMs(config);
  if (timeoutMs <= 0) {
    return 0;
  }

  let expired = 0;
  for (const entry of replies) {
    if (hasResponseMessageIds(entry)) {
      entry.status = String(entry.status || "").trim().toLowerCase() === "suppressed_ack" ? "suppressed_ack" : "sent";
      entry.sentAt = entry.sentAt || getPendingReplyActivityAt(entry) || nowIso();
      continue;
    }
    if (!isNonTerminalPendingReply(entry)) {
      continue;
    }
    if (isoAgeMs(getPendingReplyActivityAt(entry)) < timeoutMs) {
      continue;
    }
    entry.status = "expired";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || `[pending reply expired after ${timeoutMs}ms]`;
    expired += 1;
  }
  return expired;
}

function getEffectivePendingReplyTimeoutMs(config) {
  const configuredMs = Math.max(Number(config.pendingReplyTimeoutMs || 0), 0);
  if (configuredMs <= 0) {
    return 0;
  }
  return configuredMs;
}

function getEffectiveIdleCooldownMs(config, entry = null) {
  const configuredMs = Math.max(Number(config.idleCooldownMs || 0), 0);
  if (configuredMs <= 0) {
    return 0;
  }
  const relevance = String(entry?.relevance || "").trim().toLowerCase();
  const chatType = String(entry?.chatType || "").trim().toLowerCase();
  const directLike = chatType === "private" || relevance === "direct" || relevance === "lane";
  const capMs = directLike ? 3000 : 5000;
  return Math.min(configuredMs, capMs);
}

function parkExpiredAmbientQueueEntriesInPlace(config, queue) {
  const entries = Array.isArray(queue) ? queue : [];
  const ttlMs = Math.max(Number(config.ambientQueueTtlMs || 0), 0);
  if (ttlMs <= 0) {
    return 0;
  }

  let parked = 0;
  for (const entry of entries) {
    if (!entry || entry.status !== "queued") {
      continue;
    }
    if (String(entry.relevance || "") !== "ambient") {
      continue;
    }
    if (isoAgeMs(entry.ts) < ttlMs) {
      continue;
    }
    entry.status = "parked";
    entry.parkedAt = nowIso();
    if (!entry.responsePreview) {
      entry.responsePreview = `[ambient parked after ${ttlMs}ms]`;
    }
    parked += 1;
  }
  return parked;
}

function reclassifyQueuedEntriesInPlace(config, queue) {
  const entries = Array.isArray(queue) ? queue : [];
  let changed = 0;
  let parked = 0;
  for (const entry of entries) {
    if (!entry || entry.status !== "queued") {
      continue;
    }
    const previous = String(entry.relevance || "").trim().toLowerCase();
    const next = classifyInboundRelevance(config, entry);
    if (next === previous) {
      continue;
    }
    const reclassifiedAt = nowIso();
    entry.relevance = next;
    entry.reclassifiedAt = reclassifiedAt;
    if (next === "ambient" && String(entry.chatType || "").trim().toLowerCase() !== "private") {
      entry.status = "parked";
      entry.parkedAt = entry.parkedAt || reclassifiedAt;
      entry.responsePreview = entry.responsePreview || "[reclassified ambient]";
      parked += 1;
    }
    changed += 1;
  }
  return { changed, parked };
}

function mergeQueueEntry(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }

  const merged = {
    ...current,
    ...incoming
  };

  if (statusWeight(current.status) > statusWeight(incoming.status)) {
    merged.status = current.status;
  } else if (statusWeight(incoming.status) > statusWeight(current.status)) {
    merged.status = incoming.status;
  }

  merged.attempts = Math.max(Number(current.attempts || 0), Number(incoming.attempts || 0));
  merged.lastAttemptAt = pickIsoLater(current.lastAttemptAt, incoming.lastAttemptAt);
  merged.submittedAt = pickIsoLater(current.submittedAt, incoming.submittedAt);
  merged.deliveredAt = pickIsoLater(current.deliveredAt, incoming.deliveredAt);
  merged.ts = pickIsoLater(current.ts, incoming.ts);

  for (const field of ["threadId", "responsePreview", "stderr", "stdout", "chatType", "conversationKey", "groupTitle", "telegramThreadId", "senderIsBot", "relevance", "intent"]) {
    if (!merged[field]) {
      merged[field] = current[field] || incoming[field] || null;
    }
  }

  return merged;
}

function mergeQueueLists(baseQueue, incomingQueue) {
  const mergedByKey = new Map();
  const orderedKeys = [];

  for (const entry of baseQueue || []) {
    const key = queueKey(entry);
    if (!mergedByKey.has(key)) {
      orderedKeys.push(key);
      mergedByKey.set(key, { ...entry });
      continue;
    }
    mergedByKey.set(key, mergeQueueEntry(mergedByKey.get(key), entry));
  }

  for (const entry of incomingQueue || []) {
    const key = queueKey(entry);
    if (!mergedByKey.has(key)) {
      orderedKeys.push(key);
      mergedByKey.set(key, { ...entry });
      continue;
    }
    mergedByKey.set(key, mergeQueueEntry(mergedByKey.get(key), entry));
  }

  return orderedKeys
    .map((key) => mergedByKey.get(key))
    .sort((left, right) => {
      const leftTs = left?.ts || left?.deliveredAt || "";
      const rightTs = right?.ts || right?.deliveredAt || "";
      if (leftTs !== rightTs) {
        return leftTs.localeCompare(rightTs);
      }
      return Number(left?.messageId || 0) - Number(right?.messageId || 0);
    });
}

function mergePendingReplyEntry(current, incoming) {
  if (!current && !incoming) {
    return null;
  }
  if (!current) {
    return { ...incoming };
  }
  if (!incoming) {
    return { ...current };
  }

  return {
    ...current,
    ...incoming,
    sentAt: pickIsoLater(current.sentAt, incoming.sentAt),
    status: incoming.status || current.status || "pending",
    responsePreview: incoming.responsePreview || current.responsePreview || "",
    responseMessageIds: Array.from(new Set([...(current.responseMessageIds || []), ...(incoming.responseMessageIds || [])]))
  };
}

function looksLikeBotSender(entry) {
  if (entry?.senderIsBot === true) {
    return true;
  }
  return /_bot$/i.test(String(entry?.user || "").trim());
}

function reconcilePendingRepliesInPlace(pendingReplies) {
  const replies = Array.isArray(pendingReplies) ? pendingReplies : [];
  const groups = new Map();

  for (const entry of replies) {
    const key = `${entry.chatId || ""}:${entry.conversationKey || ""}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(entry);
  }

  for (const entries of groups.values()) {
    entries.sort((left, right) => {
      const leftCreated = String(left?.createdAt || "");
      const rightCreated = String(right?.createdAt || "");
      if (leftCreated !== rightCreated) {
        return leftCreated.localeCompare(rightCreated);
      }
      return String(left?.messageId || "").localeCompare(String(right?.messageId || ""));
    });

    const latestSent = [...entries].reverse().find((entry) => entry.sentAt);
    if (!latestSent) {
      continue;
    }

    for (const entry of entries) {
      if (entry === latestSent || entry.sentAt) {
        continue;
      }
      if (String(entry.createdAt || "") > String(latestSent.createdAt || "")) {
        continue;
      }
      entry.status = entry.status === "error" ? entry.status : "superseded";
      entry.sentAt = latestSent.sentAt;
      if (!entry.responsePreview) {
        entry.responsePreview = latestSent.responsePreview || `Superseded by reply to message ${latestSent.messageId}`;
      }
      if ((!entry.responseMessageIds || entry.responseMessageIds.length === 0) && Array.isArray(latestSent.responseMessageIds)) {
        entry.responseMessageIds = [...latestSent.responseMessageIds];
      }
    }
  }

  return replies;
}

function mergePendingReplyLists(baseReplies, incomingReplies) {
  const merged = new Map();
  const order = [];

  for (const entry of baseReplies || []) {
    const key = pendingReplyKey(entry);
    if (!merged.has(key)) {
      order.push(key);
      merged.set(key, { ...entry });
      continue;
    }
    merged.set(key, mergePendingReplyEntry(merged.get(key), entry));
  }

  for (const entry of incomingReplies || []) {
    const key = pendingReplyKey(entry);
    if (!merged.has(key)) {
      order.push(key);
      merged.set(key, { ...entry });
      continue;
    }
    merged.set(key, mergePendingReplyEntry(merged.get(key), entry));
  }

  return order.map((key) => merged.get(key));
}

function syncRecordFromQueue(record, queue) {
  if (!record) {
    return null;
  }
  const match = (queue || []).find((entry) => queueKey(entry) === queueKey(record));
  return match ? mergeQueueEntry(record, match) : record;
}

function markMatchingQueueEntriesInPlace(state, source, updates) {
  const key = queueKey(source || {});
  if (!key || key === ":") {
    return 0;
  }
  let changed = 0;
  for (const entry of state.queue || []) {
    if (queueKey(entry) !== key) {
      continue;
    }
    Object.assign(entry, updates);
    changed += 1;
  }
  return changed;
}

function mergeStateSnapshots(currentState, incomingState) {
  const merged = {
    ...currentState,
    ...incomingState
  };

  merged.offset = Math.max(Number(currentState.offset || 0), Number(incomingState.offset || 0));
  merged.queue = mergeQueueLists(currentState.queue || [], incomingState.queue || []);
  merged.pendingReplies = mergePendingReplyLists(currentState.pendingReplies || [], incomingState.pendingReplies || []);
  merged.replyOffsets = {
    ...(currentState.replyOffsets || {}),
    ...(incomingState.replyOffsets || {})
  };
  merged.replyBuffers = {
    ...(currentState.replyBuffers || {}),
    ...(incomingState.replyBuffers || {})
  };
  merged.lastInbound = syncRecordFromQueue(
    pickLatestRecord(currentState.lastInbound || null, incomingState.lastInbound || null),
    merged.queue
  );
  merged.lastOutbound = pickLatestRecord(currentState.lastOutbound || null, incomingState.lastOutbound || null);
  merged.lastUiNotice = pickLatestRecord(currentState.lastUiNotice || null, incomingState.lastUiNotice || null);
  merged.lastPollAt = pickIsoLater(currentState.lastPollAt, incomingState.lastPollAt);
  merged.lastInjectAt = pickIsoLater(currentState.lastInjectAt, incomingState.lastInjectAt);
  merged.currentThreadId = incomingState.currentThreadId || currentState.currentThreadId || "";
  return merged;
}

const IMAGE_EXTENSIONS = new Set([".avif", ".bmp", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

function sanitizeAttachmentName(name) {
  const raw = basename(String(name || "").replace(/\0/g, "")).replace(/\.\./g, "");
  const cleaned = raw.replace(/[^0-9A-Za-z._-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "telegram-file.bin";
}

function safePathPart(value) {
  return String(value || "")
    .replace(/[^0-9A-Za-z_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "telegram";
}

function isImageMimeOrName(mimeType, name) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) {
    return true;
  }
  return IMAGE_EXTENSIONS.has(extname(String(name || "")).toLowerCase());
}

function pickTelegramAttachment(message) {
  const messageId = String(message?.message_id || Date.now());
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length > 0) {
    const photo = [...photos].sort((left, right) => Number(left?.file_size || 0) - Number(right?.file_size || 0)).pop();
    if (photo?.file_id) {
      return {
        kind: "photo",
        fileId: String(photo.file_id),
        fileUniqueId: String(photo.file_unique_id || ""),
        originalName: `telegram-photo-${messageId}.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: Number(photo.file_size || 0),
        isImage: true
      };
    }
  }

  const document = message?.document;
  if (document?.file_id) {
    const originalName = String(document.file_name || `telegram-document-${messageId}`);
    const mimeType = String(document.mime_type || "application/octet-stream");
    return {
      kind: "document",
      fileId: String(document.file_id),
      fileUniqueId: String(document.file_unique_id || ""),
      originalName,
      mimeType,
      sizeBytes: Number(document.file_size || 0),
      isImage: isImageMimeOrName(mimeType, originalName)
    };
  }

  const video = message?.video || message?.animation;
  if (video?.file_id) {
    const mimeType = String(video.mime_type || "video/mp4");
    return {
      kind: message?.animation ? "animation" : "video",
      fileId: String(video.file_id),
      fileUniqueId: String(video.file_unique_id || ""),
      originalName: String(video.file_name || `telegram-video-${messageId}.mp4`),
      mimeType,
      sizeBytes: Number(video.file_size || 0),
      isImage: false
    };
  }

  return null;
}

async function stageTelegramAttachment(config, inbound) {
  if (!inbound?.attachment?.fileId) {
    delete inbound.attachment;
    return;
  }

  const attachment = inbound.attachment;
  const maxBytes = Math.max(Number(config.attachmentMaxBytes || 0), 1);
  try {
    const file = await getFileInfo(config, attachment.fileId);
    if (!file?.file_path) {
      throw new Error("Telegram returned no file path");
    }

    const fileSize = Number(file.file_size || attachment.sizeBytes || 0);
    if (fileSize > maxBytes) {
      throw new Error(`file too large (${Math.round(fileSize / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }

    const buffer = await downloadFileBuffer(config, file.file_path);
    if (buffer.byteLength > maxBytes) {
      throw new Error(`file too large (${Math.round(buffer.byteLength / 1024 / 1024)} MB, max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }

    const fallbackName = basename(file.file_path) || attachment.originalName || "telegram-file.bin";
    const originalName = attachment.originalName || fallbackName;
    const safeName = sanitizeAttachmentName(originalName.includes(".") ? originalName : fallbackName);
    const dir = join(
      config.paths.attachmentsDir,
      `${safePathPart(inbound.chatId)}_${safePathPart(inbound.messageId)}`
    );
    mkdirSync(dir, { recursive: true });
    const localPath = join(dir, safeName);
    writeFileSync(localPath, buffer);

    inbound.attachments = [{
      ...attachment,
      originalName,
      safeName,
      sizeBytes: buffer.byteLength,
      telegramFilePath: file.file_path,
      localPath,
      isImage: Boolean(attachment.isImage || isImageMimeOrName(attachment.mimeType, safeName))
    }];
    appendLog(config.paths.activityFile, `ATTACHMENT_SAVED chat=${inbound.chatId} message=${inbound.messageId} file=${safeName} bytes=${buffer.byteLength}`);
  } catch (error) {
    inbound.attachments = [{
      ...attachment,
      error: String(error?.message || error)
    }];
    appendLog(config.paths.activityFile, `ATTACHMENT_ERROR chat=${inbound.chatId} message=${inbound.messageId}: ${String(error?.message || error)}`);
  } finally {
    delete inbound.attachment;
  }
}

function normalizeInbound(message) {
  const text = message.text ?? message.caption ?? "";
  const chatType = String(message.chat?.type || "unknown");
  const telegramThreadId = message.message_thread_id ? String(message.message_thread_id) : "";
  const chatId = String(message.chat.id);
  return {
    chatId,
    messageId: String(message.message_id),
    replyToMessageId: message.reply_to_message ? String(message.reply_to_message.message_id) : "",
    telegramThreadId,
    chatType,
    senderIsBot: Boolean(message.from?.is_bot),
    conversationKey: chatType === "private"
      ? `${chatId}:dm`
      : `${chatId}:${telegramThreadId || "root"}`,
    groupTitle: message.chat?.title || "",
    user: message.from?.username || message.from?.first_name || "unknown",
    userId: message.from?.id ? String(message.from.id) : "",
    text,
    attachment: pickTelegramAttachment(message),
    ts: nowIso(),
    intent: "message",
    relevance: "ambient",
    status: "queued",
    attempts: 0,
    lastAttemptAt: null
  };
}

function buildContinueContext(state, inbound) {
  const sameConversation = (entry) => String(entry?.conversationKey || "").trim() === String(inbound?.conversationKey || "").trim();
  const recentEntries = [
    ...(state.queue || []),
    ...(state.pendingReplies || [])
  ].filter((entry) => {
    if (!entry || entry.senderIsBot) {
      return false;
    }
    if (!sameConversation(entry)) {
      return false;
    }
    const ageMs = isoAgeMs(entry.ts || entry.createdAt || entry.deliveredAt || entry.lastAttemptAt || "");
    return ageMs <= 1000 * 60 * 60 * 6;
  });

  const lastUserWorkEntry = [...recentEntries]
    .reverse()
    .find((entry) => String(entry.intent || "").trim().toLowerCase() !== "continue_nudge");

  return {
    conversationKey: inbound?.conversationKey || "",
    recentEntries,
    lastUserWorkText: lastUserWorkEntry?.text || lastUserWorkEntry?.sourceText || "",
    hasPendingReplies: (state.pendingReplies || []).some((entry) => {
      if (!entry || entry.senderIsBot || entry.sentAt) {
        return false;
      }
      return sameConversation(entry);
    })
  };
}

function looksLikeMnemoIdleLoopBrief(text) {
  const value = String(text || "").trim();
  if (!value) {
    return false;
  }
  if (/^Mnemo Idle #\d+:/i.test(value)) {
    return true;
  }
  return /^---\s*BRIEF\b[\s\S]*\bfrom=mnemo-idle-loop\b[\s\S]*\[IDLE-CYCLE\]/i.test(value);
}

function normalizeTelegramThreadId(value) {
  return String(value || "").trim();
}

function isAllowedChat(config, inbound) {
  const allowed = Array.isArray(config.allowedChatIds) ? config.allowedChatIds : [];
  if (allowed.length === 0) {
    return true;
  }
  const chatId = String(inbound?.chatId || inbound || "").trim();
  const userId = String(inbound?.userId || "").trim();
  return allowed.includes(chatId) || (userId && allowed.includes(userId));
}

function splitTelegramText(text, maxLength = 3500) {
  const value = String(text || "").trim();
  if (!value) {
    return [];
  }
  if (value.length <= maxLength) {
    return [value];
  }

  const chunks = [];
  let remaining = value;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n\n", maxLength);
    if (cut < 0 || cut < maxLength * 0.5) {
      cut = remaining.lastIndexOf("\n", maxLength);
    }
    if (cut < 0 || cut < maxLength * 0.5) {
      cut = remaining.lastIndexOf(" ", maxLength);
    }
    if (cut < 0 || cut < maxLength * 0.5) {
      cut = maxLength;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks.filter(Boolean);
}

function shouldSendDeferredReceipt(config, entry, reason) {
  if (!config?.queueNoticeEnabled) {
    return false;
  }
  if (!entry) {
    return false;
  }
  if (entry.senderIsBot) {
    return false;
  }
  if (entry.intent === "continue_nudge") {
    return false;
  }
  if (entry.queueNoticeSentAt) {
    return false;
  }
  if (!["pending_reply", "session_active"].includes(String(reason || ""))) {
    return false;
  }
  const relevance = String(entry.relevance || "").toLowerCase();
  const chatType = String(entry.chatType || "").toLowerCase();
  return chatType === "private" || relevance === "direct" || relevance === "lane";
}

function shouldSendTypingIndicator(entry) {
  if (!entry || entry.senderIsBot) {
    return false;
  }
  const relevance = String(entry.relevance || "").toLowerCase();
  const chatType = String(entry.chatType || "").toLowerCase();
  return chatType === "private" || relevance === "direct" || relevance === "lane";
}

function buildDeferredReceiptText(entry) {
  const chatType = String(entry?.chatType || "").toLowerCase();
  const user = String(entry?.user || "").trim();
  if (chatType === "private") {
    return "Ich habe deine Nachricht. Ich ziehe sie nach dem aktuellen Lauf.";
  }
  if (user) {
    return `Alles klar ${user}, ich habe deine Nachricht. Ich ziehe sie nach dem aktuellen Lauf.`;
  }
  return "Ich habe die Nachricht. Ich ziehe sie nach dem aktuellen Lauf.";
}

function buildProgressFallbackText(entry) {
  const chatType = String(entry?.chatType || "").toLowerCase();
  const user = String(entry?.user || "").trim();
  if (chatType === "private") {
    return "Ich arbeite noch daran und melde den naechsten konkreten Stand hier.";
  }
  if (user) {
    return `${user}, ich arbeite noch daran und melde den naechsten konkreten Stand hier.`;
  }
  return "Ich arbeite noch daran und melde den naechsten konkreten Stand hier.";
}

function hasRecentSessionWrite(entry, sessionPath, activeWindowMs = 15000) {
  if (!entry?.createdAt || !sessionPath || !existsSync(sessionPath)) {
    return false;
  }
  try {
    const modifiedAt = statSync(sessionPath).mtimeMs;
    const createdAt = Date.parse(entry.createdAt);
    if (!Number.isFinite(createdAt) || modifiedAt < createdAt) {
      return false;
    }
    return Date.now() - modifiedAt <= activeWindowMs;
  } catch {
    return false;
  }
}

function shouldSendFallbackProgress(config, entry, sessionPath) {
  if (!entry || entry.senderIsBot) {
    return false;
  }
  const fallbackMs = Math.max(Number(config.progressFallbackMs || 0), 0);
  if (fallbackMs <= 0 || isoAgeMs(entry.createdAt) < fallbackMs) {
    return false;
  }

  const intent = String(entry.intent || "").trim().toLowerCase();
  const relevance = String(entry.relevance || "").trim().toLowerCase();
  const sourceText = entry.sourceText || entry.text || "";
  const looksLikeWork = intent === "continue_nudge"
    || relevance === "escalation"
    || looksLikeWorkContextText(sourceText);
  if (!looksLikeWork) {
    return false;
  }

  return hasRecentSessionWrite(entry, sessionPath);
}

function shouldSendProgressUpgrade(entry, progress) {
  if (!entry || !progress) {
    return false;
  }
  if (String(entry.progressMode || "").trim().toLowerCase() !== "fallback") {
    return false;
  }
  if (entry.progressUpgradeSentAt) {
    return false;
  }
  const progressText = normalizeWhitespace(repairMojibake(progress.message || ""));
  if (!progressText) {
    return false;
  }
  const fallbackText = normalizeWhitespace(repairMojibake(entry.progressPreview || ""));
  if (!fallbackText || progressText === fallbackText) {
    return false;
  }
  if (looksLikeAckOnly(progressText) || looksLikeContextRequestOnly(progressText)) {
    return false;
  }
  return true;
}

function getProgressRelayMode(config) {
  const mode = String(config?.progressRelayMode || "status").trim().toLowerCase();
  if (["off", "status", "commentary"].includes(mode)) {
    return mode;
  }
  return "status";
}

function getPendingReplyActivityAt(entry) {
  if (!entry || typeof entry !== "object") {
    return "";
  }
  return String(
    entry.lastSignalAt
    || entry.progressSentAt
    || entry.sentAt
    || entry.createdAt
    || ""
  ).trim();
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function repairMojibake(text) {
  const value = String(text || "");
  if (!/[ÃƒÃ¢ï¿½]/.test(value)) {
    return value;
  }

  try {
    const repaired = Buffer.from(value, "latin1").toString("utf8");
    if (repaired && !/\u0000/.test(repaired)) {
      return repaired;
    }
  } catch {
    // Fall through to targeted replacements.
  }

  return value
    .replace(/Ã¢â‚¬â€/g, "-")
    .replace(/Ã¢â‚¬â€œ/g, "-")
    .replace(/Ã¢â‚¬Å¾|Ã¢â‚¬Å“|Ã¢â‚¬Â/g, "\"")
    .replace(/Ã¢â‚¬â„¢|Ã¢â‚¬Ëœ/g, "'")
    .replace(/Ã¢â‚¬Â¦/g, "...")
    .replace(/Ã¢â€šÂ¬/g, "EUR")
    .replace(/Ãƒâ€ž/g, "Ã„")
    .replace(/Ãƒâ€“/g, "Ã–")
    .replace(/ÃƒÅ“/g, "Ãœ")
    .replace(/ÃƒÂ¤/g, "Ã¤")
    .replace(/ÃƒÂ¶/g, "Ã¶")
    .replace(/ÃƒÂ¼/g, "Ã¼")
    .replace(/ÃƒÅ¸/g, "ÃŸ");
}

function shouldPublishInboundUiNotice(entry) {
  if (!entry) {
    return false;
  }
  if (entry.senderIsBot) {
    return false;
  }
  const chatType = String(entry.chatType || "").toLowerCase();
  const relevance = String(entry.relevance || "").toLowerCase();
  return chatType === "private" || ["direct", "lane", "escalation"].includes(relevance);
}

function formatCompactInboundUiNotice(entry) {
  let text = normalizeWhitespace(repairMojibake(entry?.text || "")).slice(0, 180);
  if (!text && Array.isArray(entry?.attachments) && entry.attachments.length > 0) {
    const first = entry.attachments[0];
    text = first?.isImage ? "sendete einen Screenshot" : `sendete ${first?.originalName || "eine Datei"}`;
  } else if (!text && entry?.attachment) {
    text = entry.attachment.isImage ? "sendete einen Screenshot" : `sendete ${entry.attachment.originalName || "eine Datei"}`;
  }
  if (!text) {
    return "";
  }
  if (/^(brief von|mnemo idle #)/i.test(text)) {
    return text;
  }
  const user = String(entry?.user || "unknown").trim();
  const groupTitle = String(entry?.groupTitle || "").trim();
  const chatType = String(entry?.chatType || "").trim().toLowerCase();
  if (chatType === "private" || !groupTitle) {
    return `${user}: ${text}`;
  }
  return `${user} @ ${groupTitle}: ${text}`;
}

function findRecentOutboundForTurn(config, chatId, source, sourceTurnId, text = "") {
  if (!config?.paths?.outboxFile || !existsSync(config.paths.outboxFile)) {
    return null;
  }
  const normalizedChatId = String(chatId || "").trim();
  const normalizedSource = String(source || "").trim();
  const normalizedTurnId = String(sourceTurnId || "").trim();
  const normalizedText = normalizeWhitespace(repairMojibake(text || ""));
  if (!normalizedChatId || !normalizedSource || !normalizedTurnId) {
    return null;
  }

  const matches = [];
  for (const line of readTail(config.paths.outboxFile, 400).reverse()) {
    try {
      const item = JSON.parse(line);
      if (String(item?.chatId || "").trim() !== normalizedChatId) {
        continue;
      }
      if (String(item?.source || "").trim() !== normalizedSource) {
        continue;
      }
      if (String(item?.sourceTurnId || "").trim() !== normalizedTurnId) {
        continue;
      }
      if (normalizedText) {
        const itemText = normalizeWhitespace(repairMojibake(item?.text || ""));
        if (itemText !== normalizedText) {
          continue;
        }
      }
      matches.push(item);
    } catch {
      // Ignore malformed tail lines.
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => String(left?.ts || "").localeCompare(String(right?.ts || "")));
  return {
    outbound: matches[matches.length - 1],
    messageIds: matches.map((item) => String(item.messageId || "").trim()).filter(Boolean)
  };
}

async function maybeSendDeferredReceipt(config, state, entry, reason) {
  if (!shouldSendDeferredReceipt(config, entry, reason)) {
    return false;
  }

  try {
    await sendOutboundChunks(config, state, {
      chatId: entry.chatId,
      text: buildDeferredReceiptText(entry),
      replyToMessageId: entry.messageId,
      telegramThreadId: entry.telegramThreadId,
      source: "queue_notice"
    });
    entry.queueNoticeSentAt = nowIso();
    entry.queueNoticeReason = String(reason || "");
    state.lastQueueNoticeAt = entry.queueNoticeSentAt;
    appendLog(
      config.paths.activityFile,
      `QUEUE_NOTICE chat=${entry.chatId} message=${entry.messageId} reason=${entry.queueNoticeReason || "-"}`
    );
    return true;
  } catch (error) {
    appendLog(
      config.paths.activityFile,
      `QUEUE_NOTICE_ERROR chat=${entry.chatId} message=${entry.messageId} reason=${String(reason || "-")}: ${error}`
    );
    return false;
  }
}

function readJsonlDelta(path, offset, carry = "") {
  if (!path || !existsSync(path)) {
    return { nextOffset: 0, carry, items: [] };
  }

  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    const safeOffset = Math.max(0, Math.min(Number(offset || 0), stat.size));
    const byteLength = Math.max(0, stat.size - safeOffset);
    let chunk = "";
    if (byteLength > 0) {
      const buffer = Buffer.alloc(byteLength);
      readSync(fd, buffer, 0, byteLength, safeOffset);
      chunk = buffer.toString("utf8");
    }
    const combined = `${carry || ""}${chunk}`;
    const lines = combined.split(/\r?\n/);
    const trailingCarry = combined.endsWith("\n") ? "" : (lines.pop() || "");
    const items = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        items.push(JSON.parse(trimmed));
      } catch {
        // Keep moving; malformed partial lines are handled by carry.
      }
    }
    return {
      nextOffset: stat.size,
      carry: trailingCarry,
      items
    };
  } finally {
    closeSync(fd);
  }
}

async function resolveThreadSessionPath(config, threadId) {
  if (!threadId) {
    return "";
  }
  if (config.appServerWsUrl) {
    try {
      const readResult = await readThreadOverWs({
        wsUrl: config.appServerWsUrl,
        threadId,
        timeoutMs: 5000
      });
      return String(readResult.threadPath || "").trim();
    } catch {
      return "";
    }
  }
  return findRolloutFile(config.paths.sessionsDir, threadId) || "";
}

function countOpenPendingReplies(state, config) {
  const timeoutMs = getEffectivePendingReplyTimeoutMs(config);
  return (state.pendingReplies || []).filter((entry) => {
    if (!isNonTerminalPendingReply(entry)) {
      return false;
    }
    if (timeoutMs > 0 && isoAgeMs(entry.createdAt) >= timeoutMs) {
      return false;
    }
    return true;
  }).length;
}

async function resolveSessionActivity(config, threadId, entry = null) {
  const sessionPath = await resolveThreadSessionPath(config, threadId);
  const cooldownMs = getEffectiveIdleCooldownMs(config, entry);
  if (!sessionPath || !existsSync(sessionPath)) {
    return {
      sessionPath,
      quietMs: Number.POSITIVE_INFINITY,
      active: false,
      cooldownMs
    };
  }

  const quietMs = Math.max(0, Date.now() - statSync(sessionPath).mtimeMs);
  return {
    sessionPath,
    quietMs,
    active: quietMs < cooldownMs,
    cooldownMs
  };
}

function buildPendingReplyEntry(message, threadId, turnId, sessionPath, sessionOffset) {
  return {
    turnId: String(turnId || "").trim(),
    threadId: String(threadId || "").trim(),
    sessionPath: String(sessionPath || "").trim(),
    sessionOffset: Number(sessionOffset || 0),
    chatId: String(message.chatId || "").trim(),
    messageId: String(message.messageId || "").trim(),
    replyToMessageId: String(message.messageId || "").trim(),
    telegramThreadId: normalizeTelegramThreadId(message.telegramThreadId),
    chatType: String(message.chatType || "").trim(),
    senderIsBot: Boolean(message.senderIsBot),
    conversationKey: String(message.conversationKey || "").trim(),
    groupTitle: String(message.groupTitle || "").trim(),
    user: String(message.user || "").trim(),
    sourceText: String(message.text || ""),
    intent: String(message.intent || "message").trim(),
    createdAt: nowIso(),
    status: "pending",
    sentAt: null,
    responsePreview: "",
    responseMessageIds: []
  };
}

function shouldTrackPendingReply(message) {
  if (!message) {
    return false;
  }
  if (looksLikeBotSender(message)) {
    return false;
  }
  return String(message.intent || "message").trim().toLowerCase() !== "continue_nudge";
}

function parseUnixSeconds(isoString) {
  const millis = Date.parse(isoString || "");
  if (Number.isNaN(millis)) {
    return Math.floor(Date.now() / 1000);
  }
  return Math.floor(millis / 1000);
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

function getRuntimeOwner(config) {
  if (!config.paths.currentRuntimeFile || !existsSync(config.paths.currentRuntimeFile)) {
    return null;
  }
  const runtime = loadJson(config.paths.currentRuntimeFile, null);
  if (!runtime) {
    return null;
  }
  if (config.appServerWsUrl && runtime.ws_url && String(runtime.ws_url).trim() !== String(config.appServerWsUrl).trim()) {
    return null;
  }
  const frontendHostPid = Number.parseInt(String(runtime.frontend_host_pid || "0"), 10) || 0;
  return {
    runtime,
    frontendHostPid,
    frontendAlive: isPidAlive(frontendHostPid)
  };
}

function normalizeThreadTimestampMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return numeric > 100000000000 ? numeric : numeric * 1000;
}

function parseRuntimeStartedAtMs(runtime) {
  const parsed = Date.parse(String(runtime?.started_at || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildHistoryText(message) {
  let text = String(message.text || "").trim();
  if (!text && Array.isArray(message.attachments) && message.attachments.length > 0) {
    const first = message.attachments[0];
    text = first?.isImage ? "[Telegram screenshot]" : `[Telegram file: ${first?.originalName || "attachment"}]`;
  }
  const chatType = String(message.chatType || "");
  if (chatType === "private" || !chatType) {
    return text;
  }

  const title = String(message.groupTitle || message.chatId || "group").trim();
  const actor = String(message.user || "unknown").trim();
  const threadSuffix = message.telegramThreadId ? ` / thread ${message.telegramThreadId}` : "";
  return `[Telegram ${title}${threadSuffix} @${actor}] ${text}`;
}

function appendHistoryEntry(config, threadId, message) {
  if (!config.paths.historyFile || !threadId) {
    return null;
  }

  const text = buildHistoryText(message);
  if (!text) {
    return null;
  }

  const entry = {
    session_id: threadId,
    ts: parseUnixSeconds(message.ts),
    text
  };
  appendJsonl(config.paths.historyFile, entry);
  return entry;
}

function findRolloutFile(sessionsDir, threadId) {
  if (!sessionsDir || !threadId || !existsSync(sessionsDir)) {
    return null;
  }

  const stack = [sessionsDir];
  const matches = [];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith(".jsonl") || !entry.name.includes(threadId)) {
        continue;
      }
      matches.push({
        path: absolutePath,
        mtimeMs: statSync(absolutePath).mtimeMs
      });
    }
  }

  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.path || null;
}

function hasVisibleInboundSubmission(config, threadId, message) {
  const rolloutPath = findRolloutFile(config.paths.sessionsDir, threadId);
  if (!rolloutPath) {
    return false;
  }

  const rolloutText = readFileSync(rolloutPath, "utf8");
  return rolloutText.includes(`Chat ID: ${message.chatId}`)
    && rolloutText.includes(`Message ID: ${message.messageId}`)
    && rolloutText.includes(`Timestamp: ${message.ts}`);
}

function promoteVisibleQueuedEntry(config, state, threadId, message) {
  if (!message?.historyLoggedAt || message.status !== "queued") {
    return false;
  }
  if (!hasVisibleInboundSubmission(config, threadId, message)) {
    return false;
  }

  message.status = "submitted";
  message.submittedAt = message.submittedAt || nowIso();
  message.threadId = threadId;
  appendLog(config.paths.activityFile, `INJECT_SUBMITTED thread=${threadId} message=${message.messageId}`);
  state.lastInjectAt = nowIso();
  return true;
}

async function resolveActiveThreadId(config, state, preferredThreadId, options = {}) {
  const fallbackThreadId = String(preferredThreadId || config.currentThreadId || state.currentThreadId || "").trim();
  if (!config.appServerWsUrl) {
    return fallbackThreadId;
  }

  try {
    const loaded = await listLoadedThreadsOverWs({
      wsUrl: config.appServerWsUrl,
      timeoutMs: 5000
    });
    const loadedIds = Array.isArray(loaded?.data) ? loaded.data.map((value) => String(value || "").trim()).filter(Boolean) : [];
    if (loadedIds.length === 0) {
      return fallbackThreadId;
    }

    const runtimeOwner = getRuntimeOwner(config);
    const runtimeThreadId = String(runtimeOwner?.runtime?.thread_id || "").trim();
    const runtimeStartedAtMs = parseRuntimeStartedAtMs(runtimeOwner?.runtime);
    const pinnedThreadId = String(preferredThreadId || config.currentThreadId || runtimeThreadId || "").trim();
    if (options.forcePreferred && pinnedThreadId && loadedIds.includes(pinnedThreadId)) {
      if (state.currentThreadId !== pinnedThreadId) {
        state.currentThreadId = pinnedThreadId;
        saveStateForConfig(config, state);
        appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD_PINNED thread=${pinnedThreadId}`);
      }
      persistActiveThreadBinding(config, pinnedThreadId);
      return pinnedThreadId;
    }

    let bestThreadId = loadedIds[loadedIds.length - 1];
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidateThreadId of loadedIds) {
      let score = 0;
      try {
        const readResult = await readThreadOverWs({
          wsUrl: config.appServerWsUrl,
          threadId: candidateThreadId,
          timeoutMs: 5000
        });
        const thread = readResult?.response?.result?.thread || {};
        const createdAtMs = normalizeThreadTimestampMs(thread.createdAt);
        if (createdAtMs > 0) {
          score = createdAtMs;
        }
        const source = String(thread.source || "").toLowerCase();
        const statusType = String(thread.status?.type || "").toLowerCase();
        if (source === "cli" && statusType === "active") {
          score += 4000000000000000;
        } else if (statusType === "active") {
          score += 3000000000000000;
        } else if (source === "cli") {
          score += 2000000000000000;
        }
        if (runtimeStartedAtMs > 0 && createdAtMs >= runtimeStartedAtMs - 120000) {
          score += 1000000000000000;
        }
        const sessionPath = String(thread.path || "").trim();
        if (sessionPath && existsSync(sessionPath)) {
          score = Math.max(score, statSync(sessionPath).birthtimeMs || 0);
        }
      } catch {
        score = 0;
      }

      if (score >= bestScore) {
        bestScore = score;
        bestThreadId = candidateThreadId;
      }
    }

    if (state.currentThreadId !== bestThreadId) {
      state.currentThreadId = bestThreadId;
      saveStateForConfig(config, state);
      appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD thread=${bestThreadId}`);
    }
    persistActiveThreadBinding(config, bestThreadId);
    return bestThreadId;
  } catch (error) {
    const message = String(error?.message || error).replace(/\s+/g, " ").slice(0, 180);
    appendLog(config.paths.activityFile, `REMOTE_ACTIVE_THREAD_ERROR ${message}`);
    return fallbackThreadId;
  }
}

export function bridgeStatus() {
  const config = loadConfig();
  const state = loadState(config);
  const runtimeOwner = getRuntimeOwner(config);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  const expiredPendingReplies = closeExpiredPendingRepliesInPlace(config, state.pendingReplies || []);
  if (expiredPendingReplies > 0 || parkedAmbient > 0) {
    if (parkedAmbient > 0) {
      appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    }
    saveStateForConfig(config, state);
  }
  const queued = state.queue.filter((item) => item.status === "queued");
  const submitted = state.queue.filter((item) => item.status === "submitted");
  const parked = state.queue.filter((item) => item.status === "parked");
  const ambient = queued.filter((item) => item.relevance === "ambient");
  const pendingReplies = (state.pendingReplies || []).filter((item) => isNonTerminalPendingReply(item));
  const expiredReplies = (state.pendingReplies || []).filter((item) => String(item.status || "") === "expired");
  return {
    agent: config.agentName,
    allowedChatId: config.allowedChatId || null,
    boundThreadId: config.currentThreadId || state.currentThreadId || null,
    frontendOwnerPid: runtimeOwner?.frontendHostPid || null,
    frontendOwnerAlive: runtimeOwner?.frontendAlive ?? null,
    dispatchMode: config.dispatchMode,
    groupDeliveryMode: config.groupDeliveryMode,
    idleCooldownMs: config.idleCooldownMs,
    pendingReplyTimeoutMs: config.pendingReplyTimeoutMs,
    queueDepth: queued.length,
    ambientQueueDepth: ambient.length,
    parkedQueueDepth: parked.length,
    submittedDepth: submitted.length,
    pendingReplyDepth: pendingReplies.length,
    expiredPendingReplyDepth: expiredReplies.length,
    progressRelayMode: getProgressRelayMode(config),
    lastInbound: state.lastInbound,
    lastOutbound: state.lastOutbound,
    lastPollAt: state.lastPollAt,
    lastInjectAt: state.lastInjectAt,
    stateDir: config.paths.root,
    note: "Telegram first lands in queue. By default group delivery is all, so public/single-agent bridges pass group messages to the visible agent. Set BLUN_TELEGRAM_GROUP_DELIVERY=mentions for strict multi-agent routing."
  };
}

async function sendOutboundChunks(config, state, options) {
  const chatId = String(options.chatId || "").trim();
  const text = String(options.text || "").trim();
  const replyToMessageId = String(options.replyToMessageId || "").trim();
  const telegramThreadId = normalizeTelegramThreadId(options.telegramThreadId);
  const source = String(options.source || "manual").trim();
  const sourceTurnId = String(options.sourceTurnId || "").trim();
  if (!chatId) {
    throw new Error("No chat id available for Telegram outbound.");
  }
  if (!text) {
    throw new Error("Outbound Telegram text is empty.");
  }

  if ((source === "auto" || source === "auto_progress") && sourceTurnId) {
    const existing = findRecentOutboundForTurn(config, chatId, source, sourceTurnId, text);
    if (existing?.outbound) {
      state.lastOutbound = existing.outbound;
      appendLog(
        config.paths.activityFile,
        `OUT_AUTO_SKIP_DUP chat=${chatId} reply_to=${replyToMessageId || "-"} turn=${sourceTurnId} outbound=${existing.messageIds.join(",")}`
      );
      return {
        ok: true,
        outbound: existing.outbound,
        messageIds: existing.messageIds,
        skippedDuplicate: true
      };
    }
  }

  const chunks = splitTelegramText(text);
  const messageIds = [];
  let lastOutbound = null;

  const contextEntry = [
    ...(state.queue || []),
    ...(state.pendingReplies || [])
  ].find((entry) => {
    if (String(entry.chatId || "").trim() !== chatId) {
      return false;
    }
    if (replyToMessageId && String(entry.messageId || entry.replyToMessageId || "").trim() === replyToMessageId) {
      return true;
    }
    if (telegramThreadId && String(entry.telegramThreadId || "").trim() === telegramThreadId) {
      return true;
    }
    return false;
  }) || null;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const result = await sendMessage(config, {
      chatId,
      text: chunk,
      replyToMessageId: index === 0 ? replyToMessageId : "",
      telegramThreadId
    });
    const outbound = {
      chatId,
      messageId: String(result.message_id),
      replyToMessageId: index === 0 ? replyToMessageId : "",
      telegramThreadId: telegramThreadId || null,
      text: chunk,
      ts: nowIso(),
      source,
      sourceTurnId: sourceTurnId || null
    };
    state.lastOutbound = outbound;
    appendJsonl(config.paths.outboxFile, outbound);
    appendLog(config.paths.activityFile, `OUT_${source.toUpperCase()} chat=${chatId} reply_to=${outbound.replyToMessageId || "-"} thread=${telegramThreadId || "-"} message=${outbound.messageId}: ${chunk.replace(/\s+/g, " ").slice(0, 180)}`);
    messageIds.push(outbound.messageId);
    lastOutbound = outbound;
  }

  if (lastOutbound) {
    try {
      const preview = (
        typeof normalizeWhitespace === "function"
          ? normalizeWhitespace(repairMojibake(lastOutbound.text))
          : String(lastOutbound.text || "")
            .replace(/\r/g, " ")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim()
      ).slice(0, 140);
      const groupTitle = String(contextEntry?.groupTitle || "").trim();
      const user = String(contextEntry?.user || "").trim();
      const chatType = String(contextEntry?.chatType || "").trim().toLowerCase();
      let label = "Antwort";
      if (groupTitle) {
        label = `Antwort @ ${groupTitle}`;
      } else if (chatType === "private" && user) {
        label = `Antwort an ${user}`;
      }
      state.lastOutboundUiNotice = {
        ts: nowIso(),
        kind: "outbound",
        text: `${label}: ${preview}`
      };
    } catch (error) {
      appendLog(config.paths.activityFile, `UI_NOTICE_ERROR chat=${chatId} reply_to=${replyToMessageId || "-"}: ${error}`);
    }
  }

  return {
    ok: true,
    outbound: lastOutbound,
    messageIds
  };
}

export function bindCurrentThread(threadId) {
  const config = loadConfig();
  const state = loadState(config);
  const resolved = (threadId || process.env.CODEX_THREAD_ID || config.currentThreadId || "").trim();
  if (!resolved) {
    throw new Error("No thread id provided and CODEX_THREAD_ID is not available.");
  }
  state.currentThreadId = resolved;
  saveStateForConfig(config, state);
  appendLog(config.paths.activityFile, `BOUND thread=${resolved}`);
  return {
    ok: true,
    threadId: resolved
  };
}

export async function pollOnce() {
  const config = loadConfig();
  const state = loadState(config);
  const parkedAmbientAtStart = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  if (parkedAmbientAtStart > 0) {
    appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbientAtStart}`);
  }
  const startOffset = Number(state.offset || 0);
  const updates = await getUpdates(config, startOffset);
  let captured = 0;
  let ignored = 0;

  for (const update of updates) {
    state.offset = Math.max(Number(state.offset || 0), Number(update.update_id) + 1);
    if (!update.message) {
      ignored += 1;
      continue;
    }
    const inbound = normalizeInbound(update.message);
    if (!isAllowedChat(config, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED chat=${inbound.chatId} user=${inbound.userId || "-"} message=${inbound.messageId}`);
      continue;
    }
    if (String(inbound.chatType || "") === "private" && looksLikeMnemoIdleLoopBrief(inbound.text)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_IDLE_BRIEF chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    if (!inbound.text.trim() && !inbound.attachment) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_EMPTY chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    const continueContext = buildContinueContext(state, inbound);
    inbound.intent = looksLikeContinueNudge(inbound.text, continueContext) ? "continue_nudge" : "message";
    inbound.relevance = classifyInboundRelevance(config, inbound);
    if (hasKnownInboundMessage(state, inbound)) {
      ignored += 1;
      appendLog(config.paths.activityFile, `IGNORED_DUPLICATE chat=${inbound.chatId} message=${inbound.messageId}`);
      continue;
    }
    if (String(inbound.chatType || "") !== "private" && String(inbound.relevance || "") === "ambient") {
      ignored += 1;
      appendJsonl(config.paths.inboxFile, { ...inbound, status: "ignored_ambient" });
      appendLog(config.paths.activityFile, `IGNORED_AMBIENT chat=${inbound.chatId} message=${inbound.messageId} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
      continue;
    }
    if (shouldSendTypingIndicator(inbound)) {
      void sendChatAction(config, {
        chatId: inbound.chatId,
        telegramThreadId: inbound.telegramThreadId
      }).catch(() => {});
    }
    await stageTelegramAttachment(config, inbound);
    state.queue.push(inbound);
    state.lastInbound = inbound;
    if (shouldPublishInboundUiNotice(inbound)) {
      state.lastUiNotice = {
        ts: nowIso(),
        kind: "inbound",
        text: formatCompactInboundUiNotice(inbound)
      };
    }
    appendJsonl(config.paths.inboxFile, inbound);
    appendLog(config.paths.activityFile, `IN chat=${inbound.chatId} message=${inbound.messageId} relevance=${inbound.relevance} user=${inbound.user}: ${inbound.text.replace(/\s+/g, " ").slice(0, 180)}`);
    captured += 1;
  }

  state.lastPollAt = nowIso();
  const latestState = loadState(config);
  saveStateForConfig(config, mergeStateSnapshots(latestState, state));
  return {
    ok: true,
    startOffset,
    nextOffset: state.offset,
    captured,
    ignored
  };
}

export function listQueue(limit = 10) {
  const config = loadConfig();
  const state = loadState(config);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  if (parkedAmbient > 0) {
    appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    saveStateForConfig(config, state);
  }
  return state.queue.slice(-Math.max(1, limit));
}

function getQueuedDispatchPriority(item) {
  if (!item || item.status !== "queued") {
    return Number.MAX_SAFE_INTEGER;
  }
  const relevance = String(item.relevance || "").toLowerCase();
  const chatType = String(item.chatType || "").toLowerCase();
  if (relevance === "escalation") {
    return 0;
  }
  if (isFastDispatchEntry(item)) {
    return 1;
  }
  if (chatType === "private" || relevance === "direct" || relevance === "lane") {
    return 2;
  }
  return 3;
}

function compareQueuedDispatchOrder(left, right) {
  const priorityDiff = getQueuedDispatchPriority(left) - getQueuedDispatchPriority(right);
  if (priorityDiff !== 0) {
    return priorityDiff;
  }
  const leftTs = String(left?.ts || "");
  const rightTs = String(right?.ts || "");
  if (leftTs !== rightTs) {
    return leftTs.localeCompare(rightTs);
  }
  const leftMessage = Number.parseInt(String(left?.messageId || "0"), 10);
  const rightMessage = Number.parseInt(String(right?.messageId || "0"), 10);
  if (Number.isFinite(leftMessage) && Number.isFinite(rightMessage) && leftMessage !== rightMessage) {
    return leftMessage - rightMessage;
  }
  return String(left?.messageId || "").localeCompare(String(right?.messageId || ""));
}

function selectNextQueuedEntry(queue, options = {}) {
  const auto = Boolean(options.auto);
  const deferredMode = String(options.dispatchMode || "deferred").toLowerCase() !== "legacy";
  const queued = Array.isArray(queue) ? queue.filter((item) => item?.status === "queued") : [];
  if (!auto || !deferredMode) {
    return queued.sort(compareQueuedDispatchOrder)[0] || null;
  }
  const eligible = queued.filter((item) => {
    const relevance = String(item.relevance || "").toLowerCase();
    const chatType = String(item.chatType || "").toLowerCase();
    return relevance === "escalation" || chatType === "private" || relevance === "direct" || relevance === "lane";
  });
  return eligible.sort(compareQueuedDispatchOrder)[0] || null;
}

function isFastDispatchEntry(entry) {
  if (!entry) {
    return false;
  }
  if (String(entry.intent || "").trim().toLowerCase() === "continue_nudge") {
    return true;
  }
  return false;
}

function isRealtimeAppServerEntry(entry) {
  if (!entry) {
    return false;
  }
  const relevance = String(entry.relevance || "").trim().toLowerCase();
  const chatType = String(entry.chatType || "").trim().toLowerCase();
  return chatType === "private" || relevance === "direct" || relevance === "lane";
}

function isGroupChatEntry(entry) {
  const chatType = String(entry?.chatType || "").trim().toLowerCase();
  return chatType === "group" || chatType === "supergroup";
}

export async function injectNext(threadId, options = {}) {
  const config = loadConfig();
  const state = loadState(config);
  const reclassified = reclassifyQueuedEntriesInPlace(config, state.queue || []);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  const runtimeOwner = getRuntimeOwner(config);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  const expiredPendingReplies = closeExpiredPendingRepliesInPlace(config, state.pendingReplies || []);
  if (expiredPendingReplies > 0 || parkedAmbient > 0 || reclassified.changed > 0) {
    if (reclassified.changed > 0) {
      appendLog(config.paths.activityFile, `QUEUE_RECLASSIFIED changed=${reclassified.changed} parked=${reclassified.parked}`);
    }
    if (parkedAmbient > 0) {
      appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    }
    appendLog(config.paths.activityFile, `PENDING_REPLY_EXPIRED count=${expiredPendingReplies}`);
    saveStateForConfig(config, state);
  }
  const auto = Boolean(options.auto);
  const useAppServer = Boolean(config.appServerWsUrl);
  if (auto && useAppServer && runtimeOwner && !runtimeOwner.frontendAlive) {
    appendLog(config.paths.activityFile, `OWNER_OFFLINE frontend_pid=${runtimeOwner.frontendHostPid || 0}`);
    return {
      ok: false,
      status: "deferred",
      reason: "owner_offline",
      frontendHostPid: runtimeOwner.frontendHostPid || 0
    };
  }

  const next = selectNextQueuedEntry(state.queue || [], {
    auto,
    dispatchMode: config.dispatchMode
  });

  if (!next) {
    return {
      ok: true,
      status: auto ? "deferred" : "empty",
      reason: auto ? "no_eligible_message" : undefined
    };
  }

  if (shouldAckOnlyAddressPing() && isAddressOnlyPing(config, next.text) && !looksLikeBotSender(next) && !isGroupChatEntry(next)) {
    next.status = "delivered";
    next.deliveredAt = nowIso();
    next.threadId = null;
    next.turnId = null;
    next.responsePreview = "plugin_ping_ack";
    next.stderr = null;
    next.stdout = null;
    markMatchingQueueEntriesInPlace(state, next, {
      status: next.status,
      deliveredAt: next.deliveredAt,
      threadId: next.threadId,
      turnId: next.turnId,
      responsePreview: next.responsePreview,
      stderr: next.stderr,
      stdout: next.stdout
    });
    appendLog(config.paths.activityFile, `PING_ACK chat=${next.chatId} message=${next.messageId}`);
    await sendOutboundChunks(config, state, {
      chatId: next.chatId,
      text: "Ja, ich bin da.",
      replyToMessageId: next.messageId,
      telegramThreadId: next.telegramThreadId,
      source: "ping_ack"
    });
    const latestState = loadState(config);
    saveStateForConfig(config, mergeStateSnapshots(latestState, state));
    return {
      ok: true,
      status: "delivered",
      reason: "ping_ack",
      message: next
    };
  }

  const explicitThreadId = String(threadId || "").trim();
  const preferredThreadId = (
    threadId
    || (useAppServer ? config.currentThreadId : state.currentThreadId)
    || (useAppServer ? state.currentThreadId : config.currentThreadId)
    || ""
  ).trim();
  const resolvedThreadId = await resolveActiveThreadId(config, state, preferredThreadId, {
    forcePreferred: Boolean(explicitThreadId)
  });
  if (!resolvedThreadId) {
    throw new Error("No bound thread id. Use bridge_bind_current_thread first.");
  }
  const staleThreadPendingReplies = closeStaleThreadPendingRepliesInPlace(state.pendingReplies || [], resolvedThreadId);
  if (staleThreadPendingReplies > 0) {
    appendLog(config.paths.activityFile, `PENDING_REPLY_STALE_THREAD count=${staleThreadPendingReplies} active_thread=${resolvedThreadId}`);
    saveStateForConfig(config, state);
  }

  const bypassDeferredGate = auto && (
    next.relevance === "escalation"
    || isFastDispatchEntry(next)
    || (useAppServer && isRealtimeAppServerEntry(next))
  );
  if (bypassDeferredGate && auto && isFastDispatchEntry(next)) {
    appendLog(config.paths.activityFile, `FAST_TRIGGER_BYPASS chat=${next.chatId} message=${next.messageId} intent=${next.intent}`);
  }
  if (bypassDeferredGate && auto && useAppServer && isRealtimeAppServerEntry(next) && !isFastDispatchEntry(next)) {
    appendLog(config.paths.activityFile, `REALTIME_BYPASS chat=${next.chatId} message=${next.messageId} relevance=${next.relevance || "-"} chat_type=${next.chatType || "-"}`);
  }
  if (auto && !bypassDeferredGate && String(config.dispatchMode || "deferred").toLowerCase() !== "legacy") {
    const openPendingReplies = countOpenPendingReplies(state, config);
    if (openPendingReplies > 0) {
      await maybeSendDeferredReceipt(config, state, next, "pending_reply");
      saveStateForConfig(config, state);
      return {
        ok: false,
        status: "deferred",
        reason: "pending_reply",
        pendingReplies: openPendingReplies
      };
    }

    const sessionActivity = await resolveSessionActivity(config, resolvedThreadId, next);
    if (sessionActivity.active) {
      await maybeSendDeferredReceipt(config, state, next, "session_active");
      saveStateForConfig(config, state);
      return {
        ok: false,
        status: "deferred",
        reason: "session_active",
        quietMs: sessionActivity.quietMs,
        readyInMs: Math.max(0, Number(sessionActivity.cooldownMs || 0) - Number(sessionActivity.quietMs || 0))
      };
    }
  }

  let promoted = 0;
  if (!useAppServer) {
    for (const entry of state.queue) {
      if (promoteVisibleQueuedEntry(config, state, resolvedThreadId, entry)) {
        promoted += 1;
      }
    }
  }
  if (promoted > 0) {
    saveStateForConfig(config, state);
  }

  next.attempts = Number(next.attempts || 0) + 1;
  next.lastAttemptAt = nowIso();
  let sessionPath = "";
  let sessionOffset = 0;
  if (useAppServer) {
    sessionPath = await resolveThreadSessionPath(config, resolvedThreadId);
    if (sessionPath && existsSync(sessionPath)) {
      sessionOffset = statSync(sessionPath).size;
    }
  }
  if (!useAppServer && !next.historyLoggedAt) {
    const historyEntry = appendHistoryEntry(config, resolvedThreadId, next);
    if (historyEntry) {
      next.historyLoggedAt = nowIso();
      next.historyText = historyEntry.text;
      appendLog(config.paths.activityFile, `HISTORY_APPEND thread=${resolvedThreadId} message=${next.messageId}`);
    }
  }
  saveStateForConfig(config, state);
  appendLog(config.paths.activityFile, `INJECT_START thread=${resolvedThreadId} message=${next.messageId}`);
  const result = await injectIntoThread(config, next, resolvedThreadId);
  if (result.busy) {
    const promotedThisAttempt = useAppServer ? false : promoteVisibleQueuedEntry(config, state, resolvedThreadId, next);
    appendLog(config.paths.activityFile, `INJECT_BUSY thread=${resolvedThreadId} message=${next.messageId}`);
    const latestState = loadState(config);
    saveStateForConfig(config, mergeStateSnapshots(latestState, state));
    return {
      ok: false,
      status: promotedThisAttempt ? "submitted" : "busy",
      threadId: resolvedThreadId,
      message: next
    };
  }

  next.status = result.ok ? "delivered" : "error";
  next.deliveredAt = nowIso();
  next.threadId = resolvedThreadId;
  next.turnId = String(result.turnId || "").trim() || null;
  next.responsePreview = result.responseText.slice(0, 400);
  next.stderr = result.stderr.slice(0, 400);
  next.stdout = result.stdout.slice(0, 400);
  markMatchingQueueEntriesInPlace(state, next, {
    status: next.status,
    deliveredAt: next.deliveredAt,
    threadId: next.threadId,
    turnId: next.turnId,
    responsePreview: next.responsePreview,
    stderr: next.stderr,
    stdout: next.stdout
  });
  if (useAppServer && result.ok) {
    if (!shouldTrackPendingReply(next)) {
      appendLog(config.paths.activityFile, `REPLY_SKIP_CONTINUE thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}`);
    } else if (looksLikeBotSender(next)) {
      appendLog(config.paths.activityFile, `REPLY_SKIP_BOT thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}`);
    } else {
      const pendingReply = buildPendingReplyEntry(next, resolvedThreadId, next.turnId, sessionPath, sessionOffset);
      state.pendingReplies = mergePendingReplyLists(state.pendingReplies || [], [pendingReply]);
      appendLog(config.paths.activityFile, `REPLY_PENDING thread=${resolvedThreadId} turn=${next.turnId || "-"} message=${next.messageId} chat=${next.chatId}`);
    }
  }
  state.lastInjectAt = nowIso();
  state.lastAutoDispatchAt = auto ? state.lastInjectAt : state.lastAutoDispatchAt;
  const latestState = loadState(config);
  saveStateForConfig(config, mergeStateSnapshots(latestState, state));
  const injectPreview = normalizeWhitespace(result.responseText || result.stderr || "").slice(0, 220);
  if (injectPreview) {
    appendLog(config.paths.activityFile, `INJECT_RESULT thread=${resolvedThreadId} message=${next.messageId}: ${injectPreview}`);
  }
  appendLog(config.paths.activityFile, `INJECT_${result.ok ? "OK" : "ERROR"} thread=${resolvedThreadId} message=${next.messageId}`);
  return {
    ok: result.ok,
    status: result.ok ? "delivered" : "error",
    threadId: resolvedThreadId,
    message: next,
    responsePreview: result.responseText.slice(0, 400),
    stderr: result.stderr.slice(0, 400)
  };
}

export async function relayRepliesOnce() {
  const config = loadConfig();
  const state = loadState(config);
  const parkedAmbient = parkExpiredAmbientQueueEntriesInPlace(config, state.queue || []);
  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  const supersededPendingReplies = supersedeOlderPendingRepliesInPlace(state.pendingReplies || []);
  closeExpiredPendingRepliesInPlace(config, state.pendingReplies || []);
  if (parkedAmbient > 0 || supersededPendingReplies > 0) {
    appendLog(config.paths.activityFile, `AMBIENT_PARKED count=${parkedAmbient}`);
    if (supersededPendingReplies > 0) {
      appendLog(config.paths.activityFile, `PENDING_REPLY_SUPERSEDED count=${supersededPendingReplies}`);
    }
  }

  for (const entry of state.pendingReplies || []) {
    if (entry.sentAt || entry.status === "error") {
      continue;
    }
    if (!looksLikeBotSender(entry)) {
      continue;
    }
    entry.status = "ignored_bot";
    entry.sentAt = nowIso();
    entry.responsePreview = entry.responsePreview || "[ignored bot message]";
  }

  const pendingReplies = (state.pendingReplies || []).filter((entry) => isReplyAwaitingOutcome(entry));
  if (pendingReplies.length === 0) {
    saveStateForConfig(config, state);
    return { ok: true, status: "empty", delivered: 0 };
  }

  let delivered = 0;
  const usedTurnIds = new Set();
  const usedProgressKeys = new Set();
  const sessionSignals = new Map();

  for (const entry of pendingReplies) {
    if (!entry.sessionPath) {
      entry.sessionPath = await resolveThreadSessionPath(config, entry.threadId);
    }
    if (!entry.sessionPath || !existsSync(entry.sessionPath)) {
      continue;
    }

    if (!sessionSignals.has(entry.sessionPath)) {
      const fallbackOffset = pendingReplies
        .filter((candidate) => candidate.sessionPath === entry.sessionPath)
        .reduce((lowest, candidate) => Math.min(lowest, Number(candidate.sessionOffset || 0)), Number(entry.sessionOffset || 0));
      const savedOffset = Number((state.replyOffsets || {})[entry.sessionPath] ?? fallbackOffset);
      const currentOffset = Math.min(savedOffset, fallbackOffset);
      const currentCarry = String((state.replyBuffers || {})[entry.sessionPath] || "");
      const delta = readJsonlDelta(entry.sessionPath, currentOffset, currentCarry);
      state.replyOffsets = {
        ...(state.replyOffsets || {}),
        [entry.sessionPath]: delta.nextOffset
      };
      state.replyBuffers = {
        ...(state.replyBuffers || {}),
        [entry.sessionPath]: delta.carry
      };
      const completions = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "task_complete")
        .map((item) => ({
          turnId: String(item?.payload?.turn_id || "").trim(),
          message: String(item?.payload?.last_agent_message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.message);
      const finalAnswers = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "agent_message" && String(item?.payload?.phase || "").trim().toLowerCase() === "final_answer")
        .map((item) => ({
          message: String(item?.payload?.message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.message);
      const commentaries = delta.items
        .filter((item) => item?.type === "event_msg" && item?.payload?.type === "agent_message" && String(item?.payload?.phase || "").trim().toLowerCase() === "commentary")
        .map((item) => ({
          message: String(item?.payload?.message || "").trim(),
          timestamp: String(item?.timestamp || "").trim()
        }))
        .filter((item) => item.message);
      sessionSignals.set(entry.sessionPath, { completions, finalAnswers, commentaries });
    }

    const signals = sessionSignals.get(entry.sessionPath) || { completions: [], finalAnswers: [], commentaries: [] };
    const completions = signals.completions || [];
    const finalAnswers = signals.finalAnswers || [];
    const commentaries = signals.commentaries || [];
    const progressRelayMode = getProgressRelayMode(config);

    if (progressRelayMode === "commentary" && !entry.progressSentAt) {
      const progress = commentaries.find((item) => {
        const key = `${item.timestamp}|${item.message}`;
        return item.timestamp >= entry.createdAt && !usedProgressKeys.has(key);
      });
      if (progress) {
        const outboundProgress = await sendOutboundChunks(config, state, {
          chatId: entry.chatId,
          text: progress.message,
          replyToMessageId: entry.replyToMessageId,
          telegramThreadId: entry.telegramThreadId,
          source: "auto_progress",
          sourceTurnId: entry.turnId || null
        });
        entry.progressSentAt = nowIso();
        entry.lastSignalAt = entry.progressSentAt;
        entry.progressMode = "commentary";
        entry.progressPreview = progress.message.slice(0, 400);
        entry.progressMessageIds = outboundProgress.messageIds;
        entry.progressKey = `${progress.timestamp}|${progress.message}`;
        usedProgressKeys.add(`${progress.timestamp}|${progress.message}`);
        appendLog(config.paths.activityFile, `REPLY_PROGRESS_SENT thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundProgress.messageIds.join(",")}`);
      }
    }

    if (progressRelayMode !== "off" && !entry.progressSentAt && shouldSendFallbackProgress(config, entry, entry.sessionPath)) {
      const fallbackText = buildProgressFallbackText(entry);
      const outboundProgress = await sendOutboundChunks(config, state, {
        chatId: entry.chatId,
        text: fallbackText,
        replyToMessageId: entry.replyToMessageId,
        telegramThreadId: entry.telegramThreadId,
        source: "auto_progress",
        sourceTurnId: entry.turnId || null
      });
      entry.progressSentAt = nowIso();
      entry.lastSignalAt = entry.progressSentAt;
      entry.progressMode = "fallback";
      entry.progressPreview = fallbackText.slice(0, 400);
      entry.progressMessageIds = outboundProgress.messageIds;
      appendLog(config.paths.activityFile, `REPLY_PROGRESS_FALLBACK thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundProgress.messageIds.join(",")}`);
    }

    if (progressRelayMode === "commentary" && entry.progressSentAt) {
      const upgrade = commentaries.find((item) => {
        const key = `${item.timestamp}|${item.message}`;
        return item.timestamp >= entry.createdAt
          && key !== entry.progressKey
          && !usedProgressKeys.has(key)
          && shouldSendProgressUpgrade(entry, item);
      });
      if (upgrade) {
        const outboundUpgrade = await sendOutboundChunks(config, state, {
          chatId: entry.chatId,
          text: upgrade.message,
          replyToMessageId: entry.replyToMessageId,
          telegramThreadId: entry.telegramThreadId,
          source: "auto_progress",
          sourceTurnId: entry.turnId || null
        });
        entry.progressUpgradeSentAt = nowIso();
        entry.lastSignalAt = entry.progressUpgradeSentAt;
        entry.progressUpgradePreview = upgrade.message.slice(0, 400);
        entry.progressUpgradeMessageIds = outboundUpgrade.messageIds;
        entry.progressUpgradeKey = `${upgrade.timestamp}|${upgrade.message}`;
        usedProgressKeys.add(`${upgrade.timestamp}|${upgrade.message}`);
        appendLog(config.paths.activityFile, `REPLY_PROGRESS_UPGRADE thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundUpgrade.messageIds.join(",")}`);
      }
    }

    let match = null;
    const finalAnswer = finalAnswers.find((item) => item.timestamp >= entry.createdAt && !usedProgressKeys.has(`final|${item.timestamp}|${item.message}`));
    if (finalAnswer) {
      match = {
        turnId: entry.turnId || "",
        message: finalAnswer.message,
        timestamp: finalAnswer.timestamp,
        source: "final_answer"
      };
      usedProgressKeys.add(`final|${finalAnswer.timestamp}|${finalAnswer.message}`);
    }
    if (entry.turnId) {
      match = match || completions.find((item) => item.turnId === entry.turnId);
    } else {
      match = match || completions.find((item) => item.timestamp >= entry.createdAt && !usedTurnIds.has(item.turnId));
    }
    if (!match) {
      continue;
    }

    if (entry.intent === "continue_nudge" && (looksLikeAckOnly(match.message) || looksLikeContextRequestOnly(match.message))) {
      entry.sentAt = nowIso();
      entry.status = "suppressed_ack";
      entry.turnId = entry.turnId || match.turnId;
      entry.responsePreview = match.message.slice(0, 400);
      usedTurnIds.add(match.turnId);
      appendLog(config.paths.activityFile, `REPLY_SUPPRESSED_CONTINUE_ACK thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId}`);
      continue;
    }
    const outboundResult = await sendOutboundChunks(config, state, {
      chatId: entry.chatId,
      text: match.message,
      replyToMessageId: entry.replyToMessageId,
      telegramThreadId: entry.telegramThreadId,
      source: "auto",
      sourceTurnId: match.turnId
    });
    entry.sentAt = nowIso();
    entry.status = "sent";
    entry.turnId = entry.turnId || match.turnId;
    entry.lastSignalAt = entry.sentAt;
    entry.responsePreview = match.message.slice(0, 400);
    entry.responseMessageIds = outboundResult.messageIds;
    markMatchingQueueEntriesInPlace(state, entry, {
      status: "delivered",
      deliveredAt: entry.sentAt,
      threadId: entry.threadId,
      turnId: entry.turnId,
      responsePreview: entry.responsePreview
    });
    usedTurnIds.add(match.turnId);
    appendLog(config.paths.activityFile, `REPLY_SENT thread=${entry.threadId} turn=${entry.turnId || "-"} chat=${entry.chatId} source_message=${entry.messageId} outbound=${outboundResult.messageIds.join(",")}`);
    delivered += 1;
  }

  state.pendingReplies = reconcilePendingRepliesInPlace(state.pendingReplies || []);
  saveStateForConfig(config, state);
  return {
    ok: true,
    status: delivered > 0 ? "sent" : "pending",
    delivered,
    pending: (state.pendingReplies || []).filter((entry) => isNonTerminalPendingReply(entry)).length
  };
}

export async function reply(text, options = {}) {
  const config = loadConfig();
  const state = loadState(config);
  const lastInbound = state.lastInbound;
  const chatId = String(options.chatId || lastInbound?.chatId || config.allowedChatId || "").trim();
  const replyToMessageId = String(options.replyToMessageId || lastInbound?.messageId || "").trim();
  const telegramThreadId = normalizeTelegramThreadId(options.telegramThreadId || lastInbound?.telegramThreadId || "");
  if (!chatId) {
    throw new Error("No chat id available for reply.");
  }
  const result = await sendOutboundChunks(config, state, {
    chatId,
    text,
    replyToMessageId,
    telegramThreadId,
    source: "manual"
  });
  saveStateForConfig(config, state);
  return result;
}

export function tailActivity(lines = 20) {
  const config = loadConfig();
  return readTail(config.paths.activityFile, lines);
}
