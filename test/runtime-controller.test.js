import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeController } from "../telegram-plugin/lib/runtime-controller.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "codexlink-controller-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const operations = {
    status: () => ({ queueDepth: 1 }),
    listQueue: (limit) => [{ limit }],
    enqueue: (text, options) => ({ text, options }),
    cancel: (id) => ({ id }),
    bindThread: (threadId) => ({ threadId }),
    poll: async () => ({ captured: 0 }),
    dispatch: async (...args) => { calls.push(args); return { status: "submitted" }; },
    reply: async () => ({ ok: true }),
    relayReplies: async () => ({ ok: true }),
    teamRelay: async () => ({ ok: true }),
    tailActivity: () => []
  };
  const config = { paths: { runtimeControlFile: join(root, "runtime-control.json") } };
  return { controller: new RuntimeController(config, operations), calls };
}

test("pause keeps intake available but blocks dispatch", async (t) => {
  const { controller, calls } = fixture(t);
  assert.equal((await controller.invoke("runtime_pause")).paused, true);
  assert.equal((await controller.invoke("runtime_dispatch_once")).status, "paused");
  assert.equal(calls.length, 0);

  await controller.invoke("runtime_resume");
  assert.equal((await controller.invoke("runtime_dispatch_once")).status, "submitted");
  assert.equal(calls.length, 1);
});

test("enqueue defaults to no Telegram reply", async (t) => {
  const { controller } = fixture(t);
  const result = await controller.invoke("runtime_queue_enqueue", { text: "Build it", reply_to_telegram: true });
  assert.equal(result.text, "Build it");
  assert.equal(result.options.noTelegramReply, true);
});
