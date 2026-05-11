# CodexLink

CodexLink is the BLUN launcher for one visible CLI session with optional Telegram delivery.

The package is Windows-first today and bundles:

- a global launcher
- a Telegram plugin folder
- startup diagnostics
- one default public profile

## Install

From GitHub:

```powershell
npm install -g github:maykbiletti/codexlink
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

## What it does

- starts one consistent local CLI runtime
- writes a launch record into `.codex/runtimes/default/`
- keeps Telegram queue state under `.codex/channels/telegram-default/`
- can attach Telegram delivery to the same visible session
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
