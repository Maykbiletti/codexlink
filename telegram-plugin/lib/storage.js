import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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

export function loadJsonStrict(path) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
      if (!raw.trim()) {
        const error = new Error(`JSON file is empty: ${path}`);
        error.code = "JSON_EMPTY";
        throw error;
      }
      return JSON.parse(raw);
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        sleepSync(20 * (attempt + 1));
      }
    }
  }
  const error = new Error(`Unable to read valid JSON from ${path}: ${lastError?.message || "unknown error"}`);
  error.code = lastError?.code === "ENOENT" ? "JSON_MISSING" : (lastError?.code || "JSON_INVALID");
  error.cause = lastError;
  error.path = path;
  throw error;
}

function writeTextAtomically(path, text) {
  const dir = dirname(path);
  const base = basename(path);
  let lastError = null;
  mkdirSync(dir, { recursive: true });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const tempPath = join(dir, `.${base}.${process.pid}.${Date.now()}.${attempt}.tmp`);
    let descriptor = null;
    try {
      descriptor = openSync(tempPath, "wx", 0o600);
      writeFileSync(descriptor, text, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch {}
      }
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failures for temp files.
      }
      if (attempt < 29) {
        sleepSync(Math.min(1000, 35 * (attempt + 1)));
      }
    }
  }

  const error = new Error(`Atomic file replace failed for ${path}: ${lastError?.message || "unknown error"}`);
  error.code = "ATOMIC_WRITE_FAILED";
  error.cause = lastError;
  error.path = path;
  throw error;
}

export function saveJson(path, value) {
  writeTextAtomically(path, JSON.stringify(value, null, 2));
}

export function saveJsonWithBackup(path, value, backupPath = `${path}.bak`) {
  const text = JSON.stringify(value, null, 2);
  writeTextAtomically(path, text);
  writeTextAtomically(backupPath, text);
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
    schemaVersion: 3,
    offset: 0,
    intakeCursorInitialized: false,
    intakeInitializedAt: null,
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
