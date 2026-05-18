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

Danach oeffnest du Telegram und sendest eine Nachricht an den Bot. CodexLink erkennt Chat oder Gruppe automatisch und schreibt alles lokal an die richtige Stelle. Du musst keine Chat-ID suchen und keine `.env`-Datei bearbeiten.

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

CodexLink injiziert Nachrichten standardmaessig ueber den App-Server in den aktiven Thread. Der Windows-Tastaturmodus kann explizit aktiviert werden, wenn Telegram-Nachrichten wirklich sichtbar in der originalen Codex-Konsole landen sollen:

```text
BLUN_TELEGRAM_VISIBLE_CONSOLE_INJECT=force
```

In diesem Modus schreibt CodexLink die Nachricht ins sichtbare Eingabefeld, wartet kurz und sendet dann einen echten `Enter`/`VK_RETURN` mit Carriage-Return-Zeichen. Die Antwort wird trotzdem weiter aus der Codex-Session getrackt und nach Telegram zurueckgesendet. Das ist der Modus, wenn Telegram exakt wie normale Konsoleneingabe wirken soll.

Kurze Namens-Pings wie `Codex`, `Assistant` oder ein eigener Profilname werden standardmaessig ebenfalls als echte Nachricht in den aktiven Thread injiziert. Das macht Reachability-Tests sichtbar und vermeidet, dass Telegram wie ein separater Hintergrundbot wirkt. Wer den alten Ack-only-Modus fuer solche Pings braucht, kann `BLUN_TELEGRAM_PING_ACK_ONLY=1` setzen.

Gruppen-Nachrichten werden standardmaessig ebenfalls an die aktive CLI geliefert. Das ist der beste Default fuer oeffentliche Setups und Single-Agent-Bots: Telegram ist nur der Transport, der sichtbare Agent entscheidet im Thread selbst, ob die Nachricht fuer ihn relevant ist. Universal-Trigger wie `/ask`, `/debug`, `@assistant`, `ai explain this`, `hilfe`, `erklaer`, `hjalp`, `ayuda`, `aide`, `aiuto`, `ajuda` oder `pomoc` werden zusaetzlich als direkte Agent-Intents erkannt.

Der Otto-/breite-Gruppenmodus ist:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=all
BLUN_TELEGRAM_VISIBLE_CONSOLE_INJECT=force
```

Damit nimmt der Poller jede Nachricht aus erlaubten Chats an, egal ob Human oder Bot. `message.from.is_bot` wird nur als `senderIsBot` gespeichert und nicht beim Empfang weggefiltert. Im Auto-Dispatcher bedeutet `all` jetzt auch wirklich: jede queued Message wird an die sichtbare Codex-Konsole submitted, auch Bot-Nachrichten, Nachrichten an andere Agents und normaler Gruppen-Kontext. Der Agent entscheidet danach im sichtbaren Thread, ob er antwortet oder die Nachricht nur als Kontext nutzt.

Wichtig fuer diesen Modus:

```text
BLUN_TELEGRAM_ALLOWED_CHAT_ID=<private-user-id>,<group-id>
BLUN_TELEGRAM_GROUP_DELIVERY=all
BLUN_TELEGRAM_VISIBLE_CONSOLE_INJECT=force
BLUN_TELEGRAM_VISIBLE_CONSOLE_SUBMIT_DELAY_MS=260
BLUN_TELEGRAM_TEAM_RELAY_URL=
```

Auch Bild-/Datei-Nachrichten laufen in `force` standardmaessig durch die sichtbare Konsole; der Prompt enthaelt dann den lokalen Attachment-Pfad. Wer Attachments bewusst wieder ueber den App-Server statt die Konsole steuern will, setzt `BLUN_TELEGRAM_VISIBLE_CONSOLE_SKIP_ATTACHMENTS=1`.

Eine kaputte `BLUN_TELEGRAM_TEAM_RELAY_URL` verursacht sonst Latenz, weil Publish/Read-Versuche auf den unerreichbaren Relay warten. Wenn kein gemeinsamer HTTP-Relay laeuft, die URL leer lassen. Fuer konfigurierte HTTP-Relays kann `BLUN_TELEGRAM_TEAM_RELAY_TIMEOUT_MS` gesetzt werden; Default ist kurz gehalten.

Fuer echte Agent-Teams ist der empfohlene Modus:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=observe
```

