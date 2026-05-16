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
- `BLUN_TELEGRAM_GROUP_DELIVERY` (`all` by default for public/single-agent bridges, `observe` for team-wide context delivery without automatic replies, `mentions` for strict multi-agent routing)
- `BLUN_TELEGRAM_TEAM_RELAY_MODE` (`both` by default, or `off`, `publish`, `consume`)
- `BLUN_TELEGRAM_TEAM_RELAY_FILE` (defaults to `%USERPROFILE%\.codex\channels\blun-team-relay.jsonl`; use a shared absolute path for agents under different Windows users)
- `BLUN_TELEGRAM_TEAM_RELAY_URL` (shared HTTP relay endpoint for multiple machines)
- `BLUN_TELEGRAM_TEAM_RELAY_SECRET` (optional bearer secret for the shared HTTP relay)
- `BLUN_TELEGRAM_TEAM_RELAY_PRIVATE` (`0` by default; private DMs are not shared)
- `BLUN_TELEGRAM_TEAM_RELAY_START` (`tail` by default so enabling the relay does not replay old group history)

## Team relay

Telegram does not reliably deliver bot-to-bot group messages to every bot. CodexLink therefore supports a separate team relay:

- every participating agent can publish inbound group messages it sees
- every participating agent can publish its own outbound Telegram messages
- every participating agent can consume the shared relay and, with `BLUN_TELEGRAM_GROUP_DELIVERY=observe`, receive all group messages as context while only replying to direct/scope-relevant work
- private DMs stay private unless `BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=1` is explicitly set
- private-DM context cannot be sent into a group by accident; manual bridge replies need both `allow_private_to_group=true` and `confirm_group_broadcast=true`

Minimal local setup for multiple agents on one machine and the same Windows user is now the default. `%USERPROFILE%` differs per Windows user, so agents running under different Windows accounts need a shared absolute path or the HTTP relay:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_FILE=%USERPROFILE%\.codex\channels\blun-team-relay.jsonl
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

For multiple machines, run one shared relay server and point every agent at the same URL:

```powershell
$env:BLUN_TELEGRAM_TEAM_RELAY_HOST="0.0.0.0"
$env:BLUN_TELEGRAM_TEAM_RELAY_PORT="28787"
$env:BLUN_TELEGRAM_TEAM_RELAY_SECRET="change-me"
blun-codex telegram-relay-server
```

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_URL=http://SERVER-IP:28787/events
BLUN_TELEGRAM_TEAM_RELAY_SECRET=change-me
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

Agent outbound messages should still publish to the relay, because Telegram may not expose those bot messages as raw updates to other bots.

Recommended team mode:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=observe
```

In this mode direct messages and explicit agent mentions still behave as actionable work. Other group messages are injected as `observe` context so the agent can keep situational awareness, but CodexLink does not track an automatic Telegram reply for them.

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
- `team-relay-server.js` stores and serves shared relay events for machines that cannot share one local file
- none of them are allowed to invent an answer on their own
