import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function sleepSync(ms) {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

export function nowIso() {
  return new Date().toISOString();
}

export function loadJson(path, fallback) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) {
        throw new Error("empty json file");
      }
      return JSON.parse(raw);
    } catch {
      if (attempt < 5) {
        sleepSync(20 * (attempt + 1));
      }
    }
  }
  return fallback;
}

export function saveJson(path, value) {
  const text = JSON.stringify(value, null, 2);
  const dir = dirname(path);
  const base = basename(path);
  let lastError = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const tempPath = join(dir, `.${base}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    try {
      writeFileSync(tempPath, text, "utf8");
      renameSync(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failures for temp files.
      }
      if (attempt < 5) {
        sleepSync(25 * (attempt + 1));
      }
    }
  }

  throw lastError || new Error(`Failed to save JSON file: ${path}`);
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
    lastUiNotice: null,
    lastPollAt: null,
    lastInjectAt: null,
    lastAutoDispatchAt: null,
    lastQueueNoticeAt: null
  };
}
