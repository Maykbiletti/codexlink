param(
  [string]$Profile = "default",
  [Alias("no-start")]
  [switch]$NoStart,
  [switch]$SkipSetup,
  [switch]$SkipFix,
  [switch]$Json,
  [Alias("h")]
  [switch]$Help
)

$ErrorActionPreference = "Stop"

function Write-InstallHelp {
  Write-Host ""
  Write-Host "CodexLink one-command install / repair" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Usage:" -ForegroundColor Cyan
  Write-Host "  blun-codex install --profile otto"
  Write-Host "  blun-codex repair --profile otto"
  Write-Host ""
  Write-Host "What install does:"
  Write-Host "  1. runs telegram-setup and pairs the bot/chat if needed"
  Write-Host "  2. runs telegram-doctor --fix"
  Write-Host "  3. prints a doctor summary"
  Write-Host "  4. starts telegram-plugin unless --no-start is passed"
  Write-Host ""
  Write-Host "What repair does:"
  Write-Host "  same repair path, but does not start a new visible Codex session"
  Write-Host ""
}

function Try-ReadJson {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Path $Path | ConvertFrom-Json } catch { return $null }
}

function Resolve-ConfiguredPath {
  param([string]$Value, [string]$RuntimeRoot)
  if (-not $Value) { return "" }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ([System.IO.Path]::IsPathRooted($expanded)) { return $expanded }
  return [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot $expanded))
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
  $candidates += (Join-Path $env:USERPROFILE (".codex\profiles\codexlink\" + $normalized + ".json"))
  $candidates += (Join-Path $RuntimeRoot ("profiles\" + $normalized + ".json"))

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }

  return $candidates[-1]
}

function Get-ProfileRuntimeInfo {
  param(
    [string]$RuntimeRoot,
    [string]$ProfileName
  )

  $profilePath = Get-ProfilePath -RuntimeRoot $RuntimeRoot -ProfileName $ProfileName
  $profileJson = Try-ReadJson -Path $profilePath
  $agentName = if ($profileJson -and $profileJson.agent_name) { [string]$profileJson.agent_name } else { $ProfileName.ToLower() }
  $stateDir = if ($profileJson -and $profileJson.telegram -and $profileJson.telegram.state_dir) {
    Resolve-ConfiguredPath -Value ([string]$profileJson.telegram.state_dir) -RuntimeRoot $RuntimeRoot
  } else {
    Join-Path $env:USERPROFILE (".codex\channels\telegram-" + $agentName)
  }

  [pscustomobject]@{
    profile_path = $profilePath
    agent_name = $agentName
    state_dir = $stateDir
  }
}

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )
  Write-Host ""
  Write-Host ("==> " + $Name) -ForegroundColor Cyan
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw ("Step failed: " + $Name)
  }
}

if ($Help) {
  Write-InstallHelp
  exit 0
}

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$info = Get-ProfileRuntimeInfo -RuntimeRoot $runtimeRoot -ProfileName $Profile

if ($Json) {
  $NoStart = $true
}

if (-not $Json) {
  Write-Host ""
  Write-Host "CodexLink install/repair" -ForegroundColor Cyan
  Write-Host "Profile: $Profile"
  Write-Host "Agent: $($info.agent_name)"
  Write-Host "State: $($info.state_dir)"
}

if (-not $SkipSetup) {
  Invoke-Step -Name "Telegram setup" -Action {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-setup.ps1") -Profile $Profile -EnsureConfigured
  }
}

if (-not $SkipFix) {
  Invoke-Step -Name "Doctor repair" -Action {
    & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-doctor.ps1") -Profile $Profile -Fix
  }
}

$doctorJsonRaw = & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-doctor.ps1") -Profile $Profile -Json
$doctor = $doctorJsonRaw | ConvertFrom-Json

if ($Json) {
  [ordered]@{
    ok = $true
    profile = $Profile
    agent_name = $info.agent_name
    state_dir = $info.state_dir
    doctor = $doctor
    started = $false
  } | ConvertTo-Json -Depth 10
  exit 0
}

Write-Host ""
Write-Host ("Doctor result: " + $doctor.overall) -ForegroundColor $(if ($doctor.overall -eq "ok") { "Green" } elseif ($doctor.overall -eq "warn") { "Yellow" } else { "Red" })
Write-Host "Core checks:"
foreach ($name in @("node", "codex", "bot_token", "app_server_ws", "bound_thread", "poller", "dispatcher", "responder", "team_relay_consumer", "queue")) {
  $check = @($doctor.checks | Where-Object { $_.name -eq $name } | Select-Object -First 1)
  if ($check) {
    $color = if ($check.status -eq "ok") { "Green" } elseif ($check.status -eq "warn") { "Yellow" } else { "Red" }
    Write-Host ("  [" + $check.status.ToUpper() + "] " + $check.name + ": " + $check.detail) -ForegroundColor $color
  }
}

if ($NoStart) {
  Write-Host ""
  Write-Host "Repair path finished. Start when ready:" -ForegroundColor Cyan
  Write-Host "  blun-codex --profile $Profile telegram-plugin"
  exit 0
}

Write-Host ""
Write-Host "Starting CodexLink Telegram mode..." -ForegroundColor Cyan
& powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "blun-codex.ps1") --profile $Profile telegram-plugin --skip-telegram-setup
exit $LASTEXITCODE
