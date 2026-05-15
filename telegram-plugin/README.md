# CodexLink Telegram Plugin

This is the bundled Telegram plugin for CodexLink.

It is intentionally **not** an autonomous answer bot.

## What it does

- polls Telegram updates into a local queue
- stores inbound and outbound history under a local state directory
- keeps private chats and group threads separated
- binds a live thread id
- injects private messages and, by default, group messages into the active app-server thread
- steers active turns when the app-server supports it
- keeps queued Telegram messages visible when they are waiting instead of ready to deliver
- sends explicit manual replies from the visible operator session
- supports strict mention-only group routing when `BLUN_TELEGRAM_GROUP_DELIVERY=mentions`
- lets escalation-style messages bypass the normal idle queue
- can publish and consume a shared team relay so bot-to-bot group messages do not depend on Telegram raw delivery

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
- `team-relay.pid`

## Env

Copy `.env.example` to `.env` in the state directory or export env vars:

- `BLUN_TELEGRAM_AGENT_NAME`
- `BLUN_TELEGRAM_BOT_TOKEN`
- `BLUN_TELEGRAM_ALLOWED_CHAT_ID` (`chatId` or comma-separated list like `123456789,-1001234567890`)
- `BLUN_TELEGRAM_CODEX_BIN`
- `BLUN_TELEGRAM_THREAD_ID`
- `BLUN_TELEGRAM_RESUME_TIMEOUT_MS`
- `BLUN_TELEGRAM_IDLE_COOLDOWN_MS`
- `BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS`
- `BLUN_TELEGRAM_PROGRESS_RELAY` (`status` by default, `commentary` to mirror commentary updates, `off` to disable progress notices)
- `BLUN_TELEGRAM_DISPATCH_MODE` (`deferred` by default, `legacy` to restore eager dispatch)
- `BLUN_TELEGRAM_GROUP_DELIVERY` (`all` by default for public/single-agent bridges, `mentions` for strict multi-agent routing)
- `BLUN_TELEGRAM_TEAM_RELAY_MODE` (`off`, `publish`, `consume`, or `both`)
- `BLUN_TELEGRAM_TEAM_RELAY_FILE` (shared JSONL relay file for one machine or mounted team state)
- `BLUN_TELEGRAM_TEAM_RELAY_PRIVATE` (`0` by default; private DMs are not shared)
- `BLUN_TELEGRAM_TEAM_RELAY_START` (`tail` by default so enabling the relay does not replay old group history)

## Team relay

Telegram does not reliably deliver bot-to-bot group messages to every bot. CodexLink therefore supports a separate team relay:

- every participating agent can publish inbound group messages it sees
- every participating agent can publish its own outbound Telegram messages
- every participating agent can consume the shared relay and queue only messages relevant to its profile
- private DMs stay private unless `BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=1` is explicitly set

Minimal local setup for multiple agents on one machine:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_FILE=%USERPROFILE%\.codex\channels\blun-team-relay.jsonl
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

For a central ingest, run one poller that publishes to the relay and let the other agents run `consume` or `both`. Agent outbound messages should still publish to the relay, because Telegram may not expose those bot messages as raw updates to other bots.

## Public trigger model

CodexLink keeps personal agent names, but public repos should also work without private names such as "Otto" or "Alfred".

Default neutral triggers include:

- slash commands: `/ai`, `/ask`, `/debug`, `/fix`, `/review`, `/explain`, `/translate`, `/summarize`, `/analyze`
- mentions or names: `@ai`, `@assistant`, `@bot`, `assistant`, `gpt`, `codex`, `claude`, `openai`
- common natural phrases in multiple languages for help, explanation, debugging, fixes, review, translation, summarization, analysis, improvement, and optimization

Slash commands and `@` mentions are the recommended universal path because they remain clear in every language. Natural-language triggers are best-effort multilingual shortcuts, not the sole routing contract.

## Tools

- `bridge_status`
- `bridge_bind_current_thread`
- `bridge_poll_once`
- `bridge_list_queue`
- `bridge_inject_next`
- `bridge_reply`
- `bridge_relay_once`
- `bridge_team_relay_once`
- `bridge_tail_activity`

## Runtime split

- `poller.js` only fetches Telegram updates into the queue
- `dispatcher.js` only retries queue delivery into the bound live thread after the current run is quiet
- `responder.js` only relays finished answers back out
- `team-relay-consumer.js` only reads the shared relay and queues relevant group messages
- none of them are allowed to invent an answer on their own
