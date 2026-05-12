# CodexLink Telegram Plugin

This is the bundled Telegram plugin for CodexLink.

It is intentionally **not** an autonomous answer bot.

## What it does

- polls Telegram updates into a local queue
- stores inbound and outbound history under a local state directory
- keeps private chats and group threads separated
- binds a live thread id
- injects the next queued Telegram message into that exact live thread only after the session is idle
- keeps injected Telegram messages visible as pending until the matching answer is sent
- sends explicit manual replies from the visible operator session
- keeps ambient group noise queued unless it is relevant to that operator
- lets escalation-style messages bypass the normal idle queue

## What it does not do

- no hidden second session
- no autonomous answer loop
- no background reply worker pretending to be the operator

## State

Default state directory:

`%USERPROFILE%\\.codex\\channels\\codexlink-telegram`

Files created there:

- `.env`
- `state.json`
- `inbox.jsonl`
- `outbox.jsonl`
- `activity.log`
- `prompts/`
- `responses/`
- `poller.pid`
- `dispatcher.pid`
- `responder.pid`

## Env

Copy `.env.example` to `.env` in the state directory or export env vars:

- `BLUN_TELEGRAM_AGENT_NAME`
- `BLUN_TELEGRAM_BOT_TOKEN`
- `BLUN_TELEGRAM_ALLOWED_CHAT_ID` (`chatId` or comma-separated list like `1605241602,-1003927574737`)
- `BLUN_TELEGRAM_CODEX_BIN`
- `BLUN_TELEGRAM_THREAD_ID`
- `BLUN_TELEGRAM_RESUME_TIMEOUT_MS`
- `BLUN_TELEGRAM_IDLE_COOLDOWN_MS`
- `BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS`
- `BLUN_TELEGRAM_DISPATCH_MODE` (`deferred` by default, `legacy` to restore eager dispatch)

## Tools

- `bridge_status`
- `bridge_bind_current_thread`
- `bridge_poll_once`
- `bridge_list_queue`
- `bridge_inject_next`
- `bridge_reply`
- `bridge_relay_once`
- `bridge_tail_activity`

## Runtime split

- `poller.js` only fetches Telegram updates into the queue
- `dispatcher.js` only retries queue delivery into the bound live thread after the current run is quiet
- `responder.js` only relays finished answers back out
- none of them are allowed to invent an answer on their own
