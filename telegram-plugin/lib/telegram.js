function requireToken(config) {
  if (!config.botToken) {
    throw new Error(`BLUN_TELEGRAM_BOT_TOKEN is missing in ${config.paths.envFile}`);
  }
}

async function telegramRequest(config, method, body) {
  requireToken(config);
  const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json; charset=utf-8" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  if (!json.ok) {
    throw new Error(`Telegram ${method} failed: ${json.description || response.status}`);
  }
  return json.result;
}

export async function getUpdates(config, offset) {
  const timeout = Math.max(Number.parseInt(process.env.BLUN_TELEGRAM_GETUPDATES_TIMEOUT || "0", 10) || 0, 0);
  const rawAllowedUpdates = String(
    process.env.BLUN_TELEGRAM_ALLOWED_UPDATES
    || "message,edited_message,channel_post,edited_channel_post"
  ).trim();
  const allowedUpdates = rawAllowedUpdates
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const body = { offset, timeout };
  if (allowedUpdates.length > 0 && rawAllowedUpdates.toLowerCase() !== "all") {
    body.allowed_updates = allowedUpdates;
  }
  return telegramRequest(config, "getUpdates", body);
}

export async function getFileInfo(config, fileId) {
  return telegramRequest(config, "getFile", {
    file_id: fileId
  });
}

export async function downloadFileBuffer(config, filePath) {
  requireToken(config);
  const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${filePath}`);
  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function sendMessage(config, { chatId, text, replyToMessageId, telegramThreadId }) {
  return telegramRequest(config, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(replyToMessageId ? { reply_to_message_id: Number(replyToMessageId), allow_sending_without_reply: true } : {}),
    ...(telegramThreadId ? { message_thread_id: Number(telegramThreadId) } : {})
  });
}

export async function sendChatAction(config, { chatId, telegramThreadId, action = "typing" }) {
  return telegramRequest(config, "sendChatAction", {
    chat_id: chatId,
    action,
    ...(telegramThreadId ? { message_thread_id: Number(telegramThreadId) } : {})
  });
}
