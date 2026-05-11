function normalizeWsUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) {
    throw new Error("App-server websocket URL is missing.");
  }
  return value;
}

function makeError(message, meta = {}) {
  const error = new Error(message);
  Object.assign(error, meta);
  return error;
}

function parseJson(data) {
  const text = typeof data === "string" ? data : Buffer.from(data).toString("utf8");
  return JSON.parse(text);
}

function buildInitializeRequest(id) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      clientInfo: {
        name: "codexlink-telegram",
        version: "0.2.0"
      },
      capabilities: {
        experimentalApi: true
      }
    }
  };
}

function buildInitializedNotification() {
  return {
    jsonrpc: "2.0",
    method: "initialized"
  };
}

function extractThreadId(response) {
  return response?.result?.thread?.id
    || response?.result?.threadId
    || response?.result?.id
    || "";
}

function extractTurnId(response) {
  return response?.result?.turn?.id
    || response?.result?.turnId
    || response?.result?.id
    || "";
}

function extractThreadPath(response) {
  return response?.result?.thread?.path
    || response?.result?.path
    || "";
}

export class AppServerClient {
  constructor(wsUrl, options = {}) {
    this.wsUrl = normalizeWsUrl(wsUrl);
    this.timeoutMs = Number.parseInt(String(options.timeoutMs || "15000"), 10) || 15000;
    this.socket = null;
    this.pending = new Map();
    this.nextId = 1;
    this.connected = false;
  }

  async connect() {
    if (this.connected && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(makeError(`Timed out connecting to ${this.wsUrl}`));
      }, this.timeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });

      socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(makeError(`WebSocket connection failed for ${this.wsUrl}`, { cause: event?.error || event }));
      }, { once: true });
    });

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = parseJson(event.data);
      } catch (error) {
        return;
      }

      if (message && Object.prototype.hasOwnProperty.call(message, "id")) {
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (!pending) {
          return;
        }
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(makeError(message.error.message || "App-server request failed.", {
            code: message.error.code,
            data: message.error.data
          }));
          return;
        }
        pending.resolve(message);
      }
    });

    socket.addEventListener("close", () => {
      this.connected = false;
      for (const [key, pending] of this.pending.entries()) {
        clearTimeout(pending.timer);
        pending.reject(makeError("App-server websocket closed before request completed."));
        this.pending.delete(key);
      }
    });

    const initId = String(this.nextId++);
    const initPromise = this._waitForResponse(initId);
    await this._sendRaw(buildInitializeRequest(Number(initId)));
    const initializeResponse = await initPromise;
    if (!initializeResponse?.result) {
      throw makeError("App-server initialize returned no result.");
    }
    await this._sendRaw(buildInitializedNotification());

    this.connected = true;
  }

  async request(method, params, options = {}) {
    await this.connect();
    const id = String(this.nextId++);
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    const responsePromise = this._waitForResponse(id, options.timeoutMs);
    await this._sendRaw(payload);
    return responsePromise;
  }

  async close() {
    if (!this.socket) {
      return;
    }
    try {
      this.socket.close();
    } catch {
      // Ignore shutdown errors.
    }
    this.connected = false;
    this.socket = null;
  }

  async _sendRaw(payload) {
    const text = JSON.stringify(payload);
    this.socket.send(text);
  }

  _waitForResponse(id, timeoutOverride) {
    const timeoutMs = Number.parseInt(String(timeoutOverride || this.timeoutMs), 10) || this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(makeError(`App-server request ${id} timed out.`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

export async function startThreadOverWs(options) {
  const client = new AppServerClient(options.wsUrl, { timeoutMs: options.timeoutMs || 20000 });
  try {
    const response = await client.request("thread/start", {
      cwd: options.cwd || null,
      model: options.model || null,
      sandbox: options.sandbox || null,
      approvalPolicy: options.approvalPolicy || null,
      personality: options.personality || null,
      threadSource: "user",
      sessionStartSource: "startup"
    }, { timeoutMs: options.timeoutMs || 20000 });

    const threadId = extractThreadId(response);
    if (!threadId) {
      throw makeError("App-server thread/start returned no thread id.");
    }

    return {
      ok: true,
      threadId,
      response
    };
  } finally {
    await client.close();
  }
}

export async function startTextTurnOverWs(options) {
  const client = new AppServerClient(options.wsUrl, { timeoutMs: options.timeoutMs || 20000 });
  try {
    const response = await client.request("turn/start", {
      threadId: options.threadId,
      input: [
        {
          type: "text",
          text: options.text
        }
      ],
      model: options.model || null,
      effort: options.effort || null,
      personality: options.personality || null
    }, { timeoutMs: options.timeoutMs || 20000 });

    return {
      ok: true,
      busy: false,
      turnId: extractTurnId(response),
      response
    };
  } catch (error) {
    const details = `${error?.message || error}`.toLowerCase();
    const busy = details.includes("active turn")
      || details.includes("cannot accept")
      || details.includes("already running")
      || details.includes("busy");

    return {
      ok: false,
      busy,
      error
    };
  } finally {
    await client.close();
  }
}

export async function readThreadOverWs(options) {
  const client = new AppServerClient(options.wsUrl, { timeoutMs: options.timeoutMs || 10000 });
  try {
    const response = await client.request("thread/read", {
      threadId: options.threadId
    }, { timeoutMs: options.timeoutMs || 10000 });
    const threadId = extractThreadId(response);
    return {
      ok: Boolean(threadId),
      threadId,
      threadPath: extractThreadPath(response),
      response
    };
  } finally {
    await client.close();
  }
}

export async function listLoadedThreadsOverWs(options) {
  const client = new AppServerClient(options.wsUrl, { timeoutMs: options.timeoutMs || 10000 });
  try {
    const response = await client.request("thread/loaded/list", {}, { timeoutMs: options.timeoutMs || 10000 });
    const data = Array.isArray(response?.result?.data) ? response.result.data : [];
    return {
      ok: true,
      data,
      response
    };
  } finally {
    await client.close();
  }
}
