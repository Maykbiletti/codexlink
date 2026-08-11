import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { appendLog, loadJson, nowIso, saveJson } from "./storage.js";
import { currentProcessInstanceId } from "./state-lock.js";

const MAX_BODY_BYTES = 1024 * 1024;

function isValidLocalEndpoint(config, endpoint) {
  const port = Number(endpoint?.port || 0);
  return endpoint?.host === "127.0.0.1"
    && Number.isInteger(port)
    && port > 0
    && port <= 65535
    && String(endpoint?.token || "").length >= 32
    && String(endpoint?.stateDir || "") === String(config.paths.root || "");
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ""));
  const right = Buffer.from(String(expected || ""));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Runtime RPC request is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

export async function createRuntimeRpcServer(config, invoke, options = {}) {
  const token = options.token || randomBytes(32).toString("hex");
  const host = "127.0.0.1";
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/rpc") {
      sendJson(response, 404, { ok: false, error: "not_found" });
      return;
    }

    const auth = String(request.headers.authorization || "");
    const suppliedToken = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokenMatches(suppliedToken, token)) {
      sendJson(response, 401, { ok: false, error: "unauthorized" });
      return;
    }

    try {
      const body = await readRequestBody(request);
      const method = String(body.method || "").trim();
      if (!method) {
        sendJson(response, 400, { ok: false, error: "missing_method" });
        return;
      }
      const result = await invoke(method, body.params || {});
      sendJson(response, 200, { ok: true, result });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 1000);
      const statusCode = Number(error?.statusCode || 500);
      sendJson(response, statusCode, { ok: false, error: message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(config.runtimePort || 0), host, resolve);
  });

  const address = server.address();
  const endpoint = {
    version: 1,
    pid: process.pid,
    instanceId: currentProcessInstanceId(),
    host,
    port: Number(address?.port || 0),
    token,
    stateDir: config.paths.root,
    startedAt: nowIso()
  };
  saveJson(config.paths.runtimeEndpointFile, endpoint);
  try {
    chmodSync(config.paths.runtimeEndpointFile, 0o600);
  } catch {
    // Windows ACLs and some mounted filesystems do not expose POSIX modes.
  }
  appendLog(config.paths.activityFile, `RUNTIME_RPC_LISTEN host=${host} port=${endpoint.port} pid=${process.pid}`);

  return {
    endpoint,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      const current = loadJson(config.paths.runtimeEndpointFile, null);
      if (Number(current?.pid || 0) === process.pid && existsSync(config.paths.runtimeEndpointFile)) {
        try { unlinkSync(config.paths.runtimeEndpointFile); } catch {}
      }
    }
  };
}

export function loadRuntimeEndpoint(config) {
  const endpoint = loadJson(config.paths.runtimeEndpointFile, null);
  if (!isValidLocalEndpoint(config, endpoint)) {
    return null;
  }
  return endpoint;
}

export async function callRuntimeRpc(config, method, params = {}, options = {}) {
  const endpoint = options.endpoint || loadRuntimeEndpoint(config);
  if (!isValidLocalEndpoint(config, endpoint)) {
    throw new Error("CodexLink runtime daemon is not ready.");
  }
  const timeoutMs = Number(options.timeoutMs || config.runtimeRpcTimeoutMs || 65000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ method, params }),
      signal: controller.signal
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      const error = new Error(payload.error || `Runtime RPC failed with HTTP ${response.status}.`);
      error.statusCode = response.status;
      throw error;
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForRuntimeRpc(config, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await callRuntimeRpc(config, "runtime_health", {}, { timeoutMs: 1000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError || new Error("Timed out waiting for CodexLink runtime daemon.");
}
