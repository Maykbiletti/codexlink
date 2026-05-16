param(
  [string]$Profile = "default",
  [switch]$Json,
  [switch]$Fix
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

function Test-TeamRelayUrl {
  param(
    [string]$Url,
    [string]$Secret
  )
  if (-not $Url) {
    return [pscustomobject]@{ ok = $false; detail = "not configured" }
  }
  try {
    $builder = [System.UriBuilder]::new($Url)
    $query = [System.Web.HttpUtility]::ParseQueryString($builder.Query)
    $query["after"] = "tail"
    $builder.Query = $query.ToString()
    $headers = @{}
    if ($Secret) {
      $headers["Authorization"] = "Bearer $Secret"
    }
    $response = Invoke-WebRequest -Uri $builder.Uri.AbsoluteUri -Headers $headers -UseBasicParsing -TimeoutSec 3
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) {
      return [pscustomobject]@{ ok = $true; detail = "reachable" }
    }
    return [pscustomobject]@{ ok = $false; detail = ("HTTP " + [string]$response.StatusCode) }
  } catch {
    return [pscustomobject]@{ ok = $false; detail = [string]$_.Exception.Message }
  }
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
        "allowed_chat_ids" { Write-Host "  - Chat-ID ist optional. Zum automatischen Koppeln: blun-codex --profile $($Result.profile) telegram-setup" }
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

function Write-DotEnvFile {
  param(
    [string]$Path,
    [hashtable]$Values
  )
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $lines = New-Object 'System.Collections.Generic.List[string]'
  foreach ($key in ($Values.Keys | Sort-Object)) {
    if ([string]::IsNullOrWhiteSpace([string]$key)) { continue }
    $value = [string]$Values[$key]
    $lines.Add($key + "=" + $value) | Out-Null
  }
  Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Ensure-TeamRelayDefaults {
  param(
    [hashtable]$Values,
    [string]$DefaultFile
  )

  $changed = $false
  if (-not $Values.ContainsKey("BLUN_TELEGRAM_GROUP_DELIVERY") -or [string]::IsNullOrWhiteSpace([string]$Values["BLUN_TELEGRAM_GROUP_DELIVERY"])) {
    $Values["BLUN_TELEGRAM_GROUP_DELIVERY"] = "all"
    $changed = $true
  }
  if (-not $Values.ContainsKey("BLUN_TELEGRAM_TEAM_RELAY_MODE") -or [string]::IsNullOrWhiteSpace([string]$Values["BLUN_TELEGRAM_TEAM_RELAY_MODE"])) {
    $Values["BLUN_TELEGRAM_TEAM_RELAY_MODE"] = "both"
    $changed = $true
  }
  $hasRelayFile = $Values.ContainsKey("BLUN_TELEGRAM_TEAM_RELAY_FILE") -and -not [string]::IsNullOrWhiteSpace([string]$Values["BLUN_TELEGRAM_TEAM_RELAY_FILE"])
  $hasRelayUrl = $Values.ContainsKey("BLUN_TELEGRAM_TEAM_RELAY_URL") -and -not [string]::IsNullOrWhiteSpace([string]$Values["BLUN_TELEGRAM_TEAM_RELAY_URL"])
  if (-not $hasRelayFile -and -not $hasRelayUrl) {
    $Values["BLUN_TELEGRAM_TEAM_RELAY_FILE"] = $DefaultFile
    $changed = $true
  }
  if (-not $Values.ContainsKey("BLUN_TELEGRAM_TEAM_RELAY_PRIVATE") -or [string]::IsNullOrWhiteSpace([string]$Values["BLUN_TELEGRAM_TEAM_RELAY_PRIVATE"])) {
    $Values["BLUN_TELEGRAM_TEAM_RELAY_PRIVATE"] = "0"
    $changed = $true
  }
  if (-not $Values.ContainsKey("BLUN_TELEGRAM_TEAM_RELAY_START") -or [string]::IsNullOrWhiteSpace([string]$Values["BLUN_TELEGRAM_TEAM_RELAY_START"])) {
    $Values["BLUN_TELEGRAM_TEAM_RELAY_START"] = "tail"
    $changed = $true
  }
  return $changed
}

function Stop-PidQuiet {
  param([object]$PidValue)
  $pidText = [string]$PidValue
  if (-not $pidText) { return $false }
  $pidInt = 0
  if (-not [int]::TryParse($pidText, [ref]$pidInt)) { return $false }
  if ($pidInt -le 0) { return $false }
  try {
    Stop-Process -Id $pidInt -Force -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Invoke-RuntimeFix {
  param(
    [object]$Status,
    [string]$RuntimeRoot
  )
  $actions = New-Object 'System.Collections.Generic.List[string]'
  $runtime = $Status.current_runtime
  if ($runtime) {
    $pids = @(
      $runtime.frontend_host_pid,
      $runtime.app_server_pid,
      $runtime.queue_notifier_pid,
      $runtime.poller_pid,
      $runtime.dispatcher_pid,
      $runtime.responder_pid,
      $runtime.team_relay_pid
    ) | Where-Object { $_ } | Select-Object -Unique
    foreach ($pidValue in $pids) {
      if (Stop-PidQuiet -PidValue $pidValue) {
        $actions.Add("stopped_pid=" + [string]$pidValue) | Out-Null
      }
    }
  }

  $runtimeFile = Join-Path $env:USERPROFILE (".codex\runtimes\" + [string]$Status.profile + "\current-remote-runtime.json")
  if (Test-Path $runtimeFile) {
    Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
    $actions.Add("removed_runtime_file") | Out-Null
  }

  $envFile = Join-Path ([string]$Status.state_dir) ".env"
  $envValues = Read-DotEnvFile -Path $envFile
  $envChanged = $false
  if ($envValues.ContainsKey("BLUN_TELEGRAM_THREAD_ID")) {
    $envValues["BLUN_TELEGRAM_THREAD_ID"] = ""
    $envChanged = $true
    $actions.Add("cleared_env_thread") | Out-Null
  }
  if (Ensure-TeamRelayDefaults -Values $envValues -DefaultFile (Join-Path $env:USERPROFILE ".codex\channels\blun-team-relay.jsonl")) {
    $envChanged = $true
    $actions.Add("ensured_team_relay_defaults") | Out-Null
  }
  if ($envChanged) {
    Write-DotEnvFile -Path $envFile -Values $envValues
  }

  $stateFile = Join-Path ([string]$Status.state_dir) "state.json"
  if (Test-Path $stateFile) {
    try {
      $state = Get-Content -Raw -Path $stateFile | ConvertFrom-Json
      if ($state.PSObject.Properties.Name.Contains("currentThreadId")) {
        $state.currentThreadId = ""
      } else {
        $state | Add-Member -NotePropertyName "currentThreadId" -NotePropertyValue ""
      }
      $state | ConvertTo-Json -Depth 10 | Set-Content -Path $stateFile -Encoding UTF8
      $actions.Add("cleared_state_thread") | Out-Null
    } catch {
      $actions.Add("state_thread_clear_failed") | Out-Null
    }
  }

  return @($actions)
}

function Get-ProfilePath {
  param(
    [string]$RuntimeRoot,
    [string]$ProfileName
  )

  $normalized = [string]$ProfileName
  if (-not $normalized) { $normalized = "" }
  $normalized = $normalized.ToLower()
  $candidates = @()
  if ($env:BLUN_CODEX_PROFILE_ROOT) {
    $candidates += (Join-Path $env:BLUN_CODEX_PROFILE_ROOT ($normalized + ".json"))
  }
  $candidates += (Join-Path $env:USERPROFILE (".codex\\profiles\\codexlink\\" + $normalized + ".json"))
  $candidates += (Join-Path $RuntimeRoot ("profiles\\" + $normalized + ".json"))

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $candidates[-1]
}

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Get-ProfilePath -RuntimeRoot $runtimeRoot -ProfileName $Profile
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
} elseif (Test-TelegramTokenFormat -Value $activeEnv["TELEGRAM_BOT_TOKEN"]) {
  $tokenValue = [string]$activeEnv["TELEGRAM_BOT_TOKEN"]
  $tokenSource = "state env legacy key"
} elseif (Test-TelegramTokenFormat -Value $legacyEnv["BLUN_TELEGRAM_BOT_TOKEN"]) {
  $tokenValue = [string]$legacyEnv["BLUN_TELEGRAM_BOT_TOKEN"]
  $tokenSource = "legacy env fallback"
} elseif (Test-TelegramTokenFormat -Value $legacyEnv["TELEGRAM_BOT_TOKEN"]) {
  $tokenValue = [string]$legacyEnv["TELEGRAM_BOT_TOKEN"]
  $tokenSource = "legacy env fallback legacy key"
}
Add-Check -List $checks -Name "bot_token" -Status $(if ($tokenValue) { "ok" } else { "fail" }) -Detail $(if ($tokenValue) { $tokenSource } else { "No valid BLUN_TELEGRAM_BOT_TOKEN found." })

$allowedChatIds = ""
$allowedChatSource = ""
if (Test-AllowedChatIdsFormat -Value $activeEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]) {
  $allowedChatIds = [string]$activeEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]
  $allowedChatSource = "state env"
} elseif (Test-AllowedChatIdsFormat -Value $activeEnv["TELEGRAM_ALLOWED_CHAT_ID"]) {
  $allowedChatIds = [string]$activeEnv["TELEGRAM_ALLOWED_CHAT_ID"]
  $allowedChatSource = "state env legacy key"
} elseif (Test-AllowedChatIdsFormat -Value $legacyEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]) {
  $allowedChatIds = [string]$legacyEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]
  $allowedChatSource = "legacy env fallback"
} elseif (Test-AllowedChatIdsFormat -Value $legacyEnv["TELEGRAM_ALLOWED_CHAT_ID"]) {
  $allowedChatIds = [string]$legacyEnv["TELEGRAM_ALLOWED_CHAT_ID"]
  $allowedChatSource = "legacy env fallback legacy key"
}
Add-Check -List $checks -Name "allowed_chat_ids" -Status $(if ($allowedChatIds) { "ok" } else { "warn" }) -Detail $(if ($allowedChatIds) { $allowedChatIds } else { "No allowlist set. Telegram currently accepts any chat the bot can see." })

