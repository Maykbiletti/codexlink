import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocketServer } from "ws";
import { AppServerClient } from "../telegram-plugin/lib/app-server-client.js";

test("app-server WebSockets are restricted to loopback", () => {
  assert.throws(
    () => new AppServerClient("ws://example.com:4500"),
    /restricted to localhost/
  );
  assert.throws(() => new AppServerClient("wss://example.com/app-server"), /restricted to localhost/);
});

test("app-server client uses Codex wire framing and starts a turn", async (t) => {
  const messages = [];
  let serverSocket = null;
  let resolveApprovalResponse;
  const approvalResponse = new Promise((resolve) => { resolveApprovalResponse = resolve; });
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");

  server.on("connection", (socket) => {
    serverSocket = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      messages.push(message);
      if (message.id === 91 && message.result) {
        resolveApprovalResponse(message);
      }
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "test" } }));
      }
      if (message.method === "turn/start") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", items: [], error: null } }
        }));
      }
    });
  });

  const address = server.address();
  const client = new AppServerClient(`ws://127.0.0.1:${address.port}`, {
    timeoutMs: 2000,
    onServerRequest: async (_message, respond) => respond({ decision: "decline" })
  });
  t.after(async () => {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await client.connect();
  const result = await client.startTurn({ threadId: "thread-1", text: "Run tests" });
  serverSocket.send(JSON.stringify({
    id: 91,
    method: "item/fileChange/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" }
  }));
  const approval = await approvalResponse;

  assert.equal(result.turnId, "turn-1");
  assert.equal(messages.every((message) => !("jsonrpc" in message)), true);
  assert.deepEqual(messages.find((message) => message.method === "initialized")?.params, {});
  const turn = messages.find((message) => message.method === "turn/start");
  assert.equal(turn.params.threadId, "thread-1");
  assert.equal(turn.params.input[0].text, "Run tests");
  assert.equal("responsesapiClientMetadata" in turn.params, false);
  assert.equal("model" in turn.params, false);
  assert.deepEqual(approval, { id: 91, result: { decision: "decline" } });
});