Dann bekommt jeder Codex-Agent alle Gruppen-Nachrichten als Kontext in die aktive CLI. Direkt adressierte Nachrichten bleiben `direct`; nicht adressierte Gruppen-Nachrichten laufen als `observe`. `observe` wird injiziert, erzeugt aber keine automatische Telegram-Antwort.

Observe-Regel: grundsaetzlich still bleiben. Der Agent antwortet oder handelt nur, wenn die Nachricht ausdruecklich in die Runde fragt (`jemand eine Idee?`, `kann wer pruefen?`, `wer weiss das?`), der eigene Scope betroffen ist, ein konkreter Fehler oder ein Risiko erkennbar ist, oder eine kurze fachliche Antwort echten Mehrwert bringt. Keine Antwort bei normalem Status anderer Agents, Smalltalk, fremden Arbeitsuebergaben ohne eigene Zustaendigkeit oder reinen Bot-Logs.

Wenn mehrere Agents denselben Gruppenchat wirklich strikt teilen, kann der alte konservative Modus aktiviert werden:

```text
BLUN_TELEGRAM_GROUP_DELIVERY=mentions
```

Dann werden Gruppen-Nachrichten nur direkt geliefert, wenn sie den Agenten adressieren, einen universellen AI-Trigger enthalten oder zur Lane passen. Nachrichten an bekannte andere Agents bleiben ambient:

```text
BLUN_TELEGRAM_MENTION_NAMES=assistant,codex
BLUN_TELEGRAM_OTHER_AGENT_NAMES=designer,reviewer,ops
```

Die Mention-Namen werden an Poller, Dispatcher, Responder und Team-Relay-Consumer weitergereicht. Das ist wichtig, weil die Sidecars die Gruppen-/Relay-Nachrichten klassifizieren, bevor sie in die sichtbare CLI injiziert werden.

Wichtig bei mehreren Profilen: ein Telegram-Bot-Token darf nicht gleichzeitig von alten oder fremden Pollern abgefragt werden. Sonst meldet Telegram `Conflict: terminated by other getUpdates request`, und Nachrichten koennen verspaetet oder gar nicht in der sichtbaren CLI landen. Aktuelle Versionen pollen non-blocking und schneller; wenn trotzdem Conflicts auftauchen, alle alten `blun-codex telegram-plugin` Fenster fuer denselben Bot schliessen und genau eine aktuelle Session starten.

Beispiel mit konkreten Profilnamen:

```text
BLUN_TELEGRAM_MENTION_NAMES=codex
BLUN_TELEGRAM_OTHER_AGENT_NAMES=designer,reviewer,ops
```

Team-Relay fuer Agent-Gruppen:

Telegram liefert Bot-Nachrichten in Gruppen nicht verlaesslich als raw update an andere Bots. Fuer echte Agent-zu-Agent-Kommunikation nutzt CodexLink deshalb optional einen gemeinsamen Relay-Kanal. Damit werden menschliche Gruppen-Nachrichten und Agent-Outbounds zusaetzlich als JSONL-Events abgelegt oder an einen zentralen Relay-Endpunkt gesendet und von anderen Profilen konsumiert.

Auf einer Windows-Maschine nutzt die normale Installation automatisch eine gemeinsame Relay-Datei unter `%ProgramData%\Blun\codexlink\blun-team-relay.jsonl`. Damit lesen und schreiben verschiedene Codex-Profile denselben Kanal, auch wenn sie unter unterschiedlichen Windows-Accounts laufen. Fuer mehrere Maschinen bleibt der HTTP-Relay die richtige Loesung.

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_FILE=%ProgramData%\Blun\codexlink\blun-team-relay.jsonl
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

Externe Publisher duerfen das minimale Team-Relay-Format nutzen; CodexLink normalisiert es intern und dedupliziert ueber `source_agent + chat_id + message_id`:

```json
{
  "source_agent": "dieter",
  "target_agent": "alfred",
  "chat_id": "-1003927574737",
  "message_id": "telegram-id",
  "scope": "engineering",
  "priority": "normal",
  "text": "..."
}
```

Auf mehreren Maschinen reicht eine lokale Datei nicht. Dann braucht ihr einen gemeinsamen Relay-Server:

```powershell
$env:BLUN_TELEGRAM_TEAM_RELAY_HOST="0.0.0.0"
$env:BLUN_TELEGRAM_TEAM_RELAY_PORT="28787"
$env:BLUN_TELEGRAM_TEAM_RELAY_SECRET="change-me"
blun-codex telegram-relay-server
```

