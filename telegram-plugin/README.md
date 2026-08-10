# CodexLink Runtime Plugin

This plugin connects Telegram to one visible Codex app-server thread through a
persistent local runtime. It is not an autonomous answer bot and it does not
create a shadow Codex session.

## Architecture

The runtime daemon owns the durable queue and all transport loops:

1. an allowed Telegram update is normalized and persisted in `state.json`
2. while a turn is active, every later item remains in the durable CodexLink
   queue and cannot enter the composer as steering input
3. after `turn/completed` and an authoritative `idle` status, the dispatcher
   atomically claims exactly the oldest eligible item
4. the daemon writes it into the visible Codex TUI composer and submits it with
   the same `Enter` path as direct CLI input
5. app-server user-message, `item/completed`, and `turn/completed` events bind
   the queued item to its turn, complete the queue
   item and route the final answer back to Telegram
6. on restart, `thread/read` recovers turns that completed while the daemon was
   offline

Ordinary inbound work never calls `turn/start`, `turn/steer`, or `codex exec
resume`. The app-server API does not expose the TUI's private pending-input
queue, so CodexLink deliberately uses the visible Windows console input path.
The MCP server is a thin control plane over the same daemon and never owns a
second queue.

The daemon keeps a persistent app-server connection for lifecycle events,
reply correlation, and approvals. A small queue-id marker in the submitted user
message prevents a manual CLI turn from being mistaken for a Telegram turn. An
atomic composer claim keeps the next FIFO item locked until that marked turn has
completed and the thread is idle again.

Queue lifecycle:

```text
received -> queued -> injecting -> submitted -> replied
```

Busy or overloaded submissions return to `queued` with retry timing. Overload
retries use exponential backoff with jitter. `runtime_pause` stops dispatch but
does not stop Telegram intake.

## Processes

- `runtime-daemon.js` owns Telegram polling, FIFO dispatch, app-server events,
  reply routing, approval requests, and optional team-relay consumption
- `server.js` exposes MCP tools and calls the daemon over authenticated
  localhost RPC
- `team-relay-server.js` is optional and serves a shared authenticated HTTP
  relay for multi-host teams

The legacy `poller.js`, `dispatcher.js`, `responder.js`, and
`team-relay-consumer.js` entry points remain only for compatibility. The
sidecar manager stops owned legacy processes and starts one runtime daemon.

## State

The default directory is:

```text
%USERPROFILE%\.codex\channels\codexlink-telegram
```

Important files:

- `.env`: local transport configuration
- `state.json`: authoritative queue and delivery state
- `state.json.bak`: last valid atomic state backup
- `state-recovery-required.json`: fail-closed recovery marker; while present,
  Telegram intake is stopped
- `inbox.jsonl` and `outbox.jsonl`: append-only transport history
- `runtime-events.jsonl`: app-server notification history
- `runtime-control.json`: persisted pause state
- `runtime-endpoint.json`: authenticated localhost RPC endpoint
- `runtime-daemon.pid`: daemon ownership record
- `activity.log`: operational activity
- `attachments/`: staged Telegram attachments

The RPC endpoint binds only to `127.0.0.1`. Its random bearer token is written
with owner-only POSIX permissions where the filesystem supports them. The Codex
app-server WebSocket endpoint is also restricted to loopback addresses.

State writes use temporary files plus atomic replacement; there is no direct
Windows truncate fallback. If `state.json` is empty or invalid, the daemon
recovers only from a valid `state.json.bak`. If both are invalid, it reports
`STATE_RECOVERY_REQUIRED` and does not call Telegram with offset `0`. A genuinely
new installation initializes once at the Telegram tail and discards pending
history before normal intake begins.

Messages explicitly tagged `[Health Smoke]`, `[BotDoctor Smoke]`, `manualtest`,
or with a diagnostic smoke scope are recorded as
`ignored_diagnostic_smoke`. They are rejected before Mnemo capture, queueing,
and team-relay publication.

## Required configuration

