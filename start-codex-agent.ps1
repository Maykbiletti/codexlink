param(
  [Parameter(Mandatory = $true)]
  [string]$Agent,

  [string]$Prompt = "",
  [string]$Workspace = "",
  [ValidateSet("inherit", "plugin", "off")]
  [string]$TelegramMode = "inherit",
  [switch]$PrintOnly,
  [switch]$RemoteControl,
  [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = "Stop"

function Get-JsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "Profile not found: $Path"
  }
  return Get-Content -Raw -Path $Path | ConvertFrom-Json
}

function Try-GetJsonFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return $null
  }
  try {
    return Get-Content -Raw -Path $Path | ConvertFrom-Json
  } catch {
    return $null
  }
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

function Ensure-Dir {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Set-EnvVar {
  param([string]$Name, [string]$Value)
  if ($null -ne $Value -and $Value -ne "") {
    [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  }
}

function Resolve-ConfiguredPath {
  param([string]$Value)
  if (-not $Value) {
    return ""
  }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ([System.IO.Path]::IsPathRooted($expanded)) {
    return $expanded
  }
  return [System.IO.Path]::GetFullPath((Join-Path $runtimeRoot $expanded))
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

  throw "Unable to locate the Telegram plugin root. Set BLUN_CODEX_TELEGRAM_PLUGIN_ROOT or include telegram-plugin beside the runtime."
}

function Get-FreeTcpPort {
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try {
    return $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
}

function Stop-ProcessTree {
  param([int[]]$RootIds)

  $all = @(Get-CimInstance Win32_Process)
  $targets = New-Object System.Collections.Generic.HashSet[int]
  $queue = New-Object System.Collections.Generic.Queue[int]

  foreach ($rootId in $RootIds) {
    if ($rootId -gt 0 -and $targets.Add($rootId)) {
      $queue.Enqueue($rootId)
    }
  }

  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    foreach ($proc in $all) {
      if ($proc.ParentProcessId -eq $current) {
        if ($targets.Add([int]$proc.ProcessId)) {
          $queue.Enqueue([int]$proc.ProcessId)
        }
      }
    }
  }

  $ordered = @($targets) | Sort-Object -Descending
  foreach ($procId in $ordered) {
    try {
      Stop-Process -Id $procId -Force -ErrorAction Stop
    } catch {
    }
  }
}

function Wait-TcpPort {
  param(
    [string]$HostName,
    [int]$Port,
    [int]$TimeoutMs = 15000
  )

  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $client = [System.Net.Sockets.TcpClient]::new()
      $task = $client.ConnectAsync($HostName, $Port)
      $connected = $task.Wait(350)
      if ($connected -and $client.Connected) {
        $client.Dispose()
        return $true
      }
      $client.Dispose()
    } catch {
    }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

function Read-DotEnvFile {
  param([string]$Path)
  $values = @{}
  if (-not (Test-Path $Path)) {
    return $values
  }
  foreach ($line in (Get-Content -Path $Path)) {
    if (-not $line) { continue }
    if ($line.Trim().StartsWith("#")) { continue }
    $parts = $line -split "=", 2
    if ($parts.Count -ne 2) { continue }
    $values[$parts[0].Trim()] = $parts[1]
  }
  return $values
}

function Write-DotEnvFile {
  param(
    [string]$Path,
    [hashtable]$Values
  )

  $lines = foreach ($key in ($Values.Keys | Sort-Object)) {
    "$key=$($Values[$key])"
  }
  Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Write-TextFileWithRetry {
  param(
    [string]$Path,
    [string]$Content,
    [int]$Attempts = 6,
    [int]$DelayMs = 120
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      Set-Content -Path $Path -Value $Content -Encoding UTF8
      return
    } catch {
      if ($attempt -eq $Attempts) { throw }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Append-TextFileWithRetry {
  param(
    [string]$Path,
    [string]$Content,
    [int]$Attempts = 6,
    [int]$DelayMs = 120
  )
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try {
      Add-Content -Path $Path -Value $Content -Encoding UTF8
      return
    } catch {
      if ($attempt -eq $Attempts) { throw }
      Start-Sleep -Milliseconds $DelayMs
    }
  }
}

function Read-PidFileValue {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return 0
  }
  try {
    return [int]((Get-Content -Raw -Path $Path).Trim())
  } catch {
    return 0
  }
}

function Write-DebugStage {
  param(
    [string]$Path,
    [string]$Message
  )
  $line = ((Get-Date).ToUniversalTime().ToString("o")) + " " + $Message
  Append-TextFileWithRetry -Path $Path -Content ($line + "`n")
}

function Invoke-NodeJsonWithRetry {
  param(
    [string[]]$NodeArgs,
    [int]$Attempts = 12,
    [int]$DelayMs = 500
  )

  $lastRaw = $null
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    $stdoutPath = Join-Path $env:TEMP ("blun-codex-node-" + [guid]::NewGuid().ToString() + ".stdout.log")
    $stderrPath = Join-Path $env:TEMP ("blun-codex-node-" + [guid]::NewGuid().ToString() + ".stderr.log")
    $argLine = ($NodeArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join " "
    $proc = Start-Process -FilePath "node" -ArgumentList $argLine -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -Wait -PassThru
    $stdoutText = if (Test-Path $stdoutPath) { Get-Content -Raw $stdoutPath } else { "" }
    $stderrText = if (Test-Path $stderrPath) { Get-Content -Raw $stderrPath } else { "" }
    Remove-Item $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
    $lastRaw = ($stdoutText + $stderrText).Trim()
    if ($proc.ExitCode -eq 0 -and $stdoutText.Trim()) {
      return ($stdoutText | ConvertFrom-Json)
    }
    if ($attempt -lt $Attempts) {
      Start-Sleep -Milliseconds $DelayMs
    }
  }

  throw ("Node command failed after retries: " + ($NodeArgs -join " ") + "`n" + ($lastRaw | Out-String))
}

function Quote-TomlLiteral {
  param([string]$Value)
  if ($null -eq $Value) {
    return $null
  }
  return "'" + ($Value -replace "'", "''") + "'"
}

function Quote-PowerShellLiteral {
  param([string]$Value)
  if ($null -eq $Value) {
    return "''"
  }
  return "'" + ($Value -replace "'", "''") + "'"
}

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Get-ProfilePath -RuntimeRoot $runtimeRoot -ProfileName $Agent
$profile = Get-JsonFile -Path $profilePath

$resolvedWorkspace = if ($Workspace) { $Workspace } elseif ($profile.workspace) { $profile.workspace } else { (Get-Location).Path }
$resolvedWorkspace = Resolve-ConfiguredPath -Value $resolvedWorkspace
if (-not $resolvedWorkspace) {
  throw "No workspace configured for agent $Agent"
}

$agentRuntimeDir = Join-Path $env:USERPROFILE (".codex\runtimes\" + $profile.agent_name)
Ensure-Dir -Path $agentRuntimeDir
$debugLogPath = Join-Path $agentRuntimeDir "launch-debug.log"
Write-DebugStage -Path $debugLogPath -Message ("START agent=" + $profile.agent_name + " telegram_mode=" + $TelegramMode + " print_only=" + [string]$PrintOnly + " remote_control=" + [string]$RemoteControl)

$launchAt = (Get-Date).ToUniversalTime().ToString("o")
$launchManifest = [ordered]@{
  agent_name = $profile.agent_name
  display_name = $profile.display_name
  workspace = $resolvedWorkspace
  model = $profile.model
  reasoning_effort = $profile.reasoning_effort
  sandbox = $profile.sandbox
  approval_policy = $profile.approval_policy
  remote_control = [bool]$RemoteControl
  prompt = $Prompt
  extra_args = @($ExtraArgs)
  launched_at = $launchAt
  profile_path = $profilePath
}

$lastLaunchPath = Join-Path $agentRuntimeDir "last-launch.json"
$launchHistoryPath = Join-Path $agentRuntimeDir "launch-history.jsonl"
Write-TextFileWithRetry -Path $lastLaunchPath -Content ($launchManifest | ConvertTo-Json -Depth 8)
Append-TextFileWithRetry -Path $launchHistoryPath -Content (($launchManifest | ConvertTo-Json -Compress -Depth 8) + "`n")

Set-EnvVar "BLUN_CODEX_AGENT" $profile.agent_name
Set-EnvVar "BLUN_CODEX_DISPLAY_NAME" $profile.display_name
Set-EnvVar "BLUN_CODEX_PROFILE_PATH" $profilePath
Set-EnvVar "BLUN_CODEX_RUNTIME_DIR" $agentRuntimeDir
Set-EnvVar "BLUN_CODEX_LANE" $profile.lane
Set-EnvVar "BLUN_CODEX_MODEL" $profile.model
Set-EnvVar "BLUN_CODEX_REASONING_EFFORT" $profile.reasoning_effort
Set-EnvVar "BLUN_CODEX_PERSONALITY" $profile.personality

$mnemoInherit = $false
$mnemoCwdOverride = $null
$mnemoEnvOverride = $null

if ($null -ne $profile.mnemo -and $profile.mnemo.inherit -eq $true) {
  $mnemoInherit = $true
}

if (-not $mnemoInherit -and $null -ne $profile.mnemo) {
  $effectiveDefaultAgent = if ($profile.mnemo.default_agent) { $profile.mnemo.default_agent } else { $profile.agent_name }
  $effectiveAgent = if ($profile.mnemo.agent) { $profile.mnemo.agent } else { $profile.agent_name }

  Set-EnvVar "MNEMO_DEFAULT_AGENT" $effectiveDefaultAgent
  Set-EnvVar "MNEMO_AGENT" $effectiveAgent
  Set-EnvVar "MNEMO_DB" $profile.mnemo.db
  Set-EnvVar "MNEMO_TENANT_ROOT" $profile.mnemo.tenant_root
  Set-EnvVar "MNEMO_OWNER_NAME" $profile.mnemo.owner_name
  if ($null -ne $profile.mnemo.timezone_offset_hours) {
    Set-EnvVar "MNEMO_TZ_OFFSET_HOURS" ([string]$profile.mnemo.timezone_offset_hours)
  }
  if ($null -ne $profile.mnemo.local_agents) {
    Set-EnvVar "MNEMO_LOCAL_AGENTS" (($profile.mnemo.local_agents) -join ",")
  }
  Set-EnvVar "MNEMO_DEFAULT_SCOPE" $profile.mnemo.default_scope
  Set-EnvVar "MNEMO_SCOPE" $profile.mnemo.scope
  $mnemoCwdOverride = $profile.mnemo.cwd

  $mnemoEnvPairs = @()
  $mnemoEnvPairs += "MNEMO_DEFAULT_AGENT = $(Quote-TomlLiteral $effectiveDefaultAgent)"
  $mnemoEnvPairs += "MNEMO_AGENT = $(Quote-TomlLiteral $effectiveAgent)"
  if ($profile.mnemo.db) {
    $mnemoEnvPairs += "MNEMO_DB = $(Quote-TomlLiteral $profile.mnemo.db)"
  }
  if ($profile.mnemo.tenant_root) {
    $mnemoEnvPairs += "MNEMO_TENANT_ROOT = $(Quote-TomlLiteral $profile.mnemo.tenant_root)"
  }
  if ($profile.mnemo.owner_name) {
    $mnemoEnvPairs += "MNEMO_OWNER_NAME = $(Quote-TomlLiteral $profile.mnemo.owner_name)"
  }
  if ($null -ne $profile.mnemo.timezone_offset_hours) {
    $mnemoEnvPairs += "MNEMO_TZ_OFFSET_HOURS = $(Quote-TomlLiteral ([string]$profile.mnemo.timezone_offset_hours))"
  }
  if ($null -ne $profile.mnemo.local_agents -and $profile.mnemo.local_agents.Count -gt 0) {
    $mnemoEnvPairs += "MNEMO_LOCAL_AGENTS = $(Quote-TomlLiteral (($profile.mnemo.local_agents) -join ','))"
  }
  if ($profile.mnemo.default_scope) {
    $mnemoEnvPairs += "MNEMO_DEFAULT_SCOPE = $(Quote-TomlLiteral $profile.mnemo.default_scope)"
  }
  if ($profile.mnemo.scope) {
    $mnemoEnvPairs += "MNEMO_SCOPE = $(Quote-TomlLiteral $profile.mnemo.scope)"
  }
  if ($mnemoEnvPairs.Count -gt 0) {
    $mnemoEnvOverride = "mcp_servers.mnemo.env={" + ($mnemoEnvPairs -join ", ") + "}"
  }
}

$telegramEnvOverride = $null
$telegramEnabled = $false
$telegramStateDir = $null
$telegramAllowedChatId = $null
$telegramAppServerWsUrl = $null

if ($null -ne $profile.telegram) {
  $telegramEnabled = ($profile.telegram.enabled -eq $true)
  $telegramStateDir = $profile.telegram.state_dir
  $telegramAllowedChatId = $profile.telegram.allowed_chat_id
}

if ($TelegramMode -eq "plugin") {
  $telegramEnabled = $true
} elseif ($TelegramMode -eq "off") {
  $telegramEnabled = $false
}

if (-not $telegramStateDir) {
  $telegramStateDir = Join-Path $env:USERPROFILE (".codex\channels\telegram-" + $profile.agent_name)
} else {
  $telegramStateDir = Resolve-ConfiguredPath -Value $telegramStateDir
}

$telegramExistingEnv = @{}
if ($telegramStateDir) {
  Ensure-Dir -Path $telegramStateDir
  $telegramExistingEnv = Read-DotEnvFile -Path (Join-Path $telegramStateDir ".env")
}

if (-not $telegramAllowedChatId -and $telegramExistingEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]) {
  $telegramAllowedChatId = [string]$telegramExistingEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]
}

if ($telegramEnabled) {
  Set-EnvVar "BLUN_TELEGRAM_AGENT_NAME" $profile.agent_name
  Set-EnvVar "BLUN_TELEGRAM_STATE_DIR" $telegramStateDir
  Set-EnvVar "BLUN_TELEGRAM_ALLOWED_CHAT_ID" $telegramAllowedChatId
  Set-EnvVar "BLUN_TELEGRAM_PLUGIN_MODE" $TelegramMode
  $telegramEnvPairs = @()
  $telegramEnvPairs += "BLUN_TELEGRAM_AGENT_NAME = $(Quote-TomlLiteral $profile.agent_name)"
  $telegramEnvPairs += "BLUN_TELEGRAM_STATE_DIR = $(Quote-TomlLiteral $telegramStateDir)"
  $telegramEnvPairs += "BLUN_TELEGRAM_PLUGIN_MODE = $(Quote-TomlLiteral $TelegramMode)"
  if ($telegramAllowedChatId) {
    $telegramEnvPairs += "BLUN_TELEGRAM_ALLOWED_CHAT_ID = $(Quote-TomlLiteral $telegramAllowedChatId)"
  }
  $telegramEnvOverride = "mcp_servers.codexlink_telegram.env={" + ($telegramEnvPairs -join ", ") + "}"
}

$useRemoteAppServer = ($TelegramMode -eq "plugin")

$mnemoOverrides = @()
if ($mnemoCwdOverride) {
  $mnemoOverrides += "-c"
  $mnemoOverrides += ("mcp_servers.mnemo.cwd=" + (Quote-TomlLiteral $mnemoCwdOverride))
}

if ($mnemoEnvOverride) {
  $mnemoOverrides += "-c"
  $mnemoOverrides += $mnemoEnvOverride
}

$commonOverrides = @() + $mnemoOverrides
if ($telegramEnvOverride) {
  $commonOverrides += "-c"
  $commonOverrides += $telegramEnvOverride
}

$codexArgs = @()

if ($profile.reasoning_effort) {
  $codexArgs += "-c"
  $codexArgs += ("model_reasoning_effort=""" + $profile.reasoning_effort + """")
}

if ($profile.personality) {
  $codexArgs += "-c"
  $codexArgs += ("personality=""" + $profile.personality + """")
}

if ($profile.sandbox) {
  $codexArgs += "--sandbox"
  $codexArgs += $profile.sandbox
}

if ($profile.approval_policy) {
  $codexArgs += "-a"
  $codexArgs += $profile.approval_policy
}

if ($ExtraArgs.Count -gt 0) {
  $codexArgs += $ExtraArgs
}

$remoteSessionInfo = $null
$backendArgs = @()
$envFilePath = $null
$appServerInfoFile = $null
$bootstrapScript = $null
$sidecarManager = $null

if ($useRemoteAppServer) {
  Write-DebugStage -Path $debugLogPath -Message "REMOTE_MODE enabled"
  $telegramPluginRoot = Get-TelegramPluginRoot -RuntimeRoot $runtimeRoot
  $port = Get-FreeTcpPort
  $telegramAppServerWsUrl = "ws://127.0.0.1:$port"
  $backendArgs = @("app-server", "--listen", $telegramAppServerWsUrl)
  if ($PrintOnly) {
    Write-DebugStage -Path $debugLogPath -Message ("PRINT_ONLY remote ws_url=" + $telegramAppServerWsUrl)
    $remoteSessionInfo = [ordered]@{
      ws_url = $telegramAppServerWsUrl
      thread_id = "{{THREAD_ID}}"
      pid = 0
      started_at = $null
      preview = $true
    }
    $codexArgs += "--remote"
    $codexArgs += $telegramAppServerWsUrl
  } else {
    $envFilePath = Join-Path $telegramStateDir ".env"
    $stateEnv = Read-DotEnvFile -Path $envFilePath
    $stateEnv["BLUN_TELEGRAM_AGENT_NAME"] = $profile.agent_name
    $stateEnv["BLUN_TELEGRAM_STATE_DIR"] = $telegramStateDir
    if ($telegramAllowedChatId) {
      $stateEnv["BLUN_TELEGRAM_ALLOWED_CHAT_ID"] = $telegramAllowedChatId
    }
    $stateEnv["BLUN_TELEGRAM_PLUGIN_MODE"] = $TelegramMode
    $stateEnv["BLUN_TELEGRAM_APP_SERVER_WS_URL"] = $telegramAppServerWsUrl
    $stateEnv["BLUN_TELEGRAM_THREAD_ID"] = ""
    Write-DotEnvFile -Path $envFilePath -Values $stateEnv
    Write-DebugStage -Path $debugLogPath -Message ("ENV_WRITTEN ws_url=" + $telegramAppServerWsUrl + " env_file=" + $envFilePath)
    $telegramStateFile = Join-Path $telegramStateDir "state.json"
    $telegramState = Try-GetJsonFile -Path $telegramStateFile
    if ($null -ne $telegramState) {
      if ($telegramState.PSObject.Properties.Name.Contains("currentThreadId")) {
        $telegramState.currentThreadId = ""
      } else {
        $telegramState | Add-Member -NotePropertyName "currentThreadId" -NotePropertyValue ""
      }
      Write-TextFileWithRetry -Path $telegramStateFile -Content ($telegramState | ConvertTo-Json -Depth 10)
      Write-DebugStage -Path $debugLogPath -Message "STATE_THREAD_CLEARED"
    }

    Set-EnvVar "BLUN_TELEGRAM_APP_SERVER_WS_URL" $telegramAppServerWsUrl

    $appServerPidFile = Join-Path $agentRuntimeDir "app-server.pid"
    $appServerInfoFile = Join-Path $agentRuntimeDir "app-server.json"
    $currentRuntimeFile = Join-Path $agentRuntimeDir "current-remote-runtime.json"
    $appServerStdoutPath = Join-Path $agentRuntimeDir "app-server.stdout.log"
    $appServerStderrPath = Join-Path $agentRuntimeDir "app-server.stderr.log"
    $previousRuntime = Try-GetJsonFile -Path $currentRuntimeFile
    if ($null -ne $previousRuntime) {
      $oldPids = @()
      if ($previousRuntime.frontend_host_pid) { $oldPids += [int]$previousRuntime.frontend_host_pid }
      if ($previousRuntime.app_server_pid) { $oldPids += [int]$previousRuntime.app_server_pid }
      if ($previousRuntime.queue_notifier_pid) { $oldPids += [int]$previousRuntime.queue_notifier_pid }
      if ($previousRuntime.poller_pid) { $oldPids += [int]$previousRuntime.poller_pid }
      if ($previousRuntime.dispatcher_pid) { $oldPids += [int]$previousRuntime.dispatcher_pid }
      if ($previousRuntime.responder_pid) { $oldPids += [int]$previousRuntime.responder_pid }
      if ($oldPids.Count -gt 0) {
        Stop-ProcessTree -RootIds $oldPids
        Write-DebugStage -Path $debugLogPath -Message ("PREVIOUS_RUNTIME_STOPPED pids=" + (($oldPids | Select-Object -Unique) -join ","))
      }
      Remove-Item $currentRuntimeFile -Force -ErrorAction SilentlyContinue
    }
    $codexScript = (Get-Command codex).Source
    $codexBaseDir = Split-Path -Parent $codexScript
    $codexJs = $null
    $vendorCandidates = Get-ChildItem -Path (Join-Path $codexBaseDir "node_modules\@*\codex\bin\codex.js") -File -ErrorAction SilentlyContinue
    if ($vendorCandidates) {
      $codexJs = $vendorCandidates[0].FullName
    } else {
      $codexJs = Join-Path $codexBaseDir "node_modules\codex\bin\codex.js"
    }
    $nodeExe = (Get-Command node).Source
    Remove-Item $appServerStdoutPath,$appServerStderrPath -Force -ErrorAction SilentlyContinue
    $clearedEnvNames = @(
      "BLUN_TELEGRAM_AGENT_NAME",
      "BLUN_TELEGRAM_STATE_DIR",
      "BLUN_TELEGRAM_ALLOWED_CHAT_ID",
      "BLUN_TELEGRAM_PLUGIN_MODE",
      "BLUN_TELEGRAM_APP_SERVER_WS_URL",
      "BLUN_TELEGRAM_THREAD_ID",
      "BLUN_TELEGRAM_BOT_TOKEN",
      "BLUN_TELEGRAM_CODEX_BIN"
    )
    $savedEnv = @{}
    foreach ($name in $clearedEnvNames) {
      $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      [Environment]::SetEnvironmentVariable($name, "", "Process")
    }
    try {
      $backendProcess = Start-Process -FilePath $nodeExe -ArgumentList @(
        $codexJs,
        "app-server",
        "--listen",
        $telegramAppServerWsUrl
      ) -WorkingDirectory $resolvedWorkspace -RedirectStandardOutput $appServerStdoutPath -RedirectStandardError $appServerStderrPath -PassThru -WindowStyle Hidden
    } finally {
      foreach ($name in $clearedEnvNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], "Process")
      }
    }
    Set-Content -Path $appServerPidFile -Value "$($backendProcess.Id)`n" -Encoding UTF8
    Write-DebugStage -Path $debugLogPath -Message ("APP_SERVER_SPAWNED pid=" + $backendProcess.Id + " ws_url=" + $telegramAppServerWsUrl)

    if (-not (Wait-TcpPort -HostName "127.0.0.1" -Port $port -TimeoutMs 20000)) {
      $backendStderrTail = if (Test-Path $appServerStderrPath) { ((Get-Content -LiteralPath $appServerStderrPath -Tail 40) -join " | ") } else { "" }
      $backendStdoutTail = if (Test-Path $appServerStdoutPath) { ((Get-Content -LiteralPath $appServerStdoutPath -Tail 40) -join " | ") } else { "" }
      if ($backendProcess.HasExited) {
        Write-DebugStage -Path $debugLogPath -Message ("APP_SERVER_EXITED exit_code=" + $backendProcess.ExitCode)
      }
      if ($backendStderrTail) {
        Write-DebugStage -Path $debugLogPath -Message ("APP_SERVER_STDERR " + $backendStderrTail)
      }
      if ($backendStdoutTail) {
        Write-DebugStage -Path $debugLogPath -Message ("APP_SERVER_STDOUT " + $backendStdoutTail)
      }
      Write-DebugStage -Path $debugLogPath -Message "WAIT_TCP_TIMEOUT"
      throw "Timed out waiting for app-server to listen on $telegramAppServerWsUrl"
    }
    Write-DebugStage -Path $debugLogPath -Message "TCP_READY"
    $bootstrapScript = Join-Path $telegramPluginRoot "app-server-cli.js"
    $sidecarManager = Join-Path $telegramPluginRoot "sidecar-manager.js"
    $codexArgs += "--remote"
    $codexArgs += $telegramAppServerWsUrl
  }
} elseif ($RemoteControl) {
  $codexArgs += "remote-control"
} else {
  $codexArgs += "-C"
  $codexArgs += $resolvedWorkspace
}

if (-not $useRemoteAppServer) {
  $codexArgs = $commonOverrides + $codexArgs
}

if ($Prompt) {
  $codexArgs += $Prompt
}

if ($PrintOnly) {
  [pscustomobject]@{
    runtime_root = $runtimeRoot
    profile_path = $profilePath
    workspace = $resolvedWorkspace
    env = @{
      BLUN_CODEX_AGENT = $env:BLUN_CODEX_AGENT
      BLUN_CODEX_LANE = $env:BLUN_CODEX_LANE
      MNEMO_DEFAULT_AGENT = $env:MNEMO_DEFAULT_AGENT
      MNEMO_AGENT = $env:MNEMO_AGENT
      MNEMO_DB = $env:MNEMO_DB
      MNEMO_TENANT_ROOT = $env:MNEMO_TENANT_ROOT
      BLUN_TELEGRAM_AGENT_NAME = $env:BLUN_TELEGRAM_AGENT_NAME
      BLUN_TELEGRAM_STATE_DIR = $env:BLUN_TELEGRAM_STATE_DIR
      BLUN_TELEGRAM_ALLOWED_CHAT_ID = $env:BLUN_TELEGRAM_ALLOWED_CHAT_ID
      BLUN_TELEGRAM_APP_SERVER_WS_URL = $env:BLUN_TELEGRAM_APP_SERVER_WS_URL
      BLUN_TELEGRAM_THREAD_ID = $env:BLUN_TELEGRAM_THREAD_ID
    }
    mcp_overrides = @{
      mnemo_inherit = $mnemoInherit
      mnemo_cwd = $mnemoCwdOverride
      mnemo_env = $mnemoEnvOverride
      telegram_env = $telegramEnvOverride
      telegram_mode = $TelegramMode
    }
    remote_session = $remoteSessionInfo
    backend_command = if ($backendArgs.Count -gt 0) { @("codex") + $backendArgs } else { @() }
    command = @("codex") + $codexArgs
  } | ConvertTo-Json -Depth 8
  exit 0
}

if ($useRemoteAppServer) {
  $codexScript = (Get-Command codex).Source
  $currentRuntimeFile = Join-Path $agentRuntimeDir "current-remote-runtime.json"
  $windowTitle = "BLUN Codex Telegram [" + $profile.agent_name + "] " + $telegramAppServerWsUrl
  $titleEmbedScript = Join-Path $runtimeRoot "telegram-title-embed.ps1"
  $titleEmbedLog = Join-Path $agentRuntimeDir "title-embed.log"
  $resumeCommand = ""
  if (Test-Path $titleEmbedScript) {
    $resumeCommand += "& " + (Quote-PowerShellLiteral $titleEmbedScript)
    $resumeCommand += " -StateFile " + (Quote-PowerShellLiteral (Join-Path $telegramStateDir "state.json"))
    $resumeCommand += " -BaseTitle " + (Quote-PowerShellLiteral $windowTitle)
    $resumeCommand += " -LogFile " + (Quote-PowerShellLiteral $titleEmbedLog)
    $resumeCommand += "; "
  }
  $resumeCommand += "$host.UI.RawUI.WindowTitle = " + (Quote-PowerShellLiteral $windowTitle) + "; & " + (Quote-PowerShellLiteral $codexScript) + " " + (($codexArgs | ForEach-Object { Quote-PowerShellLiteral $_ }) -join " ")
  Write-DebugStage -Path $debugLogPath -Message ("FRONTEND_SPAWN command=" + $resumeCommand)
  $frontendProcess = Start-Process -FilePath "powershell" -WorkingDirectory $resolvedWorkspace -ArgumentList @(
    "-NoExit",
    "-Command",
    $resumeCommand
  ) -PassThru
  $currentRuntime = [ordered]@{
    ws_url = $telegramAppServerWsUrl
    app_server_pid = $backendProcess.Id
    frontend_host_pid = $frontendProcess.Id
    profile = $profile.agent_name
    started_at = (Get-Date).ToUniversalTime().ToString("o")
  }
  Write-TextFileWithRetry -Path $currentRuntimeFile -Content ($currentRuntime | ConvertTo-Json -Depth 4)
  Write-DebugStage -Path $debugLogPath -Message "FRONTEND_SPAWNED"
  $sidecarsStartedEarly = $false
  if ($sidecarManager) {
    try {
      & node $sidecarManager | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-DebugStage -Path $debugLogPath -Message "SIDECAR_MANAGER_EARLY_FAILED"
      } else {
        $sidecarsStartedEarly = $true
        Write-DebugStage -Path $debugLogPath -Message "SIDECAR_MANAGER_EARLY_OK"
        $pollerPid = Read-PidFileValue -Path (Join-Path $telegramStateDir "poller.pid")
        $dispatcherPid = Read-PidFileValue -Path (Join-Path $telegramStateDir "dispatcher.pid")
        $responderPid = Read-PidFileValue -Path (Join-Path $telegramStateDir "responder.pid")
        if ($pollerPid -gt 0) { $currentRuntime["poller_pid"] = $pollerPid }
        if ($dispatcherPid -gt 0) { $currentRuntime["dispatcher_pid"] = $dispatcherPid }
        if ($responderPid -gt 0) { $currentRuntime["responder_pid"] = $responderPid }
        Write-TextFileWithRetry -Path $currentRuntimeFile -Content ($currentRuntime | ConvertTo-Json -Depth 6)
      }
    } catch {
      Write-DebugStage -Path $debugLogPath -Message ("SIDECAR_MANAGER_EARLY_ERROR " + $_.Exception.Message)
    }
  }
  if ($envFilePath -and $bootstrapScript) {
    try {
      Write-DebugStage -Path $debugLogPath -Message "LOADED_THREAD_WAIT_START"
      $loadedIds = @()
      for ($attempt = 1; $attempt -le 40; $attempt++) {
        $loaded = Invoke-NodeJsonWithRetry -NodeArgs @($bootstrapScript, "list-loaded", "--ws-url", $telegramAppServerWsUrl) -Attempts 1 -DelayMs 0
        $loadedIds = @($loaded.data)
        if ($loadedIds.Count -gt 0) {
          Write-DebugStage -Path $debugLogPath -Message ("LOADED_THREAD_SEEN attempt=" + $attempt + " count=" + $loadedIds.Count)
          break
        }
        if ($attempt -lt 40) {
          Start-Sleep -Milliseconds 500
        }
      }
      if ($loadedIds.Count -gt 0) {
        $activeThreadId = [string]$loadedIds[$loadedIds.Count - 1]
        $bestThreadScore = [double]::NegativeInfinity
        foreach ($candidate in $loadedIds) {
          $candidateThreadId = [string]$candidate
          if ([string]::IsNullOrWhiteSpace($candidateThreadId)) {
            continue
          }
          $threadScore = 0.0
          try {
            $candidateInfo = Invoke-NodeJsonWithRetry -NodeArgs @($bootstrapScript, "read-thread", "--ws-url", $telegramAppServerWsUrl, "--thread-id", $candidateThreadId) -Attempts 1 -DelayMs 0
            $thread = $candidateInfo.response.result.thread
            if ($null -ne $thread -and $null -ne $thread.createdAt) {
              $threadScore = [double]$thread.createdAt
              if ($threadScore -gt 0 -and $threadScore -lt 1000000000000) {
                $threadScore = $threadScore * 1000
              }
            }
            $threadSource = ""
            $threadStatusType = ""
            if ($null -ne $thread -and $null -ne $thread.source) {
              $threadSource = ([string]$thread.source).ToLowerInvariant()
            }
            if ($null -ne $thread -and $null -ne $thread.status -and $null -ne $thread.status.type) {
              $threadStatusType = ([string]$thread.status.type).ToLowerInvariant()
            }
            if ($threadSource -eq "cli" -and $threadStatusType -eq "active") {
              $threadScore += 1000000000000000
            } elseif ($threadStatusType -eq "active") {
              $threadScore += 900000000000000
            } elseif ($threadSource -eq "cli") {
              $threadScore += 800000000000000
            }
          } catch {
            $threadScore = 0.0
          }
          if ($threadScore -ge $bestThreadScore) {
            $bestThreadScore = $threadScore
            $activeThreadId = $candidateThreadId
          }
        }
        Write-DebugStage -Path $debugLogPath -Message ("LOADED_THREAD_PICKED thread_id=" + $activeThreadId + " count=" + $loadedIds.Count + " score=" + $bestThreadScore)
        $stateEnv = Read-DotEnvFile -Path $envFilePath
        $stateEnv["BLUN_TELEGRAM_THREAD_ID"] = $activeThreadId
        Write-DotEnvFile -Path $envFilePath -Values $stateEnv
        Set-EnvVar "BLUN_TELEGRAM_THREAD_ID" $activeThreadId
        Write-DebugStage -Path $debugLogPath -Message "ENV_THREAD_WRITTEN"

        $telegramState = Try-GetJsonFile -Path (Join-Path $telegramStateDir "state.json")
        if ($null -ne $telegramState) {
          if ($telegramState.PSObject.Properties.Name.Contains("currentThreadId")) {
            $telegramState.currentThreadId = $activeThreadId
          } else {
            $telegramState | Add-Member -NotePropertyName "currentThreadId" -NotePropertyValue $activeThreadId
          }
          Write-TextFileWithRetry -Path (Join-Path $telegramStateDir "state.json") -Content ($telegramState | ConvertTo-Json -Depth 10)
          Write-DebugStage -Path $debugLogPath -Message "STATE_THREAD_WRITTEN"
        }

        $currentRuntime["thread_id"] = $activeThreadId
        Write-TextFileWithRetry -Path $currentRuntimeFile -Content ($currentRuntime | ConvertTo-Json -Depth 6)
        Write-DebugStage -Path $debugLogPath -Message "CURRENT_RUNTIME_THREAD_WRITTEN"

        try {
          $verify = Invoke-NodeJsonWithRetry -NodeArgs @($bootstrapScript, "read-thread", "--ws-url", $telegramAppServerWsUrl, "--thread-id", $activeThreadId) -Attempts 2 -DelayMs 350
          if ($verify.ok -and $verify.threadId -eq $activeThreadId) {
            Write-DebugStage -Path $debugLogPath -Message "VERIFY_THREAD_OK"
          } else {
            Write-DebugStage -Path $debugLogPath -Message "VERIFY_THREAD_INVALID"
          }
        } catch {
          Write-DebugStage -Path $debugLogPath -Message ("VERIFY_THREAD_WARN " + $_.Exception.Message)
        }

        & node $sidecarManager | Out-Null
        if ($LASTEXITCODE -ne 0) {
          Write-DebugStage -Path $debugLogPath -Message "SIDECAR_MANAGER_FAILED"
          throw "Failed to ensure Telegram sidecars."
        }
        Write-DebugStage -Path $debugLogPath -Message "SIDECAR_MANAGER_OK"

        $pollerPid = Read-PidFileValue -Path (Join-Path $telegramStateDir "poller.pid")
        $dispatcherPid = Read-PidFileValue -Path (Join-Path $telegramStateDir "dispatcher.pid")
        $responderPid = Read-PidFileValue -Path (Join-Path $telegramStateDir "responder.pid")
        $remoteSessionInfo = [ordered]@{
          ws_url = $telegramAppServerWsUrl
          thread_id = $activeThreadId
          pid = $backendProcess.Id
          started_at = (Get-Date).ToUniversalTime().ToString("o")
          sidecars = [ordered]@{
            poller = [ordered]@{ pid = $pollerPid }
            dispatcher = [ordered]@{ pid = $dispatcherPid }
            responder = [ordered]@{ pid = $responderPid }
          }
        }
        Write-TextFileWithRetry -Path $appServerInfoFile -Content ($remoteSessionInfo | ConvertTo-Json -Depth 6)
        if ($pollerPid -gt 0) { $currentRuntime["poller_pid"] = $pollerPid }
        if ($dispatcherPid -gt 0) { $currentRuntime["dispatcher_pid"] = $dispatcherPid }
        if ($responderPid -gt 0) { $currentRuntime["responder_pid"] = $responderPid }
        Write-TextFileWithRetry -Path $currentRuntimeFile -Content ($currentRuntime | ConvertTo-Json -Depth 6)
        Write-DebugStage -Path $debugLogPath -Message "APP_SERVER_INFO_WRITTEN"
      } else {
        Write-DebugStage -Path $debugLogPath -Message "LOADED_THREAD_NONE"
        if ($sidecarsStartedEarly) {
          $remoteSessionInfo = [ordered]@{
            ws_url = $telegramAppServerWsUrl
            thread_id = ""
            pid = $backendProcess.Id
            started_at = (Get-Date).ToUniversalTime().ToString("o")
            sidecars = [ordered]@{
              poller = [ordered]@{ pid = Read-PidFileValue -Path (Join-Path $telegramStateDir "poller.pid") }
              dispatcher = [ordered]@{ pid = Read-PidFileValue -Path (Join-Path $telegramStateDir "dispatcher.pid") }
              responder = [ordered]@{ pid = Read-PidFileValue -Path (Join-Path $telegramStateDir "responder.pid") }
            }
          }
          Write-TextFileWithRetry -Path $appServerInfoFile -Content ($remoteSessionInfo | ConvertTo-Json -Depth 6)
          Write-DebugStage -Path $debugLogPath -Message "APP_SERVER_INFO_WRITTEN_UNBOUND"
        }
      }
    } catch {
      Write-DebugStage -Path $debugLogPath -Message ("LOADED_THREAD_ERROR " + $_.Exception.Message)
    }
  }
  exit 0
}

& codex @codexArgs
exit $LASTEXITCODE