Add-Check -List $checks -Name "app_server_ws" -Status $(if ($status.active_ws) { "ok" } else { "warn" }) -Detail $(if ($status.active_ws) { $status.active_ws } else { "No active websocket recorded." })
Add-Check -List $checks -Name "dispatch_mode" -Status $(if ($status.dispatch_mode -eq "deferred") { "ok" } else { "warn" }) -Detail ("mode=" + [string]$status.dispatch_mode + " cooldown_ms=" + [string]$status.idle_cooldown_ms + " pending_reply_timeout_ms=" + [string]$status.pending_reply_timeout_ms)
Add-Check -List $checks -Name "bound_thread" -Status $(if ($status.active_thread_id) { "ok" } else { "warn" }) -Detail $(if ($status.active_thread_id) { $status.active_thread_id } else { "No active thread bound yet." })
$loadedThreads = @($status.loaded_threads | Where-Object { $_ })
$threadVisibilityStatus = "ok"
$threadVisibilityDetail = "loaded=" + [string]$loadedThreads.Count
if ($loadedThreads.Count -gt 1) {
  $threadVisibilityStatus = "warn"
  $threadVisibilityDetail = "multiple loaded threads: " + (($loadedThreads | ForEach-Object { [string]$_ }) -join ",") + ". Run telegram-doctor --fix, then restart telegram-plugin."
} elseif ($status.active_thread_id -and $loadedThreads.Count -eq 1 -and ([string]$loadedThreads[0]) -ne ([string]$status.active_thread_id)) {
  $threadVisibilityStatus = "warn"
  $threadVisibilityDetail = "bound thread differs from loaded visible thread. Run telegram-doctor --fix, then restart telegram-plugin."
}
Add-Check -List $checks -Name "thread_visibility" -Status $threadVisibilityStatus -Detail $threadVisibilityDetail
Add-Check -List $checks -Name "frontend_owner" -Status $(if ($status.frontend_owner_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.frontend_owner_pid + " alive=" + [string]$status.frontend_owner_alive)
Add-Check -List $checks -Name "queue_notifier" -Status $(if (($null -eq $status.queue_notifier_pid) -or ($status.queue_notifier_alive)) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.queue_notifier_pid + " alive=" + [string]$status.queue_notifier_alive)
Add-Check -List $checks -Name "poller" -Status $(if ($status.poller_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.poller_pid + " alive=" + [string]$status.poller_alive)
Add-Check -List $checks -Name "dispatcher" -Status $(if ($status.dispatcher_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.dispatcher_pid + " alive=" + [string]$status.dispatcher_alive)
Add-Check -List $checks -Name "responder" -Status $(if ($status.responder_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.responder_pid + " alive=" + [string]$status.responder_alive)
$teamRelayMode = ([string]$status.team_relay_mode).ToLower()
$groupDeliveryMode = ([string]$status.group_delivery).ToLower()
$teamRelayConfigured = $status.team_relay_file -or $status.team_relay_url_configured
$teamRelayShouldRun = @("consume", "both") -contains $teamRelayMode
$teamRelayConfigStatus = if ($teamRelayMode -eq "off") { "ok" } elseif ($teamRelayConfigured) { "ok" } else { "warn" }
$teamRelayConfigDetail = "mode=" + [string]$status.team_relay_mode + " file=" + $(if ($status.team_relay_file) { [string]$status.team_relay_file } else { "-" }) + " url=" + $(if ($status.team_relay_url_configured) { "configured" } else { "-" })
Add-Check -List $checks -Name "team_relay_config" -Status $teamRelayConfigStatus -Detail $teamRelayConfigDetail
$teamRelayUrl = [string]$activeEnv["BLUN_TELEGRAM_TEAM_RELAY_URL"]
if ($teamRelayUrl) {
  $relayProbe = Test-TeamRelayUrl -Url $teamRelayUrl -Secret ([string]$activeEnv["BLUN_TELEGRAM_TEAM_RELAY_SECRET"])
  Add-Check -List $checks -Name "team_relay_url" -Status $(if ($relayProbe.ok) { "ok" } else { "warn" }) -Detail $relayProbe.detail
} elseif ($groupDeliveryMode -eq "observe") {
  Add-Check -List $checks -Name "team_relay_url" -Status "warn" -Detail "No shared relay URL. File relay only works when every agent reads the same absolute file path on the same host."
}
if ($groupDeliveryMode -eq "observe" -and $teamRelayMode -eq "off") {
  Add-Check -List $checks -Name "observe_team_relay" -Status "warn" -Detail "observe is enabled, but team relay is off. Other bots' messages may not reach this CLI."
} elseif ($groupDeliveryMode -eq "observe" -and -not $teamRelayConfigured) {
  Add-Check -List $checks -Name "observe_team_relay" -Status "warn" -Detail "observe is enabled, but no team relay file or URL is configured."
} else {
  Add-Check -List $checks -Name "observe_team_relay" -Status "ok" -Detail ("group_delivery=" + [string]$status.group_delivery + " relay_mode=" + [string]$status.team_relay_mode)
}
if ($teamRelayShouldRun -and $teamRelayConfigured) {
  Add-Check -List $checks -Name "team_relay_consumer" -Status $(if ($status.team_relay_alive) { "ok" } else { "warn" }) -Detail ("pid=" + [string]$status.team_relay_pid + " alive=" + [string]$status.team_relay_alive)
} else {
  Add-Check -List $checks -Name "team_relay_consumer" -Status "ok" -Detail "not required"
}

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

Add-Check -List $checks -Name "queue" -Status $(if (([int]$status.queue_depth -eq 0) -and ([int]$status.pending_reply_depth -eq 0)) { "ok" } else { "warn" }) -Detail ("queued=" + $status.queue_depth + " observe=" + $status.observe_queue_depth + " ambient=" + $status.ambient_queue_depth + " parked=" + $status.parked_queue_depth + " submitted=" + $status.submitted_depth + " pending_replies=" + $status.pending_reply_depth + " expired_pending_replies=" + $status.expired_pending_reply_depth)

$result = [ordered]@{
  profile = $status.profile
  overall = Get-OverallStatus -Checks $checks
  runtime_root = $runtimeRoot
  state_dir = $status.state_dir
  plugin_root = $status.plugin_root
  checks = $checks
  status = $status
}

if ($Fix) {
  $fixActions = Invoke-RuntimeFix -Status $status -RuntimeRoot $runtimeRoot
  $result["fix_actions"] = $fixActions
  if ($Json) {
    $result | ConvertTo-Json -Depth 8
    exit 0
  }
  Write-DoctorReport -Result $result -TokenSource $tokenSource -AllowedChatSource $allowedChatSource
  Write-Host ""
  Write-Host "Fix angewendet. Starte danach neu: blun-codex --profile $($result.profile) telegram-plugin" -ForegroundColor Yellow
  if ($fixActions.Count -gt 0) {
    Write-Host ("Aktionen: " + ($fixActions -join ", ")) -ForegroundColor DarkGray
  }
  exit 0
}

if ($Json) {
  $result | ConvertTo-Json -Depth 8
  exit 0
}

Write-DoctorReport -Result $result -TokenSource $tokenSource -AllowedChatSource $allowedChatSource
