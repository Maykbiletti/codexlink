param(
  [string]$Profile = "default",
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Read-DotEnvFile {
  param([string]$Path)
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in (Get-Content -Path $Path)) {
    if (-not $line) { continue }
    if ($line.Trim().StartsWith("#")) { continue }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { continue }
    $values[$parts[0].Trim()] = $parts[1]
  }
  return $values
}

function Add-Check {
  param(
    [System.Collections.Generic.List[object]]$List,
    [string]$Name,
    [string]$Status,
    [string]$Detail
  )
  $List.Add([pscustomobject]@{
    name = $Name
    status = $Status
    detail = $Detail
  }) | Out-Null
}

function Test-TelegramTokenFormat {
  param([string]$Value)
  if (-not $Value) { return $false }
  return $Value -match '^\d{6,}:[A-Za-z0-9_-]{20,}$'
}

function Test-AllowedChatIdsFormat {
  param([string]$Value)
  if (-not $Value) { return $false }
  $parts = @($Value -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($parts.Count -eq 0) { return $false }
  foreach ($part in $parts) {
    if ($part -notmatch '^-?\d+$') {
      return $false
    }
  }
  return $true
}

function Get-OverallStatus {
  param([System.Collections.Generic.List[object]]$Checks)
  if (@($Checks | Where-Object { $_.status -eq "fail" }).Count -gt 0) {
    return "fail"
  }
  if (@($Checks | Where-Object { $_.status -eq "warn" }).Count -gt 0) {
    return "warn"
  }
  return "ok"
}

function Write-DoctorReport {
  param(
    [object]$Result,
    [string]$TokenSource,
    [string]$AllowedChatSource
  )

  $emoji = switch ($Result.overall) {
    "ok" { "[OK]" }
    "warn" { "[WARN]" }
    default { "[FAIL]" }
  }

  Write-Host ""
  Write-Host "CodexLink Telegram Doctor $emoji" -ForegroundColor Cyan
  Write-Host "Profil: $($Result.profile)"
  Write-Host "State-Ordner: $($Result.state_dir)"
  Write-Host ""

  foreach ($check in $Result.checks) {
    $prefix = switch ($check.status) {
      "ok" { "[OK]" }
      "warn" { "[WARN]" }
      default { "[FAIL]" }
    }
    $color = switch ($check.status) {
      "ok" { "Green" }
      "warn" { "Yellow" }
      default { "Red" }
    }
    Write-Host "$prefix $($check.name): $($check.detail)" -ForegroundColor $color
  }

  Write-Host ""
  if ($TokenSource) {
    Write-Host "Bot-Token gefunden aus: $TokenSource" -ForegroundColor DarkGray
  }
  if ($AllowedChatSource) {
    Write-Host "Erlaubte Chat-ID(s) gefunden aus: $AllowedChatSource" -ForegroundColor DarkGray
  }

  $failed = @($Result.checks | Where-Object { $_.status -eq "fail" })
  if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "Was jetzt fehlt:" -ForegroundColor Yellow
    foreach ($item in $failed) {
      switch ($item.name) {
        "bot_token" { Write-Host "  - Telegram Bot Token fehlt. Starte: blun-codex --profile $($Result.profile) telegram-setup" }
        "allowed_chat_ids" { Write-Host "  - Erlaubte Chat-ID(s) fehlen. Starte: blun-codex --profile $($Result.profile) telegram-setup" }
        "state_dir" { Write-Host "  - Der lokale Telegram-State-Ordner fehlt noch. Ein Setup-Lauf legt ihn automatisch an." }
        "profile_file" { Write-Host "  - Das angegebene Profil existiert nicht." }
        "node" { Write-Host "  - Node.js fehlt in PATH." }
        "codex" { Write-Host "  - Der lokale codex-Befehl fehlt in PATH." }
        "telegram_plugin_root" { Write-Host "  - Der Telegram-Plugin-Ordner konnte nicht gefunden werden." }
        default { Write-Host "  - $($item.detail)" }
      }
    }
  }

  if ($Result.overall -eq "ok") {
    Write-Host ""
    Write-Host "Telegram ist sauber eingerichtet." -ForegroundColor Green
    Write-Host "Starten: blun-codex --profile $($Result.profile) telegram-plugin"
  } elseif ($Result.overall -eq "warn") {
    Write-Host ""
    Write-Host "Die Grundkonfiguration steht, aber es gibt noch Laufzeit-Hinweise." -ForegroundColor Yellow
    Write-Host "Das ist oft normal, wenn Telegram noch nicht aktiv gestartet wurde oder noch keine Nachricht durchlief."
  }
}

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Join-Path $runtimeRoot ("profiles\" + $Profile.ToLower() + ".json")
$checks = New-Object 'System.Collections.Generic.List[object]'

if (Test-Path $profilePath) {
  Add-Check -List $checks -Name "profile_file" -Status "ok" -Detail $profilePath
} else {
  Add-Check -List $checks -Name "profile_file" -Status "fail" -Detail ("Missing profile: " + $profilePath)
}

$statusRaw = & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-status.ps1") -Profile $Profile
$status = $statusRaw | ConvertFrom-Json

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$codexCommand = Get-Command codex -ErrorAction SilentlyContinue
Add-Check -List $checks -Name "node" -Status $(if ($nodeCommand) { "ok" } else { "fail" }) -Detail $(if ($nodeCommand) { $nodeCommand.Source } else { "node not found in PATH" })
Add-Check -List $checks -Name "codex" -Status $(if ($codexCommand) { "ok" } else { "fail" }) -Detail $(if ($codexCommand) { $codexCommand.Source } else { "codex not found in PATH" })

if ($status.plugin_root) {
  Add-Check -List $checks -Name "telegram_plugin_root" -Status "ok" -Detail $status.plugin_root
} else {
  Add-Check -List $checks -Name "telegram_plugin_root" -Status "fail" -Detail "Telegram plugin root could not be resolved."
}

if ($status.state_dir -and (Test-Path $status.state_dir)) {
  Add-Check -List $checks -Name "state_dir" -Status "ok" -Detail $status.state_dir
} else {
  Add-Check -List $checks -Name "state_dir" -Status "fail" -Detail ("Missing state dir: " + $status.state_dir)
}

$activeEnvPath = Join-Path $status.state_dir ".env"
$activeEnv = Read-DotEnvFile -Path $activeEnvPath
$legacyEnvPath = Join-Path $env:USERPROFILE ".codex\channels\codexlink-telegram\.env"
$legacyEnv = Read-DotEnvFile -Path $legacyEnvPath

$tokenValue = ""
$tokenSource = ""
if (Test-TelegramTokenFormat -Value $activeEnv["BLUN_TELEGRAM_BOT_TOKEN"]) {
  $tokenValue = [string]$activeEnv["BLUN_TELEGRAM_BOT_TOKEN"]
  $tokenSource = "state env"
} elseif (Test-TelegramTokenFormat -Value $legacyEnv["BLUN_TELEGRAM_BOT_TOKEN"]) {
  $tokenValue = [string]$legacyEnv["BLUN_TELEGRAM_BOT_TOKEN"]
  $tokenSource = "legacy env fallback"
}
Add-Check -List $checks -Name "bot_token" -Status $(if ($tokenValue) { "ok" } else { "fail" }) -Detail $(if ($tokenValue) { $tokenSource } else { "No valid BLUN_TELEGRAM_BOT_TOKEN found." })

$allowedChatIds = ""
$allowedChatSource = ""
if (Test-AllowedChatIdsFormat -Value $activeEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]) {
  $allowedChatIds = [string]$activeEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]
  $allowedChatSource = "state env"
} elseif (Test-AllowedChatIdsFormat -Value $legacyEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]) {
  $allowedChatIds = [string]$legacyEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]
  $allowedChatSource = "legacy env fallback"
}
Add-Check -List $checks -Name "allowed_chat_ids" -Status $(if ($allowedChatIds) { "ok" } else { "fail" }) -Detail $(if ($allowedChatIds) { $allowedChatIds } else { "No valid BLUN_TELEGRAM_ALLOWED_CHAT_ID found." })

