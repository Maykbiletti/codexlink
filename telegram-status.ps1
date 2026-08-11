param(
  [string]$Profile = "default"
)

$ErrorActionPreference = "Stop"

function Try-ReadJson {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Path $Path | ConvertFrom-Json } catch { return $null }
}

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

function Get-DefaultTeamRelayFile {
  if ($env:ProgramData) {
    return (Join-Path $env:ProgramData "Blun\codexlink\blun-team-relay.jsonl")
  }
  return (Join-Path $env:USERPROFILE ".codex\channels\blun-team-relay.jsonl")
}

function Test-PidAlive {
  param([int]$ProcId)
  if ($ProcId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

function Normalize-Preview {
  param([string]$Value, [int]$MaxLength = 72)
  $text = [string]$Value
  $text = $text -replace "\s+", " "
  $text = $text.Trim()
  if (-not $text) { return "" }
  if ($text.Length -le $MaxLength) { return $text }
  return ($text.Substring(0, [Math]::Max(0, $MaxLength - 3)).TrimEnd() + "...")
}

function Get-IsoAgeMs {
  param([string]$IsoString)
  if (-not $IsoString) { return [double]::PositiveInfinity }
  try {
    $parsed = [DateTimeOffset]::Parse($IsoString)
    return [Math]::Max(0, ([DateTimeOffset]::UtcNow - $parsed.ToUniversalTime()).TotalMilliseconds)
  } catch {
    return [double]::PositiveInfinity
  }
}

function Resolve-ConfiguredPath {
  param([string]$Value, [string]$RuntimeRoot)
  if (-not $Value) { return "" }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ([System.IO.Path]::IsPathRooted($expanded)) { return $expanded }
  return [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot $expanded))
}

function Get-TelegramPluginRoot {
  param([string]$RuntimeRoot)

  $candidates = @()
  if ($env:BLUN_CODEX_TELEGRAM_PLUGIN_ROOT) {
    $candidates += $env:BLUN_CODEX_TELEGRAM_PLUGIN_ROOT
  }
  $candidates += (Join-Path $RuntimeRoot "telegram-plugin")

  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    if ((Test-Path (Join-Path $candidate "app-server-cli.js")) -and (Test-Path (Join-Path $candidate "sidecar-manager.js"))) {
      return $candidate
    }
  }

  return $null
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
$profileJson = Try-ReadJson -Path $profilePath
$profileAgent = if ($profileJson -and $profileJson.agent_name) { [string]$profileJson.agent_name } else { $Profile.ToLower() }
$runtimeDir = Join-Path $env:USERPROFILE (".codex\\runtimes\\" + $profileAgent)
$stateDir = if ($profileJson -and $profileJson.telegram -and $profileJson.telegram.state_dir) {
  Resolve-ConfiguredPath -Value ([string]$profileJson.telegram.state_dir) -RuntimeRoot $runtimeRoot
} else {
  Join-Path $env:USERPROFILE (".codex\\channels\\telegram-" + $profileAgent)
}
$currentRuntime = Try-ReadJson -Path (Join-Path $runtimeDir "current-remote-runtime.json")
$stateFile = Join-Path $stateDir "state.json"
$stateBackupFile = Join-Path $stateDir "state.json.bak"
$stateRecoveryFile = Join-Path $stateDir "state-recovery-required.json"
$state = Try-ReadJson -Path $stateFile
$stateBackup = Try-ReadJson -Path $stateBackupFile
$stateRecovery = Try-ReadJson -Path $stateRecoveryFile
$stateValid = $null -ne $state -and $state.PSObject.Properties.Name.Contains("offset") -and $null -ne $state.offset
$stateBackupValid = $null -ne $stateBackup -and $stateBackup.PSObject.Properties.Name.Contains("offset") -and $null -ne $stateBackup.offset
$envFile = Read-DotEnvFile -Path (Join-Path $stateDir ".env")
$loadedThreads = @()
$activeWsReachable = $false
$ambientQueueTtlMs = if ($envFile["BLUN_TELEGRAM_AMBIENT_QUEUE_TTL_MS"]) { [int]$envFile["BLUN_TELEGRAM_AMBIENT_QUEUE_TTL_MS"] } else { 600000 }
$queue = @($state.queue)
$staleAmbientQueued = @($queue | Where-Object {
  $_.status -eq "queued" -and
  [string]$_.relevance -eq "ambient" -and
  (Get-IsoAgeMs -IsoString ([string]$_.ts)) -ge $ambientQueueTtlMs
})
$queued = @($queue | Where-Object {
  if ($_.status -ne "queued") { return $false }
  if ([string]$_.relevance -eq "ambient" -and (Get-IsoAgeMs -IsoString ([string]$_.ts)) -ge $ambientQueueTtlMs) { return $false }
  return $true
})
$directQueued = @($queued | Where-Object { @("direct", "lane") -contains [string]$_.relevance })
$observeQueued = @($queued | Where-Object { [string]$_.relevance -eq "observe" })
$ambientQueued = @($queued | Where-Object { [string]$_.relevance -eq "ambient" })
$escalationQueued = @($queued | Where-Object { [string]$_.relevance -eq "escalation" })
$submitted = @($queue | Where-Object { $_.status -eq "submitted" })
$injecting = @($queue | Where-Object { $_.status -eq "injecting" })
$injectingAges = @($injecting | ForEach-Object {
  $startedAt = if ($_.injectStartedAt) { [string]$_.injectStartedAt } elseif ($_.lastAttemptAt) { [string]$_.lastAttemptAt } else { [string]$_.ts }
  Get-IsoAgeMs -IsoString $startedAt
})
$oldestInjectingAgeMs = if ($injectingAges.Count -gt 0) { [math]::Round(($injectingAges | Measure-Object -Maximum).Maximum) } else { 0 }
$delivered = @($queue | Where-Object { @("delivered", "replied") -contains $_.status })
$errors = @($queue | Where-Object { @("error", "failed") -contains $_.status })
$pendingReplies = @($state.pendingReplies | Where-Object { -not $_.sentAt -and @("error", "expired", "ignored_bot", "suppressed_ack", "superseded", "sent", "stale_thread", "aborted", "no_reply_completed", "suppressed_private_reply") -notcontains $_.status })
$expiredPendingReplies = @($state.pendingReplies | Where-Object { $_.status -eq "expired" })
$runtimePid = if (Test-Path (Join-Path $stateDir "runtime-daemon.pid")) { (Get-Content -Raw (Join-Path $stateDir "runtime-daemon.pid")).Trim() } else { $null }
$stateThreadId = if ($state.currentThreadId) { [string]$state.currentThreadId } else { "" }
$runtimeThreadId = if ($currentRuntime -and $currentRuntime.thread_id) { [string]$currentRuntime.thread_id } else { "" }
$telegramPluginRoot = Get-TelegramPluginRoot -RuntimeRoot $runtimeRoot
$dispatchMode = if ($envFile["BLUN_TELEGRAM_DISPATCH_MODE"]) { [string]$envFile["BLUN_TELEGRAM_DISPATCH_MODE"] } else { "deferred" }
$groupDeliveryMode = if ($envFile["BLUN_TELEGRAM_GROUP_DELIVERY"]) { [string]$envFile["BLUN_TELEGRAM_GROUP_DELIVERY"] } else { "observe" }
$teamRelayUrl = if ($envFile["BLUN_TELEGRAM_TEAM_RELAY_URL"]) { [string]$envFile["BLUN_TELEGRAM_TEAM_RELAY_URL"] } else { "" }
$teamRelayMode = if ($envFile["BLUN_TELEGRAM_TEAM_RELAY_MODE"]) { [string]$envFile["BLUN_TELEGRAM_TEAM_RELAY_MODE"] } else { "off" }
$defaultTeamRelayFile = Get-DefaultTeamRelayFile
$teamRelayFile = if ($envFile["BLUN_TELEGRAM_TEAM_RELAY_FILE"]) { [string]$envFile["BLUN_TELEGRAM_TEAM_RELAY_FILE"] } elseif ($teamRelayUrl) { "" } else { $defaultTeamRelayFile }
if ($teamRelayFile -and -not $teamRelayUrl) {
  $legacyDefaultFile = Join-Path $env:USERPROFILE ".codex\channels\blun-team-relay.jsonl"
  try {
    $currentRelayFile = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($teamRelayFile))
    $legacyRelayFile = [System.IO.Path]::GetFullPath($legacyDefaultFile)
    if ([string]::Equals($currentRelayFile, $legacyRelayFile, [System.StringComparison]::OrdinalIgnoreCase)) {
      $teamRelayFile = $defaultTeamRelayFile
    }
  } catch {
  }
}
$idleCooldownMs = if ($envFile["BLUN_TELEGRAM_IDLE_COOLDOWN_MS"]) { [int]$envFile["BLUN_TELEGRAM_IDLE_COOLDOWN_MS"] } else { 3000 }
$eligibleQueued = if ($dispatchMode -eq "legacy") {
  @($queued)
} else {
  @($queued | Where-Object {
    [string]$_.chatType -eq "private" -or @("direct", "lane", "escalation", "observe") -contains [string]$_.relevance
  })
}
$nextQueued = @(
  $eligibleQueued |
    Sort-Object `
      @{ Expression = {
          if ([string]$_.relevance -eq "escalation") { 0 }
          elseif ([string]$_.chatType -eq "private" -or @("direct", "lane") -contains [string]$_.relevance) { 1 }
          elseif ([string]$_.relevance -eq "observe") { 2 }
          else { 3 }
        }
      },
      @{ Expression = { [string]$_.ts } },
      @{ Expression = { [string]$_.messageId } } |
    Select-Object -First 1
)
$nextPendingReply = @(
  $pendingReplies |
    Sort-Object `
      @{ Expression = { [string]$_.createdAt } },
      @{ Expression = { [string]$_.messageId } } |
    Select-Object -First 1
)
$waitReason = if ($pendingReplies.Count -gt 0) {
  "wartet auf Antwort"
} elseif ($queued.Count -eq 0) {
  $null
} elseif ($state.lastInjectAt -and (Get-IsoAgeMs -IsoString ([string]$state.lastInjectAt)) -lt $idleCooldownMs) {
  "wartet auf Ruhe"
} else {
  "wartet in Queue"
}