Alle Agents zeigen danach auf denselben Endpunkt:

```text
BLUN_TELEGRAM_TEAM_RELAY_MODE=both
BLUN_TELEGRAM_TEAM_RELAY_URL=http://SERVER-IP:28787/events
BLUN_TELEGRAM_TEAM_RELAY_SECRET=change-me
BLUN_TELEGRAM_TEAM_RELAY_PRIVATE=0
```

Private DMs bleiben dabei privat. Ein Agent darf private DM-Kontexte nur mit expliziter Gruppenbroadcast-Freigabe in eine Gruppe senden. Technisch braucht ein manueller Bridge-Reply dafuer beide Flags: `allow_private_to_group=true` und `confirm_group_broadcast=true`.

Direkt adressierte Team-Bot-Nachrichten werden im Gruppenmodus wie normale Teamarbeit behandelt. Wenn z. B. `angeliathebot` oder ein Relay-Event `Alfred bitte pruefen` schreibt, darf die Nachricht in die sichtbare CLI injiziert werden und eine Gruppenantwort erzeugen. Im `observe`-Modus sieht der Agent auch nicht adressierte Team-Nachrichten, antwortet aber nicht automatisch darauf.

Im Standardmodus `BLUN_TELEGRAM_DISPATCH_MODE=deferred` werden Telegram-Nachrichten wie normale Codex-CLI-Eingaben behandelt: Wenn der sichtbare Run noch aktiv ist, bleibt die Nachricht in der lokalen Queue und wird erst nach dem aktuellen Run injiziert. Normale `direct`-Nachrichten und `weiter`-Signale umgehen diese Sperre nicht; nur echte `escalation`-Eintraege duerfen sofort durch.

Doctor:

```powershell
blun-codex telegram-doctor
```

Der Doctor prueft im Team-Modus jetzt auch, ob `observe` zusammen mit Team-Relay laeuft und ob ein konfigurierter HTTP-Relay-Endpunkt erreichbar ist. Wenn ein Agent Nachrichten anderer Bots nicht sieht, ist der entscheidende Check: Die Nachricht muss in `activity.log`, `inbox.jsonl` oder im gemeinsamen Relay auftauchen. Fehlt sie dort, ist es kein Trigger-/Promptproblem, sondern der sendende Agent publiziert nicht in denselben Relay.

Runtime automatisch bereinigen, wenn mehrere Threads geladen sind oder eine alte Bindung klemmt:

```powershell
blun-codex telegram-doctor --fix
blun-codex telegram-plugin
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
blun-codex --profile reviewer telegram-plugin
```

## Private local profiles

If you run more than one operator on the same machine, do not start all of them on the shared `default` slot.

Use a dedicated private profile per operator:

```powershell
blun-codex --profile reviewer telegram-plugin
```

Why this matters:

- `blun-codex telegram-plugin` without `--profile` uses the shared `default` runtime slot
- starting a second operator on `default` will replace the first `default` runtime
- a private profile gives that operator a separate runtime slot, state directory, and Mnemo binding

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
3. wait for one Telegram message to the bot when no chat is paired yet
4. detect and store the chat/group ID automatically
5. continue into Telegram mode

Allowed Chat ID(s) are no longer typed by hand. To pair a different chat or group later, run:

```powershell
blun-codex telegram-setup
```

If something is missing later, `blun-codex telegram-doctor` tells you exactly what is missing and what to run next.

For normal users, the easiest path is now the self-healing installer:

```powershell
npm install -g github:Maykbiletti/codexlink
blun-codex install --profile otto
```

`install` runs setup, applies `telegram-doctor --fix`, prints the core health
checks, and then starts Telegram mode. If a session is already open and you only
want to repair the runtime without starting a new visible Codex window, run:

```powershell
blun-codex repair --profile otto
```

This is the recommended support path before manual debugging. It fixes stale
thread bindings, stale runtime files, missing relay defaults, and stopped
sidecars before asking the user to touch `.env` files or process lists.

Inbound Telegram messages are mirrored into the visible Codex console by default,
so the operator can see that the message arrived. Queue summaries and outbound
reply notices stay out of the console to avoid input-line spam. Set
`BLUN_TELEGRAM_CONSOLE_UI_NOTICES=off` to disable console mirroring, or `all` to
also mirror outbound notices for debugging.

## Notes

- the package currently targets local Windows operators first
- the package is installable from GitHub before registry publishing
- once an npm token is available, the same package can be published without changing the command shape
