$ErrorActionPreference = "Stop"

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profile = "default"
$telegramMode = "inherit"
$workspace = ""
$remoteControl = $false
$printOnly = $false
$promptParts = @()
$parsedArgs = @($args)

if ($parsedArgs.Count -gt 0) {
  switch ($parsedArgs[0]) {
    "telegram-status" {
      $commandArgs = @()
      if ($parsedArgs.Count -gt 1) {
        $commandArgs = @($parsedArgs[1..($parsedArgs.Count - 1)])
      }
      & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-status.ps1") @commandArgs
      exit $LASTEXITCODE
    }
    "telegram-doctor" {
      $commandArgs = @()
      if ($parsedArgs.Count -gt 1) {
        $commandArgs = @($parsedArgs[1..($parsedArgs.Count - 1)])
      }
      & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-doctor.ps1") @commandArgs
      exit $LASTEXITCODE
    }
    "doctor" {
      $commandArgs = @()
      if ($parsedArgs.Count -gt 1) {
        $commandArgs = @($parsedArgs[1..($parsedArgs.Count - 1)])
      }
      & powershell -ExecutionPolicy Bypass -File (Join-Path $runtimeRoot "telegram-doctor.ps1") @commandArgs
      exit $LASTEXITCODE
    }
    "telegram-plugin" {
      $telegramMode = "plugin"
      if ($parsedArgs.Count -gt 1) {
        $parsedArgs = @($parsedArgs[1..($parsedArgs.Count - 1)])
      } else {
        $parsedArgs = @()
      }
    }
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
    default {
      $promptParts += $arg
    }
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