if ($currentRuntime) {
  if ($stateThreadId) {
    if ($currentRuntime.PSObject.Properties.Name.Contains("thread_id")) {
      $currentRuntime.thread_id = $stateThreadId
    } else {
      $currentRuntime | Add-Member -NotePropertyName "thread_id" -NotePropertyValue $stateThreadId
    }
  }
  if ($runtimePid) {
    if ($currentRuntime.PSObject.Properties.Name.Contains("runtime_pid")) {
      $currentRuntime.runtime_pid = $runtimePid
    } else {
      $currentRuntime | Add-Member -NotePropertyName "runtime_pid" -NotePropertyValue $runtimePid
    }
  }
}

if ($envFile["BLUN_TELEGRAM_APP_SERVER_WS_URL"] -and $telegramPluginRoot) {
  try {
    $bootstrapScript = Join-Path $telegramPluginRoot "app-server-cli.js"
    $loadedRaw = & node $bootstrapScript "list-loaded" "--ws-url" $envFile["BLUN_TELEGRAM_APP_SERVER_WS_URL"] 2>$null
    if ($LASTEXITCODE -eq 0 -and $loadedRaw) {
      $loaded = $loadedRaw | ConvertFrom-Json
      $loadedThreads = @($loaded.data | Where-Object { $_ })
      $activeWsReachable = $true
    } else {
      $loadedThreads = @()
      $activeWsReachable = $false
    }
  } catch {
    $loadedThreads = @()
    $activeWsReachable = $false
  }
}

