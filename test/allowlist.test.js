import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedChat } from "../telegram-plugin/lib/bridge.js";

test("Telegram intake is disabled without an allowlist", () => {
  assert.equal(isAllowedChat({ allowedChatIds: [] }, { chatId: "123", userId: "123" }), false);
});

test("allowlist matches the chat, not a sender from an unapproved group", () => {
  const config = { allowedChatIds: ["123"] };
  assert.equal(isAllowedChat(config, { chatId: "123", userId: "123" }), true);
  assert.equal(isAllowedChat(config, { chatId: "-100999", userId: "123" }), false);
});
