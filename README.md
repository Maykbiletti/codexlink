<div align="center">

# CodexLink

**Your agent in your pocket.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Powered by BLUN](https://img.shields.io/badge/Powered%20by-BLUN-22D3EE.svg)](https://blun.ai)

</div>

CodexLink is the BLUN launcher for one visible CLI session with optional Telegram delivery.

It keeps transport and queueing around the operator, without spinning up a hidden second session.

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

Dry run:

```powershell
blun-codex telegram-plugin --print-only
```

## Private internal profiles

If you run more than one internal operator on the same machine, do not start all of them on the shared `default` slot.

Use a dedicated private profile per operator:

```powershell
blun-codex --profile frida telegram-plugin
```

Why this matters:

- `blun-codex telegram-plugin` without `--profile` uses the shared `default` runtime slot
- starting a second operator on `default` will replace the first `default` runtime
- a private profile gives that operator a separate runtime slot, state directory, and Mnemo binding

For internal/private profiles:

- keep the profile local on the machine
- give it its own `agent_name`
- give it its own Telegram state directory
- do not ship internal agent profiles in the public package

## What it does

- starts one consistent local CLI runtime
- writes a launch record into `.codex/runtimes/default/`
- keeps Telegram queue state under `.codex/channels/telegram-default/`
- attaches Telegram delivery to the same visible session
- keeps poller, dispatcher, and reply relay separate from the foreground operator

## What it does not do

- no hidden autonomous answer bot
- no second shadow session
- no per-agent internal company presets in the public package

## Public profile

The shipped default profile is intentionally generic:

- display name: `CodexLink`
- lane: `general`
- workspace: current directory by default
- model: inherited from the local host unless explicitly set

If you need custom paths or lane rules, add your own profile JSON next to `profiles/default.json`.

## Telegram plugin folder

The bundled plugin lives under `telegram-plugin/` and contains:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `server.js`
- sidecars and bridge helpers

## Requirements

- Windows PowerShell
- Node.js 20+
- a working local `codex` command in `PATH`
- a Telegram bot token when Telegram mode is enabled

## Notes

- the package currently targets local Windows operators first
- the package is installable from GitHub before registry publishing
- once an npm token is available, the same package can be published without changing the command shape
