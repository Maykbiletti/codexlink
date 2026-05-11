import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

export function nowIso() {
  return new Date().toISOString();
}

export function loadJson(path, fallback) {
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

export function appendJsonl(path, value) {
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

export function appendLog(path, message) {
  appendFileSync(path, `${nowIso()} ${message}\n`, "utf8");
}

export function readTail(path, lines = 20) {
  if (!existsSync(path)) {
    return [];
  }
  const text = readFileSync(path, "utf8");
  return text.split(/\r?\n/).filter(Boolean).slice(-lines);
}

export function defaultState() {
  return {
    offset: 0,
    currentThreadId: "",
    queue: [],
    pendingReplies: [],
    replyOffsets: {},
    replyBuffers: {},
    lastInbound: null,
    lastOutbound: null,
    lastPollAt: null,
    lastInjectAt: null
  };
}
