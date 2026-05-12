param(
  [Parameter(Mandatory = $true)]
  [int]$FrontendPid,

  [int]$AttachPid = 0,

  [Parameter(Mandatory = $true)]
  [string]$RuntimeFile,

  [Parameter(Mandatory = $true)]
  [string]$StateFile,

  [Parameter(Mandatory = $true)]
  [string]$BaseTitle,

  [string]$LogFile = ""
)

$ErrorActionPreference = "SilentlyContinue"

if (-not ("CodexLink.NativeMethods" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexLink
{
    public static class NativeMethods
    {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool FreeConsole();

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AttachConsole(uint dwProcessId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "SetConsoleTitleW")]
        public static extern bool SetConsoleTitle(string lpConsoleTitle);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr GetStdHandle(int nStdHandle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "WriteConsoleW")]
        public static extern bool WriteConsole(IntPtr hConsoleOutput, string lpBuffer, uint nNumberOfCharsToWrite, out uint lpNumberOfCharsWritten, IntPtr lpReserved);
    }
}
"@
}

function Try-ReadJson {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try {
    $raw = Get-Content -Raw -Path $Path
    if ($null -eq $raw) { return $null }
    return ($raw -replace "^\uFEFF", "") | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Write-WatcherLog {
  param([string]$Message)
  if (-not $LogFile) { return }
  try {
    Add-Content -Path $LogFile -Value (((Get-Date).ToUniversalTime().ToString("o")) + " " + $Message) -Encoding UTF8
  } catch {
  }
}

function Test-PidAlive {
  param([int]$ProcId)
  if ($ProcId -le 0) { return $false }
  return $null -ne (Get-Process -Id $ProcId -ErrorAction SilentlyContinue)
}

function Get-PidProcessName {
  param([int]$ProcId)
  try {
    return [string](Get-Process -Id $ProcId -ErrorAction Stop).ProcessName
  } catch {
    return ""
  }
}

function Get-EffectiveAttachPid {
  if ($AttachPid -gt 0 -and (Test-PidAlive -ProcId $AttachPid) -and (Get-PidProcessName -ProcId $AttachPid) -ine "conhost") {
    return $AttachPid
  }

  if (Test-PidAlive -ProcId $FrontendPid) {
    return $FrontendPid
  }

  try {
    $child = Get-CimInstance Win32_Process -Filter ("ParentProcessId = " + $FrontendPid) |
      Where-Object { $_.Name -ieq "node.exe" } |
      Select-Object -First 1
    if ($child -and [int]$child.ProcessId -gt 0) {
      return [int]$child.ProcessId
    }
  } catch {
  }

  return 0
}

function Normalize-Preview {
  param([string]$Value, [int]$MaxLength = 44)
  $text = [string]$Value
  $text = $text -replace "\s+", " "
  $text = $text.Trim()
  if (-not $text) { return "" }
  if ($text.Length -le $MaxLength) { return $text }
  return ($text.Substring(0, [Math]::Max(0, $MaxLength - 3)).TrimEnd() + "...")
}

function Get-OpenPendingReplyCount {
  param([object]$State)
  return @(Get-OpenPendingReplies -State $State).Count
}

function Get-OpenPendingReplies {
  param([object]$State)
  if ($null -eq $State -or $null -eq $State.pendingReplies) {
    return @()
  }
  return @($State.pendingReplies | Where-Object { -not $_.sentAt -and @("error","expired","ignored_bot","suppressed_ack","superseded","sent","stale_thread") -notcontains [string]$_.status })
}

function Get-IsoAgeMs {
  param([string]$IsoValue)
  if (-not $IsoValue) { return [double]::PositiveInfinity }
  try {
    $parsed = [DateTimeOffset]::Parse($IsoValue)
    return ([DateTimeOffset]::UtcNow - $parsed.ToUniversalTime()).TotalMilliseconds
  } catch {
    return [double]::PositiveInfinity
  }
}

function Get-QueueWaitReason {
  param(
    [object]$State,
    [int]$IdleCooldownMs = 15000
  )

  $pendingReplyCount = Get-OpenPendingReplyCount -State $State
  if ($pendingReplyCount -gt 0) {
    return "arbeitet noch"
  }

  $lastInjectAt = ""
  try { $lastInjectAt = [string]$State.lastInjectAt } catch { $lastInjectAt = "" }
  if ($lastInjectAt) {
    $ageMs = Get-IsoAgeMs -IsoValue $lastInjectAt
    if ($ageMs -lt $IdleCooldownMs) {
      return "wartet auf Ruhe"
    }
  }

  return "wartet in Queue"
}

function Format-QueuePreview {
  param([object]$Entry, [int]$MaxLength = 44, [switch]$Pending)
  if ($null -eq $Entry) { return "" }
  $rawText = if ($Pending) { [string]$Entry.sourceText } else { [string]$Entry.text }
  $text = Normalize-Preview -Value $rawText -MaxLength $MaxLength
  if (-not $text) { return "" }
  $user = [string]$Entry.user
  $group = [string]$Entry.groupTitle
  $prefix = if ($Pending) { "pending: " } else { "" }
  if ($group) {
    return Normalize-Preview -Value ("${prefix}${user}@${group}: $text") -MaxLength $MaxLength
  }
  if ($user) {
    return Normalize-Preview -Value ("${prefix}${user}: $text") -MaxLength $MaxLength
  }
  return "${prefix}${text}"
}

function Get-QueueTitle {
  param(
    [object]$State,
    [string]$FallbackTitle,
    [int]$IdleCooldownMs = 15000
  )

  if ($null -eq $State -or $null -eq $State.queue) {
    return $FallbackTitle
  }

  $queued = @($State.queue | Where-Object { $_.status -eq "queued" })
  $pendingReplies = @(Get-OpenPendingReplies -State $State)
  $totalWaiting = $queued.Count + $pendingReplies.Count
  if ($totalWaiting -eq 0) {
    return $FallbackTitle
  }

  $directCount = @($queued | Where-Object { @("direct", "lane") -contains [string]$_.relevance }).Count
  $ambientCount = @($queued | Where-Object { [string]$_.relevance -eq "ambient" }).Count
  $escalationCount = @($queued | Where-Object { [string]$_.relevance -eq "escalation" }).Count
  $pendingCount = $pendingReplies.Count

  $nextDirect = @($queued | Where-Object { @("direct", "lane", "escalation") -contains [string]$_.relevance } | Select-Object -First 1)
  $nextAny = @($queued | Select-Object -First 1)
  $pendingFocus = @($pendingReplies | Sort-Object @{ Expression = { [string]$_.createdAt } } | Select-Object -First 1)
  $focus = if ($pendingFocus.Count -gt 0) { $pendingFocus[0] } elseif ($nextDirect.Count -gt 0) { $nextDirect[0] } elseif ($nextAny.Count -gt 0) { $nextAny[0] } else { $null }
  $preview = if ($focus) { Format-QueuePreview -Entry $focus -Pending:($pendingFocus.Count -gt 0) } else { "" }

  $parts = @("Q:$totalWaiting")
  if ($pendingCount -gt 0) { $parts += "P:$pendingCount" }
  if ($directCount -gt 0) { $parts += "D:$directCount" }
  if ($ambientCount -gt 0) { $parts += "G:$ambientCount" }
  if ($escalationCount -gt 0) { $parts += "E:$escalationCount" }

  $summary = ($parts -join " ")
  $waitReason = Get-QueueWaitReason -State $State -IdleCooldownMs $IdleCooldownMs
  if ($preview) {
    return "$FallbackTitle | $summary | $waitReason | $preview"
  }
  return "$FallbackTitle | $summary | $waitReason"
}

function Update-ConsoleTitle {
  param([string]$Title)
  try {
    [void][CodexLink.NativeMethods]::FreeConsole()
    $targetPid = Get-EffectiveAttachPid
    $attached = [CodexLink.NativeMethods]::AttachConsole([uint32]$targetPid)
    if (-not $attached) {
      Write-WatcherLog ("WAIT attach_console_failed target=" + $targetPid)
      return $false
    }
    $updated = [CodexLink.NativeMethods]::SetConsoleTitle($Title)
    [void][CodexLink.NativeMethods]::FreeConsole()
    return $updated
  } catch {
    return $false
  }
}

function Write-ConsoleNotice {
  param([string]$Notice)
  if ($env:BLUN_TELEGRAM_CONSOLE_NOTICES -ne "1") {
    return $false
  }
  try {
    [void][CodexLink.NativeMethods]::FreeConsole()
    $targetPid = Get-EffectiveAttachPid
    $attached = [CodexLink.NativeMethods]::AttachConsole([uint32]$targetPid)
    if (-not $attached) {
      Write-WatcherLog ("WAIT attach_console_failed_notice target=" + $targetPid)
      return $false
    }
    $handle = [CodexLink.NativeMethods]::GetStdHandle(-11)
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr](-1)) {
      [void][CodexLink.NativeMethods]::FreeConsole()
      return $false
    }
    $line = "[CodexLink Queue] $Notice`r`n"
    [uint32]$written = 0
    $ok = [CodexLink.NativeMethods]::WriteConsole($handle, $line, [uint32]$line.Length, [ref]$written, [IntPtr]::Zero)
    [void][CodexLink.NativeMethods]::FreeConsole()
    return $ok
  } catch {
    return $false
  }
}

