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
  return telegramRequest(config, "getUpdates", {
    offset,
    timeout: 1,
    allowed_updates: ["message"]
  });
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
