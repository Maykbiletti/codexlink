param(
  [string]$Profile = "default",
  [switch]$EnsureConfigured,
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Try-ReadJson {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try { return Get-Content -Raw -Path $Path | ConvertFrom-Json } catch { return $null }
}

function Ensure-Dir {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Resolve-ConfiguredPath {
  param([string]$Value, [string]$RuntimeRoot)
  if (-not $Value) { return "" }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value)
  if ([System.IO.Path]::IsPathRooted($expanded)) { return $expanded }
  return [System.IO.Path]::GetFullPath((Join-Path $RuntimeRoot $expanded))
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

function Prompt-RequiredValue {
  param(
    [string]$Prompt,
    [string]$CurrentValue,
    [scriptblock]$Validator,
    [string]$ErrorMessage
  )

  while ($true) {
    $fullPrompt = if ($CurrentValue) { "$Prompt [$CurrentValue]" } else { $Prompt }
    $inputValue = Read-Host -Prompt $fullPrompt
    if (-not $inputValue -and $CurrentValue) {
      $inputValue = $CurrentValue
    }
    $inputValue = [string]$inputValue
    if (& $Validator $inputValue) {
      return $inputValue
    }
    Write-Host $ErrorMessage -ForegroundColor Yellow
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

$runtimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$profilePath = Get-ProfilePath -RuntimeRoot $runtimeRoot -ProfileName $Profile
$profileJson = Try-ReadJson -Path $profilePath

if (-not $profileJson) {
  throw "Profile not found or invalid: $profilePath"
}

$profileAgent = if ($profileJson.agent_name) { [string]$profileJson.agent_name } else { $Profile.ToLower() }
$stateDir = if ($profileJson.telegram -and $profileJson.telegram.state_dir) {
  Resolve-ConfiguredPath -Value ([string]$profileJson.telegram.state_dir) -RuntimeRoot $runtimeRoot
} else {
  Join-Path $env:USERPROFILE (".codex\channels\telegram-" + $profileAgent)
}

Ensure-Dir -Path $stateDir
$envPath = Join-Path $stateDir ".env"
$envValues = Read-DotEnvFile -Path $envPath

$currentToken = [string]$envValues["BLUN_TELEGRAM_BOT_TOKEN"]
if (-not (Test-TelegramTokenFormat -Value $currentToken)) {
  $currentToken = [string]$envValues["TELEGRAM_BOT_TOKEN"]
}

$currentAllowedChatIds = [string]$envValues["BLUN_TELEGRAM_ALLOWED_CHAT_ID"]
if (-not (Test-AllowedChatIdsFormat -Value $currentAllowedChatIds)) {
  $currentAllowedChatIds = [string]$envValues["TELEGRAM_ALLOWED_CHAT_ID"]
}

$needsToken = -not (Test-TelegramTokenFormat -Value $currentToken)
$needsChatIds = -not (Test-AllowedChatIdsFormat -Value $currentAllowedChatIds)
$changed = $false

if ($EnsureConfigured -and -not $needsToken) {
  $result = [ordered]@{
    ok = $true
    changed = $false
    profile = $profileAgent
    state_dir = $stateDir
    env_path = $envPath
    missing = @()
    optional = @(
      "allowed_chat_ids"
    )
  }
  if ($Json) {
    $result | ConvertTo-Json -Depth 6
  } else {
    Write-Host "Telegram ist bereits eingerichtet fuer Profil '$profileAgent'." -ForegroundColor Green
    Write-Host "State-Ordner: $stateDir"
    if ($needsChatIds) {
      Write-Host "Hinweis: keine Chat-Allowlist gesetzt. Der Bot akzeptiert aktuell alle Chats, die er sehen kann." -ForegroundColor Yellow
    }
  }
  exit 0
}

if ($EnsureConfigured -and $Json -and $needsToken) {
  $missing = @()
  if ($needsToken) { $missing += "bot_token" }
  [ordered]@{
    ok = $false
    changed = $false
    profile = $profileAgent
    state_dir = $stateDir
    env_path = $envPath
    missing = $missing
    optional = @(
      "allowed_chat_ids"
    )
  } | ConvertTo-Json -Depth 6
  exit 2
}

if (-not $Json) {
  Write-Host ""
  Write-Host "CodexLink Telegram Setup" -ForegroundColor Cyan
  Write-Host "Profil: $profileAgent"
  Write-Host "Lokaler State-Ordner: $stateDir"
  Write-Host ""
  Write-Host "Ich speichere die Telegram-Werte automatisch an die richtige lokale Stelle." -ForegroundColor DarkGray
  Write-Host "Du musst keine .env-Datei selbst suchen." -ForegroundColor DarkGray
  Write-Host "Chat-ID-Allowlist ist optional und blockiert den Start nicht mehr." -ForegroundColor DarkGray
  Write-Host ""
}

if ($needsToken) {
  $currentToken = Prompt-RequiredValue `
    -Prompt "Telegram Bot Token" `
    -CurrentValue $currentToken `
    -Validator { param($v) Test-TelegramTokenFormat -Value $v } `
    -ErrorMessage "Bitte einen gueltigen Telegram Bot Token eingeben. Beispiel: 123456789:ABC..."
  $envValues["BLUN_TELEGRAM_BOT_TOKEN"] = $currentToken
  $changed = $true
}

if (-not $EnsureConfigured -and $needsChatIds) {
  $currentAllowedChatIds = Prompt-RequiredValue `
    -Prompt "Erlaubte Chat ID(s), komma-getrennt" `
    -CurrentValue $currentAllowedChatIds `
    -Validator { param($v) Test-AllowedChatIdsFormat -Value $v } `
    -ErrorMessage "Bitte mindestens eine numerische Chat-ID eingeben. Mehrere IDs mit Komma trennen."
  $envValues["BLUN_TELEGRAM_ALLOWED_CHAT_ID"] = (($currentAllowedChatIds -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }) -join ",")
  $changed = $true
}

$envValues["BLUN_TELEGRAM_AGENT_NAME"] = $profileAgent
$envValues["BLUN_TELEGRAM_STATE_DIR"] = $stateDir
Write-DotEnvFile -Path $envPath -Values $envValues

$result = [ordered]@{
  ok = $true
  changed = $changed
  profile = $profileAgent
  state_dir = $stateDir
  env_path = $envPath
  missing = @()
}

if ($Json) {
  $result | ConvertTo-Json -Depth 6
  exit 0
}

Write-Host ""
Write-Host "Telegram ist jetzt eingerichtet." -ForegroundColor Green
Write-Host "Gespeichert unter: $envPath"
Write-Host ""
Write-Host "Naechster Schritt:" -ForegroundColor Cyan
Write-Host "  blun-codex --profile $profileAgent telegram-plugin"
Write-Host ""
Write-Host "Pruefen kannst du spaeter mit:" -ForegroundColor Cyan
Write-Host "  blun-codex --profile $profileAgent telegram-doctor"
