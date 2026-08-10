<div align="center">

# CodexLink

**Your agent in your pocket.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Powered by BLUN](https://img.shields.io/badge/Powered%20by-BLUN-22D3EE.svg)](https://blun.ai)

</div>

CodexLink is the BLUN launcher for one visible local CLI session with optional
Telegram delivery.

It runs one persistent local runtime daemon around the operator without
starting a hidden second Codex session. Telegram is a transport, the durable
runtime queue is the source of truth, and MCP is the control plane.

Telegram delivery is serial by default:

- inbound messages land in a local queue first
- active work is never interrupted by automatic delivery
- queued messages wait until the visible thread has no active turn
- ambient group noise stays queued until it is relevant or manually drained
- eligible messages are submitted in strict FIFO order without priority jumps
- stale pending replies time out automatically, so the queue cannot block forever

## Install

From GitHub:

```powershell
npm install -g github:maykbiletti/codexlink
```

From npm:

```powershell
npm install -g @blunking/codexlink
```

Local development:

```powershell
cd codexlink
npm install
npm link
```

## Quick Start

Start normally:

```powershell
blun-codex
```

Enable Telegram:

```powershell
blun-codex telegram-plugin
```

If Telegram is not configured yet, CodexLink starts a short setup flow and asks
for the Telegram bot token.

Then open Telegram and send one message to the bot. CodexLink detects the chat
or group automatically and writes the local configuration to the right place.
You do not need to look up a chat ID or edit a `.env` file by hand.

Check the setup:

```powershell
blun-codex telegram-doctor
```

## Commands

Normal startup:

```powershell
blun-codex
```

Alias:

```powershell
codexlink
```

Telegram mode:

```powershell
blun-codex telegram-plugin
```

Manual setup:

```powershell
blun-codex telegram-setup
```

Legacy equivalent:

```powershell
blun-codex --telegram plugin
```

Status:

```powershell
blun-codex telegram-status
```

Doctor:

```powershell
blun-codex telegram-doctor
```

JSON doctor output:

```powershell
blun-codex telegram-doctor --json
```

Repair stale runtime state and then restart Telegram mode:

```powershell
blun-codex telegram-doctor --fix
blun-codex telegram-plugin
```

Dry run:

```powershell
blun-codex telegram-plugin --print-only
```

## Queue Behavior

Every allowed Telegram message is persisted before dispatch. The runtime daemon
keeps it in CodexLink's strict FIFO queue while any turn is active. Only after
the matching `turn/completed` event and an authoritative `idle` thread status
does the daemon write exactly one oldest eligible item into the visible Codex
TUI composer and submit it with the same `Enter` path as direct CLI input. A
later item never enters the composer early and therefore cannot become steering
input for the running turn.

Normal inbound work does not call app-server `turn/start`, `turn/steer`, or
`codex exec resume`. The app-server API has no endpoint for the TUI's private
composer queue, so the default `tui_composer` transport uses the visible Windows
console. The persistent app-server event stream remains responsible for turn
lifecycle, reply correlation, recovery, and approvals. Each injected message
contains a CodexLink queue id so a manual CLI turn cannot consume the wrong
Telegram reply slot.

The lifecycle is:

```text
received -> queued -> injecting -> submitted -> replied
```

Failed submissions return to `queued` with backoff. App-server overloads use
exponential backoff with jitter. Queue state survives CLI and MCP restarts.

`BLUN_CODEXLINK_INPUT_TRANSPORT=app_server` restores the compatibility
`turn/start` transport, but that mode cannot use or display the TUI's private
pending-input queue.

You can inspect the queue at any time:

```powershell
blun-codex telegram-status
```

Progress notices are intentionally conservative. By default, Telegram receives
final replies plus a neutral status notice for longer real work. Internal
commentary is not mirrored as a second answer.

Set one of these values when you need different behavior:

```text
BLUN_TELEGRAM_PROGRESS_RELAY=commentary
BLUN_TELEGRAM_PROGRESS_RELAY=off
```

## Runtime MCP Server

The bundled `codexlink_runtime` MCP server is intentionally thin. It talks to
the persistent daemon over an authenticated localhost RPC endpoint and never
owns a second queue.

The runtime state is fail-closed. Atomic `state.json` writes maintain a valid
`state.json.bak`; an empty or corrupt primary is recovered only from that
backup. If neither file is valid, Telegram intake stops with
`STATE_RECOVERY_REQUIRED` instead of restarting from offset `0`. Fresh installs
initialize at the Telegram tail so pending history is not replayed.

CodexLink also restricts its app-server WebSocket client to loopback endpoints.
The app-server WebSocket transport is currently experimental, so this package
targets local operator workflows rather than unauthenticated remote exposure.

Core tools:

- `runtime_health`
- `runtime_status`
- `runtime_queue_list`
- `runtime_queue_enqueue`
- `runtime_queue_cancel`
- `runtime_bind_thread`
- `runtime_pause` / `runtime_resume`
- `runtime_approvals_list` / `runtime_approval_decide`
- `runtime_reply`

App-server `item/completed` and `turn/completed` events drive outbound replies.
On daemon restart, completed turns are recovered through `thread/read`; internal
Codex session files are not the primary integration surface.

## Group Delivery

Allowed group messages use `observe` routing by default. Telegram is only the
transport; the visible agent decides inside the thread whether a message is
relevant, while non-addressed context does not create an automatic reply.

For broad group intake:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=all
```

In `all` mode, the runtime daemon accepts normal messages from allowed chats,
regardless of whether the sender is human or bot. Explicit Health Smoke,
BotDoctor Smoke, and manual-test diagnostics are the exception: they are
audited as ignored before Mnemo, queueing, or team relay.

Useful settings for this mode:

```text
BLUN_TELEGRAM_ALLOWED_CHAT_ID=<private-user-id>,<group-id>
BLUN_TELEGRAM_GROUP_DELIVERY=all
BLUN_TELEGRAM_TEAM_RELAY_URL=
```

Leave `BLUN_TELEGRAM_TEAM_RELAY_URL` empty when no shared HTTP relay is running.
A broken relay URL can add latency because publish/read attempts wait for an
unreachable endpoint.

For configured HTTP relays, the timeout can be shortened:

```text
BLUN_TELEGRAM_TEAM_RELAY_TIMEOUT_MS=1200
```

For real agent teams, the recommended mode is:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=observe
```

In `observe` mode, every agent receives group messages as context in the active
CLI. Directly addressed messages remain `direct`; non-addressed group messages
are injected as `observe` and do not produce an automatic Telegram reply.

Observe rule: stay quiet by default. The agent should answer or act only when
the message explicitly asks the group for help, its own scope is affected, a
concrete error or risk is visible, or a short expert answer adds real value.

Use the older conservative mode when several agents must share the same group
chat very strictly:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=mentions
```

In `mentions` mode, group messages are delivered directly only when they mention
the current agent, contain a universal assistant trigger, or match the lane.
Messages addressed to known other agents stay ambient:

```text
BLUN_TELEGRAM_MENTION_NAMES=assistant,codex
BLUN_TELEGRAM_OTHER_AGENT_NAMES=designer,reviewer,ops
```

Mention names are passed to the runtime daemon. It classifies group and relay
messages before they are submitted to the visible app-server thread.

Important: a Telegram bot token must not be polled by another process at
the same time. If Telegram reports `Conflict: terminated by other getUpdates
request`, close all old `blun-codex telegram-plugin` windows for that bot and
start exactly one current session.

## Team Relay

Telegram does not reliably deliver bot messages in groups as raw updates to
other bots. For real agent-to-agent communication, CodexLink can use an optional
shared relay channel. Human group messages and agent outbound messages are
written as JSONL events or sent to a central relay endpoint, then consumed by
other profiles.

On one Windows machine, an explicitly enabled relay can use a shared file:

```text
%ProgramData%\Blun\codexlink\blun-team-relay.jsonl
```

Explicit local relay settings:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_FILE=%ProgramData%\Blun\codexlink\blun-team-relay.jsonl
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

External publishers may use this minimal team-relay format. CodexLink
normalizes it internally and deduplicates by `source_agent + chat_id +
message_id`:

```json
{
  "source_agent": "agent-a",
  "target_agent": "agent-b",
  "chat_id": "-1000000000000",
  "message_id": "telegram-id",
  "scope": "engineering",
  "priority": "normal",
  "text": "..."
}
```

Across multiple machines, use a shared relay server:

```powershell
$env:BLUN_TELEGRAM_TEAM_RELAY_HOST="0.0.0.0"
$env:BLUN_TELEGRAM_TEAM_RELAY_PORT="28787"
$env:BLUN_TELEGRAM_TEAM_RELAY_SECRET="change-me"
blun-codex telegram-relay-server
```

Point every agent at the same endpoint:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_URL=http://SERVER-IP:28787/events
BLUN_TELEGRAM_TEAM_RELAY_SECRET=change-me
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

The HTTP relay refuses to start or connect without
`BLUN_TELEGRAM_TEAM_RELAY_SECRET`. Team relay is off by default.

Private direct messages stay private. A private DM context may be broadcast into
a group only with an explicit group-broadcast approval. Manual bridge replies
need both flags:

```text
allow_private_to_group=true
confirm_group_broadcast=true
```

Directly addressed team-bot messages are handled like normal team work in group
mode. In `observe` mode, the agent can see non-addressed team messages too, but
does not automatically answer them.

## Dispatch Mode

The default dispatch mode is:

```text
BLUN_TELEGRAM_DISPATCH_MODE=deferred
```

Telegram messages are treated like normal app-server input. If the visible run
is still active, the message stays in the local queue and is submitted after the
current run has completed and the thread is confirmed idle. Normal `direct`,
continue, and escalation messages do not bypass this lock or overtake an older
eligible item.

The doctor checks whether `observe` mode and team relay are wired correctly and
whether a configured HTTP relay endpoint is reachable.

When an agent does not see other bot messages, the decisive check is this: the
message must appear in `activity.log`, `inbox.jsonl`, or the shared relay. If it
is missing there, it is not a trigger or prompt issue; the sender is not
publishing into the same relay.

## Custom Profiles

Normal startup does not need a custom profile.

If you only need one runtime slot on your machine, this is enough:

```powershell
blun-codex telegram-plugin
```

Use a custom profile only for advanced setups or parallel operation, for example
when multiple operators run on the same machine.

Example:

```powershell
blun-codex --profile reviewer telegram-plugin
```

## Private Local Profiles

If you run more than one operator on the same machine, do not start all of them
on the shared `default` slot.

Use a dedicated private profile per operator:

```powershell
blun-codex --profile reviewer telegram-plugin
```

Why this matters:

- `blun-codex telegram-plugin` without `--profile` uses the shared `default`
  runtime slot
- starting a second operator on `default` replaces the first `default` runtime
- a private profile gives that operator a separate runtime slot, state
  directory, and Mnemo binding

For private local profiles:

- keep the profile local on the machine
- give it its own `agent_name`
- give it its own Telegram state directory
- do not ship internal agent profiles in the public package

Local private profiles are loaded from:

```text
%USERPROFILE%\.codex\profiles\codexlink\<name>.json
```

Example:

```powershell
blun-codex --profile reviewer telegram-plugin
```

looks for:

```text
%USERPROFILE%\.codex\profiles\codexlink\reviewer.json
```

## First-Run Setup

`blun-codex telegram-plugin` behaves like a guided setup for normal users:

1. check whether Telegram is already configured
2. ask only for a missing bot token
3. wait for one Telegram message to the bot when no chat is paired yet
4. detect and store the chat or group ID automatically
5. continue into Telegram mode

Allowed chat IDs are no longer typed by hand. To pair a different chat or group
later, run:

```powershell
blun-codex telegram-setup
```

If something is missing later, `blun-codex telegram-doctor` tells you exactly
what is missing and what to run next.

For normal users, the easiest support path is the self-healing installer:

```powershell
npm install -g github:Maykbiletti/codexlink
blun-codex install --profile reviewer
```

`install` runs setup, applies `telegram-doctor --fix`, prints the core health
checks, and starts Telegram mode. If a session is already open and you only want
to repair the runtime without starting a new visible CLI window, run:

```powershell
blun-codex repair --profile reviewer
```

This is the recommended support path before manual debugging. It fixes stale
thread bindings, stale runtime files, secure relay defaults, and a stopped
runtime daemon before asking the user to touch `.env` files or process lists.

## What It Does

- starts one consistent local CLI runtime
- writes a launch record into `.codex/runtimes/default/`
- keeps the durable runtime queue under `.codex/channels/telegram-default/`
- attaches Telegram delivery to the same visible session
- dispatches only when the bound app-server thread is idle
- keeps Telegram intake alive while the CLI or MCP client reconnects
- receives replies and approvals over the persistent app-server event stream

## What It Does Not Do

- no hidden autonomous answer bot
- no second shadow session
- no terminal keyboard injection
- no `turn/steer` for ordinary inbound work
- no per-agent internal company presets in the public package

## Public Profile

The shipped default profile is intentionally generic:

- display name: `CodexLink`
- lane: `general`
- workspace: current directory by default
- model: inherited from the local host unless explicitly set

If you need custom paths or lane rules, add your own profile JSON next to
`profiles/default.json`.

## Telegram Plugin Folder

The bundled plugin lives under `telegram-plugin/` and contains:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `server.js` (thin MCP adapter)
- `runtime-daemon.js` (queue owner and dispatcher)
- app-server event, local RPC, Telegram, and queue helpers

## Requirements

- Windows PowerShell
- Node.js 20+
- a working local `codex` command in `PATH`
- a Telegram bot token when Telegram mode is enabled

## Notes

- the package currently targets local Windows operators first
- the package is installable from GitHub before registry publishing
- once an npm token is available, the same package can be published without
  changing the command shape
