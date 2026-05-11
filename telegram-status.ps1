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

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Join-Path $runtimeRoot ("profiles\" + $Profile.ToLower() + ".json")
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
$queue = @($state.queue)
$queued = @($queue | Where-Object { $_.status -eq "queued" })
$submitted = @($queue | Where-Object { $_.status -eq "submitted" })
$delivered = @($queue | Where-Object { $_.status -eq "delivered" })
$errors = @($queue | Where-Object { $_.status -eq "error" })
$pendingReplies = @($state.pendingReplies | Where-Object { -not $_.sentAt -and $_.status -ne "error" })
$pollerPid = if (Test-Path (Join-Path $stateDir "poller.pid")) { (Get-Content -Raw (Join-Path $stateDir "poller.pid")).Trim() } else { $null }
$dispatcherPid = if (Test-Path (Join-Path $stateDir "dispatcher.pid")) { (Get-Content -Raw (Join-Path $stateDir "dispatcher.pid")).Trim() } else { $null }
$responderPid = if (Test-Path (Join-Path $stateDir "responder.pid")) { (Get-Content -Raw (Join-Path $stateDir "responder.pid")).Trim() } else { $null }
$stateThreadId = if ($state.currentThreadId) { [string]$state.currentThreadId } else { "" }
$telegramPluginRoot = Get-TelegramPluginRoot -RuntimeRoot $runtimeRoot

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
  env_thread_id = $envFile["BLUN_TELEGRAM_THREAD_ID"]
  state_thread_id = $stateThreadId
  active_thread_id = if ($stateThreadId) { $stateThreadId } else { $envFile["BLUN_TELEGRAM_THREAD_ID"] }
  current_runtime = $currentRuntime
  loaded_threads = $loadedThreads
  queue_depth = $queued.Count
  submitted_depth = $submitted.Count
  pending_reply_depth = $pendingReplies.Count
  delivered_count = $delivered.Count
  error_count = $errors.Count
  history_count = $queue.Count
  last_inbound = $state.lastInbound
  last_outbound = $state.lastOutbound
  poller_pid = $pollerPid
  dispatcher_pid = $dispatcherPid
  responder_pid = $responderPid
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

$result | ConvertTo-Json -Depth 8