function Write-ConsoleUiNotice {
  param(
    [string]$Kind,
    [string]$Notice
  )
  $mode = [string]$env:BLUN_TELEGRAM_CONSOLE_UI_NOTICES
  $disabled = $mode -eq "0" -or $mode -ieq "false" -or $mode -ieq "no" -or $mode -ieq "off"
  $allowAll = $mode -ieq "all" -or $mode -eq "1" -or $mode -ieq "true" -or $mode -ieq "yes" -or $mode -ieq "on"
  $isInbound = [string]::Equals($Kind, "inbound", [System.StringComparison]::OrdinalIgnoreCase)
  if ($disabled -or (-not $allowAll -and -not $isInbound)) {
    return $false
  }
  try {
    [void][CodexLink.NativeMethods]::FreeConsole()
    $targetPid = Get-EffectiveAttachPid
    $attached = [CodexLink.NativeMethods]::AttachConsole([uint32]$targetPid)
    if (-not $attached) {
      Write-WatcherLog ("WAIT attach_console_failed_ui target=" + $targetPid)
      return $false
    }
    $handle = [CodexLink.NativeMethods]::GetStdHandle(-11)
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr](-1)) {
      [void][CodexLink.NativeMethods]::FreeConsole()
      return $false
    }
    $prefix = if ([string]::Equals($Kind, "outbound", [System.StringComparison]::OrdinalIgnoreCase)) {
      "[CodexLink Reply]"
    } else {
      "[CodexLink]"
    }
    $line = "$prefix $Notice`r`n"
    [uint32]$written = 0
    $ok = [CodexLink.NativeMethods]::WriteConsole($handle, $line, [uint32]$line.Length, [ref]$written, [IntPtr]::Zero)
    [void][CodexLink.NativeMethods]::FreeConsole()
    return $ok
  } catch {
    return $false
  }
}