Use `blun-codex telegram-setup` for normal setup. Telegram intake is disabled
until both a bot token and a non-empty chat allowlist exist.

```text
BLUN_TELEGRAM_BOT_TOKEN=123456789:replace_me
BLUN_TELEGRAM_ALLOWED_CHAT_ID=123456789,-1001234567890
BLUN_TELEGRAM_APP_SERVER_WS_URL=ws://127.0.0.1:PORT
BLUN_TELEGRAM_THREAD_ID=thread-id
```

Relevant optional values:

- `BLUN_TELEGRAM_GROUP_DELIVERY`: `observe` by default; `mentions`, `all`, and
  `ambient` are available for explicit routing choices
- `BLUN_TELEGRAM_DISPATCH_MODE`: `deferred` by default
- `BLUN_TELEGRAM_PROGRESS_RELAY`: `status` by default, or `commentary` / `off`
- `BLUN_CODEXLINK_RUNTIME_PORT`: `0` by default for an ephemeral localhost port
- `BLUN_CODEXLINK_RUNTIME_RPC_TIMEOUT_MS`: MCP-to-runtime request timeout
- `BLUN_CODEXLINK_OVERLOAD_BASE_MS`: base delay for overload backoff
- `BLUN_CODEXLINK_INPUT_TRANSPORT`: `tui_composer` by default; `app_server` is
  an explicit compatibility mode and does not use the TUI pending-input queue
- `BLUN_CODEXLINK_COMPOSER_SUBMIT_DELAY_MS`: minimum delay before the injected
  `Enter` key; useful for very slow Windows consoles

The public profile uses `workspace-write` with `on-request` approvals. Mnemo
sync and Telegram capture are off unless explicitly enabled.

## MCP tools

- `runtime_health`
- `runtime_status`
- `runtime_queue_list`
- `runtime_queue_enqueue`
- `runtime_queue_cancel`
- `runtime_bind_thread`
- `runtime_reply`
- `runtime_pause` and `runtime_resume`
- `runtime_approvals_list` and `runtime_approval_decide`
- `runtime_tail_activity`

The daemon stores app-server approval requests until the MCP control plane
resolves them with `accept`, `acceptForSession`, `decline`, or `cancel`.

## Group routing

`observe` is the safe default for group context. Direct messages and explicit
agent mentions remain actionable. Non-addressed group messages can be supplied
as context without generating an automatic Telegram reply. Messages from other
bots in an allowed group follow the same route and enter the durable queue;
messages from the current bot's own Telegram user id remain blocked to prevent
feedback loops.

Use strict routing when several agents share a group:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=mentions
BLUN_TELEGRAM_MENTION_NAMES=assistant,codex
BLUN_TELEGRAM_OTHER_AGENT_NAMES=designer,reviewer,ops
```

Use broad intake only when it is intentional:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=all
```

Telegram permits only one `getUpdates` consumer per bot token. If Telegram
reports a conflict, stop the older CodexLink instance and keep one runtime
daemon for that token.

## Optional team relay

Team relay is off by default. Enable it explicitly only when agents need shared
group context that Telegram does not deliver bot-to-bot.

For one host, configure an absolute shared file:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_FILE=C:\ProgramData\Blun\codexlink\team-relay.jsonl
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

For multiple hosts, configure an HTTP relay. A bearer secret is mandatory for
both the server and all clients:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_URL=http://SERVER-IP:28787/events
BLUN_TELEGRAM_TEAM_RELAY_SECRET=replace-with-a-strong-secret
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

Start the server with the same secret:

```powershell
$env:BLUN_TELEGRAM_TEAM_RELAY_HOST="0.0.0.0"
$env:BLUN_TELEGRAM_TEAM_RELAY_PORT="28787"
$env:BLUN_TELEGRAM_TEAM_RELAY_SECRET="replace-with-a-strong-secret"
blun-codex telegram-relay-server
```

Private DMs are not relayed by default. Sending private-DM context to a group
requires both `allow_private_to_group=true` and
`confirm_group_broadcast=true` on the explicit reply action.