Add-Check -List $checks -Name "app_server_ws" -Status $(if ($status.active_ws) { "ok" } else { "warn" }) -Detail $(if ($status.active_ws) { $status.active_ws } else { "No active websocket recorded." })
Add-Check -List $checks -Name "dispatch_mode" -Status $(if ($status.dispatch_mode -eq "deferred") { "ok" } else { "warn" }) -Detail ("mode=" + [string]$status.dispatch_mode + " cooldown_ms=" + [string]$status.idle_cooldown_ms)
Add-Check -List $checks -Name "bound_thread" -Status $(if ($status.active_thread_id) { "ok" } else { "warn" }) -Detail $(if ($status.active_thread_id) { $status.active_thread_id } else { "No active thread bound yet." })
Add-Check -List $checks -Name "poller" -Status $(if ($status.poller_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.poller_pid + " alive=" + [string]$status.poller_alive)
Add-Check -List $checks -Name "dispatcher" -Status $(if ($status.dispatcher_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.dispatcher_pid + " alive=" + [string]$status.dispatcher_alive)
Add-Check -List $checks -Name "responder" -Status $(if ($status.responder_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.responder_pid + " alive=" + [string]$status.responder_alive)

if ($status.last_inbound) {
  $lastInboundSummary = [string]::Format(
    "chat={0} message={1} type={2} thread={3}",
    $status.last_inbound.chatId,
    $status.last_inbound.messageId,
    $status.last_inbound.chatType,
    $(if ($status.last_inbound.telegramThreadId) { $status.last_inbound.telegramThreadId } else { "-" })
  )
  Add-Check -List $checks -Name "last_inbound" -Status "ok" -Detail $lastInboundSummary
} else {
  Add-Check -List $checks -Name "last_inbound" -Status "warn" -Detail "No inbound Telegram message recorded yet."
}

if ($status.last_outbound) {
  $lastOutboundSummary = [string]::Format(
    "chat={0} message={1} reply_to={2} thread={3}",
    $status.last_outbound.chatId,
    $status.last_outbound.messageId,
    $(if ($status.last_outbound.replyToMessageId) { $status.last_outbound.replyToMessageId } else { "-" }),
    $(if ($status.last_outbound.telegramThreadId) { $status.last_outbound.telegramThreadId } else { "-" })
  )
  Add-Check -List $checks -Name "last_outbound" -Status "ok" -Detail $lastOutboundSummary
} else {
  Add-Check -List $checks -Name "last_outbound" -Status "warn" -Detail "No outbound Telegram message recorded yet."
}

Add-Check -List $checks -Name "queue" -Status $(if (([int]$status.queue_depth -eq 0) -and ([int]$status.pending_reply_depth -eq 0)) { "ok" } else { "warn" }) -Detail ("queued=" + $status.queue_depth + " ambient=" + $status.ambient_queue_depth + " submitted=" + $status.submitted_depth + " pending_replies=" + $status.pending_reply_depth)

$result = [ordered]@{
  profile = $status.profile
  overall = Get-OverallStatus -Checks $checks
  runtime_root = $runtimeRoot
  state_dir = $status.state_dir
  plugin_root = $status.plugin_root
  checks = $checks
  status = $status
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
  exit 0
}

Write-DoctorReport -Result $result -TokenSource $tokenSource -AllowedChatSource $allowedChatSource
