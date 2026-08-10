import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callRuntimeRpc, createRuntimeRpcServer, loadRuntimeEndpoint } from "../telegram-plugin/lib/runtime-rpc.js";

test("runtime RPC binds locally, authenticates, and returns results", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "codexlink-rpc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    runtimePort: 0,
    runtimeRpcTimeoutMs: 2000,
    paths: {
      root,
      runtimeEndpointFile: join(root, "runtime-endpoint.json"),
      activityFile: join(root, "activity.log")
    }
  };
  const rpc = await createRuntimeRpcServer(config, async (method, params) => ({ method, params }));
  t.after(() => rpc.close());

  const endpoint = loadRuntimeEndpoint(config);
  assert.equal(endpoint.host, "127.0.0.1");
  assert.ok(endpoint.port > 0);
  assert.ok(endpoint.token.length >= 32);
  assert.ok(endpoint.instanceId);
  if (process.platform !== "win32") {
    assert.equal(statSync(config.paths.runtimeEndpointFile).mode & 0o777, 0o600);
  }

  const result = await callRuntimeRpc(config, "runtime_health", { probe: true });
  assert.deepEqual(result, { method: "runtime_health", params: { probe: true } });

  await assert.rejects(
    callRuntimeRpc(config, "runtime_health", {}, { endpoint: { ...endpoint, token: "0".repeat(64) } }),
    /unauthorized/
  );
  await assert.rejects(
    callRuntimeRpc(config, "runtime_health", {}, { endpoint: { ...endpoint, host: "example.com" } }),
    /not ready/
  );
});
