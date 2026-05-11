param(
  [string]$Profile = "default"
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

$activeEnv = Read-DotEnvFile -Path (Join-Path $status.state_dir ".env")
$legacyEnv = Read-DotEnvFile -Path (Join-Path $env:USERPROFILE ".codex\channels\codexlink-telegram\.env")
$tokenSource = if ($activeEnv["BLUN_TELEGRAM_BOT_TOKEN"]) {
  "active_state_env"
} elseif ($legacyEnv["BLUN_TELEGRAM_BOT_TOKEN"]) {
  "legacy_env_fallback"
} else {
  ""
}
Add-Check -List $checks -Name "bot_token" -Status $(if ($tokenSource) { "ok" } else { "fail" }) -Detail $(if ($tokenSource) { $tokenSource } else { "No BLUN_TELEGRAM_BOT_TOKEN found in active or legacy env files." })

Add-Check -List $checks -Name "app_server_ws" -Status $(if ($status.active_ws) { "ok" } else { "warn" }) -Detail $(if ($status.active_ws) { $status.active_ws } else { "No active websocket recorded." })
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

Add-Check -List $checks -Name "queue" -Status $(if (([int]$status.queue_depth -eq 0) -and ([int]$status.pending_reply_depth -eq 0)) { "ok" } else { "warn" }) -Detail ("queued=" + $status.queue_depth + " submitted=" + $status.submitted_depth + " pending_replies=" + $status.pending_reply_depth)

$overall = "ok"
if (@($checks | Where-Object { $_.status -eq "fail" }).Count -gt 0) {
  $overall = "fail"
} elseif (@($checks | Where-Object { $_.status -eq "warn" }).Count -gt 0) {
  $overall = "warn"
}

[ordered]@{
  profile = $status.profile
  overall = $overall
  runtime_root = $runtimeRoot
  state_dir = $status.state_dir
  plugin_root = $status.plugin_root
  checks = $checks
  status = $status
} | ConvertTo-Json -Depth 8
