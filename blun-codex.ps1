$ErrorActionPreference = "Stop"

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profile = "default"
$telegramMode = "inherit"
$workspace = ""
$remoteControl = $false
$printOnly = $false
$skipTelegramSetup = $false
$promptParts = @()
$parsedArgs = @($args)

$directCommands = @("telegram-status", "telegram-doctor", "telegram-setup", "telegram-relay-server", "doctor")
for ($scanIndex = 0; $scanIndex -lt $parsedArgs.Count; $scanIndex++) {
  $token = $parsedArgs[$scanIndex]
  if ($token -in @("--profile", "--telegram", "--workspace")) {
    $scanIndex++
    continue
  }
  if ($directCommands -contains $token) {
    $commandArgs = @()
    if ($scanIndex -gt 0) {
      $commandArgs += @($parsedArgs[0..($scanIndex - 1)])
    }
    if ($scanIndex -lt ($parsedArgs.Count - 1)) {
      $commandArgs += @($parsedArgs[($scanIndex + 1)..($parsedArgs.Count - 1)])
    }
    if ($token -eq "telegram-relay-server") {
      $nodeArgs = @((Join-Path $runtimeRoot "telegram-plugin\team-relay-server.js"))
      if ($scanIndex -lt ($parsedArgs.Count - 1)) {
        $nodeArgs += @($parsedArgs[($scanIndex + 1)..($parsedArgs.Count - 1)])
      }
      & node @nodeArgs
      exit $LASTEXITCODE
    }
    $scriptName = switch ($token) {
      "telegram-status" { "telegram-status.ps1" }
      "telegram-setup" { "telegram-setup.ps1" }
      default { "telegram-doctor.ps1" }
    }
    & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot $scriptName) @commandArgs
    exit $LASTEXITCODE
  }
}

for ($i = 0; $i -lt $parsedArgs.Count; $i++) {
  $arg = $parsedArgs[$i]
  switch ($arg) {
    "--profile" {
      $i++
      if ($i -ge $parsedArgs.Count) { throw "--profile requires a value" }
      $profile = $parsedArgs[$i]
      continue
    }
    "--telegram" {
      $i++
      if ($i -ge $parsedArgs.Count) { throw "--telegram requires a value" }
      $telegramMode = $parsedArgs[$i]
      continue
    }
    "--workspace" {
      $i++
      if ($i -ge $parsedArgs.Count) { throw "--workspace requires a value" }
      $workspace = $parsedArgs[$i]
      continue
    }
    "--remote-control" {
      $remoteControl = $true
      continue
    }
    "--print-only" {
      $printOnly = $true
      continue
    }
    "--skip-telegram-setup" {
      $skipTelegramSetup = $true
      continue
    }
    "telegram-plugin" {
      $telegramMode = "plugin"
      continue
    }
    default {
      $promptParts += $arg
    }
  }
}

if ($telegramMode -eq "plugin" -and -not $skipTelegramSetup -and -not $printOnly) {
  $setupArgs = @(
    "-ExecutionPolicy", "Bypass",
    "-File", (Join-Path $runtimeRoot "telegram-setup.ps1"),
    "-Profile", $profile,
    "-EnsureConfigured"
  )
  & powershell @setupArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

$invokeArgs = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $runtimeRoot "start-codex-agent.ps1"),
  "-Agent", $profile,
  "-TelegramMode", $telegramMode
)

if ($workspace) {
  $invokeArgs += "-Workspace"
  $invokeArgs += $workspace
}

if ($remoteControl) {
  $invokeArgs += "-RemoteControl"
}

if ($printOnly) {
  $invokeArgs += "-PrintOnly"
}

if ($promptParts.Count -gt 0) {
  $invokeArgs += "-Prompt"
  $invokeArgs += ($promptParts -join " ")
}

& powershell @invokeArgs
exit $LASTEXITCODE
