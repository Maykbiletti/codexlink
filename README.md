<div align="center">

# CodexLink

**Your agent in your pocket.**

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Powered by BLUN](https://img.shields.io/badge/Powered%20by-BLUN-22D3EE.svg)](https://blun.ai)

</div>

CodexLink is the BLUN launcher for one visible CLI session with optional Telegram delivery.

It keeps transport and queueing around the operator, without spinning up a hidden second session.

Telegram delivery is serial by default:

- inbound messages land in queue first
- active work is not interrupted immediately
- direct messages wait until the visible session is quiet
- ambient group noise stays queued until it is relevant or manually drained
- escalation-style messages can still jump the line
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

## Schnellstart

Normal starten:

```powershell
blun-codex
```

Telegram aktivieren:

```powershell
blun-codex telegram-plugin
```

Wenn Telegram noch nicht eingerichtet ist, startet automatisch ein kurzer Setup-Flow und fragt:

- Telegram Bot Token
- erlaubte Chat ID(s)

Die Werte werden automatisch lokal an die richtige Stelle geschrieben. Du musst keine `.env`-Datei suchen.

Pruefen:

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

Wenn waehrend einer laufenden Arbeit Telegram-Nachrichten gepuffert werden, bleibt die sichtbare CLI-Eingabe unberuehrt. Pending-Nachrichten bleiben im Fenstertitel/Status sichtbar, bis die Antwort raus ist oder sie wirklich ablaufen. Den Queue-Stand kannst du jederzeit mit `blun-codex telegram-status` pruefen.

Der automatische Progress-Hinweis ist bewusst defensiv: standardmaessig sendet Telegram nur finale Antworten plus bei laengeren echten Arbeitslaeufen einen neutralen Status. Interne Commentary-Texte werden nicht als zweite fachliche Antwort gespiegelt. Wer das alte Verhalten will, kann `BLUN_TELEGRAM_PROGRESS_RELAY=commentary` setzen; mit `off` werden Progress-Hinweise ganz deaktiviert.

Wenn mehrere Agents denselben Gruppenchat nutzen, kann ein Agent andere Agent-Namen als Fremdroute markieren. Dann werden Owner-Nachrichten wie `Frida mach weiter` nicht in Ottos Session gezogen:

```text
BLUN_TELEGRAM_MENTION_NAMES=otto
BLUN_TELEGRAM_OTHER_AGENT_NAMES=frida,angel,dieter,alfred
```

Doctor:

```powershell
blun-codex telegram-doctor
```

JSON doctor output:

```powershell
blun-codex telegram-doctor --json
```

Dry run:

```powershell
blun-codex telegram-plugin --print-only
```

## Eigene Profile

Der normale Start braucht kein eigenes Profil.

Wenn du nur einen Slot auf deinem Rechner brauchst, reicht:

```powershell
blun-codex telegram-plugin
```

Ein eigenes Profil brauchst du nur fuer Fortgeschrittene oder Parallelbetrieb, zum Beispiel wenn mehrere Operatoren auf demselben Rechner laufen.

Beispiel:

```powershell
blun-codex --profile alfred telegram-plugin
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

Local private profiles are loaded from:

```text
%USERPROFILE%\.codex\profiles\codexlink\<name>.json
```

Example:

```powershell
blun-codex --profile frida telegram-plugin
```

looks for:

```text
%USERPROFILE%\.codex\profiles\codexlink\frida.json
```

## What it does

- starts one consistent local CLI runtime
- writes a launch record into `.codex/runtimes/default/`
- keeps Telegram queue state under `.codex/channels/telegram-default/`
- attaches Telegram delivery to the same visible session
- defers automatic Telegram delivery until the foreground session is idle
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

## First-run behavior

`blun-codex telegram-plugin` now behaves like a guided setup for normal users:

1. check whether Telegram is already configured
2. ask only for a missing Bot Token
3. save everything automatically into the local Telegram state folder
4. continue into Telegram mode

Allowed Chat ID(s) are optional. If you leave them unset, the bot can currently accept any chat it can see. You can tighten that later with:

```powershell
blun-codex telegram-setup
```

If something is missing later, `blun-codex telegram-doctor` tells you exactly what is missing and what to run next.

## Notes

- the package currently targets local Windows operators first
- the package is installable from GitHub before registry publishing
- once an npm token is available, the same package can be published without changing the command shape
