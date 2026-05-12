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
$state = Try-ReadJson -Path (Join-Path $stateDir "state.json")
$envFile = Read-DotEnvFile -Path (Join-Path $stateDir ".env")
$loadedThreads = @()
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
$ambientQueued = @($queued | Where-Object { [string]$_.relevance -eq "ambient" })
$escalationQueued = @($queued | Where-Object { [string]$_.relevance -eq "escalation" })
$submitted = @($queue | Where-Object { $_.status -eq "submitted" })
$delivered = @($queue | Where-Object { $_.status -eq "delivered" })
$errors = @($queue | Where-Object { $_.status -eq "error" })
$pendingReplies = @($state.pendingReplies | Where-Object { -not $_.sentAt -and @("error", "expired", "ignored_bot", "suppressed_ack", "superseded", "sent", "stale_thread") -notcontains $_.status })
$expiredPendingReplies = @($state.pendingReplies | Where-Object { $_.status -eq "expired" })
$pollerPid = if (Test-Path (Join-Path $stateDir "poller.pid")) { (Get-Content -Raw (Join-Path $stateDir "poller.pid")).Trim() } else { $null }
$dispatcherPid = if (Test-Path (Join-Path $stateDir "dispatcher.pid")) { (Get-Content -Raw (Join-Path $stateDir "dispatcher.pid")).Trim() } else { $null }
$responderPid = if (Test-Path (Join-Path $stateDir "responder.pid")) { (Get-Content -Raw (Join-Path $stateDir "responder.pid")).Trim() } else { $null }
$stateThreadId = if ($state.currentThreadId) { [string]$state.currentThreadId } else { "" }
$runtimeThreadId = if ($currentRuntime -and $currentRuntime.thread_id) { [string]$currentRuntime.thread_id } else { "" }
$telegramPluginRoot = Get-TelegramPluginRoot -RuntimeRoot $runtimeRoot
$dispatchMode = if ($envFile["BLUN_TELEGRAM_DISPATCH_MODE"]) { [string]$envFile["BLUN_TELEGRAM_DISPATCH_MODE"] } else { "deferred" }
$idleCooldownMs = if ($envFile["BLUN_TELEGRAM_IDLE_COOLDOWN_MS"]) { [int]$envFile["BLUN_TELEGRAM_IDLE_COOLDOWN_MS"] } else { 15000 }
$eligibleQueued = if ($dispatchMode -eq "legacy") {
  @($queued)
} else {
  @($queued | Where-Object {
    [string]$_.chatType -eq "private" -or @("direct", "lane", "escalation") -contains [string]$_.relevance
  })
}
$nextQueued = @(
  $eligibleQueued |
    Sort-Object `
      @{ Expression = {
          if ([string]$_.relevance -eq "escalation") { 0 }
          elseif ([string]$_.chatType -eq "private" -or @("direct", "lane") -contains [string]$_.relevance) { 1 }
          else { 2 }
        }
      },
      @{ Expression = { [string]$_.ts } },
      @{ Expression = { [int]$_.messageId } } |
    Select-Object -First 1
)
$nextPendingReply = @(
  $pendingReplies |
    Sort-Object `
      @{ Expression = { [string]$_.createdAt } },
      @{ Expression = { [int]$_.messageId } } |
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
  if ($pollerPid) {
    if ($currentRuntime.PSObject.Properties.Name.Contains("poller_pid")) {
      $currentRuntime.poller_pid = $pollerPid
    } else {
      $currentRuntime | Add-Member -NotePropertyName "poller_pid" -NotePropertyValue $pollerPid
    }
  }
  if ($dispatcherPid) {
    if ($currentRuntime.PSObject.Properties.Name.Contains("dispatcher_pid")) {
      $currentRuntime.dispatcher_pid = $dispatcherPid
    } else {
      $currentRuntime | Add-Member -NotePropertyName "dispatcher_pid" -NotePropertyValue $dispatcherPid
    }
  }
  if ($responderPid) {
    if ($currentRuntime.PSObject.Properties.Name.Contains("responder_pid")) {
      $currentRuntime.responder_pid = $responderPid
    } else {
      $currentRuntime | Add-Member -NotePropertyName "responder_pid" -NotePropertyValue $responderPid
    }
  }
}