function Get-UiNoticeSnapshot {
  param([object]$State)

  if ($null -eq $State -or $null -eq $State.lastUiNotice) {
    return $null
  }

  $text = Normalize-Preview -Value ([string]$State.lastUiNotice.text) -MaxLength 220
  if (-not $text) {
    return $null
  }

  return [pscustomobject]@{
    kind = [string]$State.lastUiNotice.kind
    text = $text
  }
}

function Get-QueueNotice {
  param(
    [object]$State,
    [int]$IdleCooldownMs = 15000
  )

  if ($null -eq $State -or $null -eq $State.queue) {
    return ""
  }

  $queued = @($State.queue | Where-Object { $_.status -eq "queued" })
  $pendingReplies = @(Get-OpenPendingReplies -State $State)
  $totalWaiting = $queued.Count + $pendingReplies.Count
  if ($totalWaiting -eq 0) {
    return ""
  }

  $directCount = @($queued | Where-Object { @("direct", "lane") -contains [string]$_.relevance }).Count
  $ambientCount = @($queued | Where-Object { [string]$_.relevance -eq "ambient" }).Count
  $escalationCount = @($queued | Where-Object { [string]$_.relevance -eq "escalation" }).Count
  $pendingCount = $pendingReplies.Count

  $focus = @($queued | Where-Object { @("direct", "lane", "escalation") -contains [string]$_.relevance } | Select-Object -First 1)
  if ($focus.Count -eq 0) {
    $focus = @($queued | Select-Object -First 1)
  }
  $pendingFocus = @($pendingReplies | Sort-Object @{ Expression = { [string]$_.createdAt } } | Select-Object -First 1)

  $parts = @("$totalWaiting waiting")
  if ($pendingCount -gt 0) { $parts += "pending $pendingCount" }
  if ($directCount -gt 0) { $parts += "direct $directCount" }
  if ($ambientCount -gt 0) { $parts += "group $ambientCount" }
  if ($escalationCount -gt 0) { $parts += "escalation $escalationCount" }
  $parts += (Get-QueueWaitReason -State $State -IdleCooldownMs $IdleCooldownMs)

  if ($pendingFocus.Count -gt 0) {
    $preview = Format-QueuePreview -Entry $pendingFocus[0] -MaxLength 72 -Pending
    if ($preview) {
      $parts += $preview
    }
  } elseif ($focus.Count -gt 0) {
    $preview = Format-QueuePreview -Entry $focus[0] -MaxLength 72
    if ($preview) {
      $parts += $preview
    }
  }

  return ($parts -join " | ")
}