$result = [ordered]@{
  profile = $profileAgent
  state_dir = $stateDir
  plugin_root = $telegramPluginRoot
  active_ws = $envFile["BLUN_TELEGRAM_APP_SERVER_WS_URL"]
  active_ws_reachable = $activeWsReachable
  dispatch_mode = $dispatchMode
  group_delivery = $groupDeliveryMode
  team_relay_mode = $teamRelayMode
  team_relay_file = $teamRelayFile
  team_relay_url_configured = [bool]$teamRelayUrl
  idle_cooldown_ms = $idleCooldownMs
  ambient_queue_ttl_ms = $ambientQueueTtlMs
  pending_reply_timeout_ms = $(if ($envFile["BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS"]) { $envFile["BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS"] } else { "1800000" })
  env_thread_id = $envFile["BLUN_TELEGRAM_THREAD_ID"]
  runtime_thread_id = $runtimeThreadId
  state_thread_id = $stateThreadId
  active_thread_id = if ($runtimeThreadId) { $runtimeThreadId } elseif ($envFile["BLUN_TELEGRAM_THREAD_ID"]) { $envFile["BLUN_TELEGRAM_THREAD_ID"] } else { $stateThreadId }
  frontend_owner_pid = $(if ($currentRuntime -and $currentRuntime.frontend_host_pid) { [string]$currentRuntime.frontend_host_pid } else { "" })
  queue_notifier_pid = $(if ($currentRuntime -and $currentRuntime.queue_notifier_pid) { [string]$currentRuntime.queue_notifier_pid } else { "" })
  current_runtime = $currentRuntime
  state_file_exists = (Test-Path $stateFile)
  state_valid = $stateValid
  state_backup_valid = $stateBackupValid
  state_recovery_required = ($null -ne $stateRecovery)
  state_recovery = $stateRecovery
  intake_stopped = [bool]($stateRecovery -and $stateRecovery.intakeStopped)
  loaded_threads = $loadedThreads
  queue_depth = $queued.Count
  visible_waiting_depth = ($queued.Count + $injecting.Count + $pendingReplies.Count)
  direct_queue_depth = $directQueued.Count
  observe_queue_depth = $observeQueued.Count
  ambient_queue_depth = $ambientQueued.Count
  escalation_queue_depth = $escalationQueued.Count
  parked_queue_depth = $staleAmbientQueued.Count
  submitted_depth = $submitted.Count
  injecting_depth = $injecting.Count
  oldest_injecting_age_ms = $oldestInjectingAgeMs
  pending_reply_depth = $pendingReplies.Count
  expired_pending_reply_depth = $expiredPendingReplies.Count
  delivered_count = $delivered.Count
  error_count = $errors.Count
  history_count = $queue.Count
  last_inbound = $state.lastInbound
  last_outbound = $state.lastOutbound
  runtime_pid = $runtimePid
  next_queued = if ($nextQueued.Count -gt 0) {
    [ordered]@{
      chat_id = $nextQueued[0].chatId
      message_id = $nextQueued[0].messageId
      relevance = $nextQueued[0].relevance
      preview = Normalize-Preview -Value ([string]$nextQueued[0].text)
    }
  } else {
    $null
  }
  pending_message = if ($nextPendingReply.Count -gt 0) {
    [ordered]@{
      chat_id = $nextPendingReply[0].chatId
      message_id = $nextPendingReply[0].messageId
      relevance = $nextPendingReply[0].relevance
      preview = Normalize-Preview -Value ([string]$nextPendingReply[0].sourceText)
    }
  } else {
    $null
  }
  wait_reason = $waitReason
}

if ($result.runtime_pid) {
  $result["runtime_alive"] = Test-PidAlive -ProcId ([int]$result.runtime_pid)
}
if ($result.frontend_owner_pid) {
  $result["frontend_owner_alive"] = Test-PidAlive -ProcId ([int]$result.frontend_owner_pid)
}
if ($result.queue_notifier_pid) {
  $result["queue_notifier_alive"] = Test-PidAlive -ProcId ([int]$result.queue_notifier_pid)
}

$result | ConvertTo-Json -Depth 8