if ($envFile["BLUN_TELEGRAM_APP_SERVER_WS_URL"] -and $telegramPluginRoot) {
  try {
    $bootstrapScript = Join-Path $telegramPluginRoot "app-server-cli.js"
    $loaded = & node $bootstrapScript "list-loaded" "--ws-url" $envFile["BLUN_TELEGRAM_APP_SERVER_WS_URL"] | ConvertFrom-Json
    $loadedThreads = @($loaded.data)
  } catch {
    $loadedThreads = @()
  }
}

$result = [ordered]@{
  profile = $profileAgent
  state_dir = $stateDir
  plugin_root = $telegramPluginRoot
  active_ws = $envFile["BLUN_TELEGRAM_APP_SERVER_WS_URL"]
  dispatch_mode = $dispatchMode
  idle_cooldown_ms = $idleCooldownMs
  ambient_queue_ttl_ms = $ambientQueueTtlMs
  pending_reply_timeout_ms = $(if ($envFile["BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS"]) { $envFile["BLUN_TELEGRAM_PENDING_REPLY_TIMEOUT_MS"] } else { "120000" })
  env_thread_id = $envFile["BLUN_TELEGRAM_THREAD_ID"]
  runtime_thread_id = $runtimeThreadId
  state_thread_id = $stateThreadId
  active_thread_id = if ($runtimeThreadId) { $runtimeThreadId } elseif ($envFile["BLUN_TELEGRAM_THREAD_ID"]) { $envFile["BLUN_TELEGRAM_THREAD_ID"] } else { $stateThreadId }
  frontend_owner_pid = $(if ($currentRuntime -and $currentRuntime.frontend_host_pid) { [string]$currentRuntime.frontend_host_pid } else { "" })
  queue_notifier_pid = $(if ($currentRuntime -and $currentRuntime.queue_notifier_pid) { [string]$currentRuntime.queue_notifier_pid } else { "" })
  current_runtime = $currentRuntime
  loaded_threads = $loadedThreads
  queue_depth = $queued.Count
  visible_waiting_depth = ($queued.Count + $pendingReplies.Count)
  direct_queue_depth = $directQueued.Count
  ambient_queue_depth = $ambientQueued.Count
  escalation_queue_depth = $escalationQueued.Count
  parked_queue_depth = $staleAmbientQueued.Count
  submitted_depth = $submitted.Count
  pending_reply_depth = $pendingReplies.Count
  expired_pending_reply_depth = $expiredPendingReplies.Count
  delivered_count = $delivered.Count
  error_count = $errors.Count
  history_count = $queue.Count
  last_inbound = $state.lastInbound
  last_outbound = $state.lastOutbound
  poller_pid = $pollerPid
  dispatcher_pid = $dispatcherPid
  responder_pid = $responderPid
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

if ($result.poller_pid) {
  $result["poller_alive"] = Test-PidAlive -ProcId ([int]$result.poller_pid)
}
if ($result.dispatcher_pid) {
  $result["dispatcher_alive"] = Test-PidAlive -ProcId ([int]$result.dispatcher_pid)
}
if ($result.responder_pid) {
  $result["responder_alive"] = Test-PidAlive -ProcId ([int]$result.responder_pid)
}
if ($result.frontend_owner_pid) {
  $result["frontend_owner_alive"] = Test-PidAlive -ProcId ([int]$result.frontend_owner_pid)
}
if ($result.queue_notifier_pid) {
  $result["queue_notifier_alive"] = Test-PidAlive -ProcId ([int]$result.queue_notifier_pid)
}

$result | ConvertTo-Json -Depth 8