$idleCooldownMs = 15000
$ambientTtlMs = 600000
try {
  $stateDir = Split-Path -Parent $StateFile
  $envPath = Join-Path $stateDir ".env"
  if (Test-Path $envPath) {
    foreach ($line in (Get-Content -Path $envPath)) {
      if (-not $line) { continue }
      if ($line.Trim().StartsWith("#")) { continue }
      $parts = $line -split "=", 2
      if ($parts.Count -ne 2) { continue }
      $key = $parts[0].Trim()
      $value = $parts[1].Trim()
      if ($key -eq "BLUN_TELEGRAM_IDLE_COOLDOWN_MS") {
        $idleCooldownMs = [int]$value
      }
    }
  }
} catch {
  $idleCooldownMs = 15000
}

$lastTitle = ""
$lastNotice = ""
$lastUiKind = ""
$lastUiNotice = ""
Write-WatcherLog "START"

while ($true) {
  if (-not (Test-PidAlive -ProcId $FrontendPid)) {
    Write-WatcherLog "EXIT frontend_dead"
    break
  }

  $runtime = Try-ReadJson -Path $RuntimeFile
  if ($null -eq $runtime) {
    Write-WatcherLog "WAIT runtime_missing"
    Start-Sleep -Milliseconds 300
    continue
  }

  $runtimeOwnerPid = 0
  try { $runtimeOwnerPid = [int]$runtime.frontend_host_pid } catch { $runtimeOwnerPid = 0 }
  if ($runtimeOwnerPid -ne $FrontendPid) {
    Write-WatcherLog ("EXIT owner_changed owner=" + $runtimeOwnerPid)
    break
  }

  $state = Try-ReadJson -Path $StateFile
  if ($null -eq $state) {
    Write-WatcherLog "WAIT state_missing"
    Start-Sleep -Milliseconds 700
    continue
  }

  $title = Get-QueueTitle -State $state -FallbackTitle $BaseTitle -IdleCooldownMs $idleCooldownMs
  $notice = Get-QueueNotice -State $state -IdleCooldownMs $idleCooldownMs
  $ui = Get-UiNoticeSnapshot -State $state
  if ($title -ne $lastTitle) {
    $updated = Update-ConsoleTitle -Title $title
    Write-WatcherLog ("TITLE updated=" + $updated + " text=" + $title)
    $lastTitle = $title
  }
  if ($notice -ne $lastNotice) {
    if ($notice) {
      $noticeUpdated = Write-ConsoleNotice -Notice $notice
      Write-WatcherLog ("NOTICE updated=" + $noticeUpdated + " text=" + $notice)
    } else {
      Write-WatcherLog "NOTICE clear"
    }
    $lastNotice = $notice
  }
  $uiKind = if ($null -ne $ui) { [string]$ui.kind } else { "" }
  $uiText = if ($null -ne $ui) { [string]$ui.text } else { "" }
  if ($uiText -and ($uiText -ne $lastUiNotice -or $uiKind -ne $lastUiKind)) {
    $uiUpdated = Write-ConsoleUiNotice -Kind $uiKind -Notice $uiText
    Write-WatcherLog ("UI updated=" + $uiUpdated + " kind=" + $uiKind + " text=" + $uiText)
    $lastUiKind = $uiKind
    $lastUiNotice = $uiText
  }

  Start-Sleep -Milliseconds 900
}
