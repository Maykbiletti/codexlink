param(
  [string]$HubUrl = "https://listing.blun.ai/mnemo",
  [string[]]$Agents = @("alfred", "angel", "dieter", "kimi", "otto"),
  [int]$WindowMinutes = 1440,
  [int]$StaleMinutes = 60,
  [int]$Limit = 5000,
  [switch]$RequireUserPrompt,
  [switch]$Json
)

$ErrorActionPreference = "Stop"

function Invoke-MnemoTool {
  param(
    [Parameter(Mandatory = $true)][string]$Tool,
    [Parameter(Mandatory = $true)][hashtable]$Arguments
  )

  $base = $HubUrl.TrimEnd("/")
  $body = $Arguments | ConvertTo-Json -Depth 8 -Compress
  $response = Invoke-RestMethod -Method Post -Uri "$base/tool/$Tool" -ContentType "application/json" -Body $body
  if ($null -ne $response.result) {
    return $response.result
  }
  return $response
}

$health = Invoke-MnemoTool -Tool "mem_agent_memory_health" -Arguments @{
  window_minutes = $WindowMinutes
  stale_minutes = $StaleMinutes
  limit = $Limit
}

$rows = foreach ($agent in $Agents) {
  $name = $agent.Trim().ToLowerInvariant()
  if (-not $name) { continue }

  $record = @($health.agents | Where-Object { "$($_.agent_name)".ToLowerInvariant() -eq $name })[0]
  if (-not $record) {
    [pscustomobject]@{
      agent = $name
      gate = "missing"
      health = "missing"
      latest_hook = $null
      last_hook_at = $null
      user_prompt_seen = $false
      user_prompt_at = $null
      prior_recall_ok = $false
      prior_count = $null
      capture_user_prompt_at = $null
      reason = "agent missing from mem_agent_memory_health window"
    }
    continue
  }

  $userPrompt = $record.lifecycle.UserPromptSubmit
  $userPromptSeen = [bool]$record.required_hooks_seen.user_prompt
  $priorOk = [bool]($userPrompt -and $userPrompt.prior_recall_ok -eq $true)
  $promptCaptureOk = [bool]($userPrompt -and $userPrompt.prompt_capture_ok -eq $true)
  $userPromptStatusOk = [bool]($userPrompt -and "$($userPrompt.status)".ToLowerInvariant() -eq "ok")
  $currentBlockers = @($record.current_blockers | Where-Object { "$_".Trim() })
  $userPromptBlockers = @($userPrompt.blockers | Where-Object { "$_".Trim() })
  $baseOk = "$($record.health)".ToLowerInvariant() -eq "ok" -and $currentBlockers.Count -eq 0
  $promptOk = -not $RequireUserPrompt -or ($userPromptSeen -and $userPromptStatusOk -and $priorOk -and $promptCaptureOk -and $userPromptBlockers.Count -eq 0)
  $gate = if ($baseOk -and $promptOk) { "pass" } elseif ($baseOk -and -not $userPromptSeen) { "heartbeat_only" } else { "fail" }
  $reason = if ($gate -eq "pass") {
    "ok"
  } elseif ($gate -eq "heartbeat_only") {
    "fresh heartbeat but no UserPromptSubmit/prior recall"
  } elseif ($currentBlockers.Count -gt 0) {
    "current blockers: " + ($currentBlockers -join "; ")
  } elseif ($userPromptBlockers.Count -gt 0) {
    "UserPromptSubmit blockers: " + ($userPromptBlockers -join "; ")
  } elseif (-not $baseOk) {
    "health=$($record.health)"
  } else {
    "UserPromptSubmit/prior recall/capture missing"
  }

  [pscustomobject]@{
    agent = $name
    gate = $gate
    health = $record.health
    latest_hook = $record.latest_hook
    last_hook_at = $record.last_hook_at
    user_prompt_seen = $userPromptSeen
    user_prompt_at = $userPrompt.at
    user_prompt_status = $userPrompt.status
    prior_recall_ok = $priorOk
    prior_count = $userPrompt.prior_count
    prompt_capture_ok = $promptCaptureOk
    current_blockers = $currentBlockers
    user_prompt_blockers = $userPromptBlockers
    capture_user_prompt_at = $record.captures.last_user_prompt_at
    reason = $reason
  }
}

if ($Json) {
  $rows | ConvertTo-Json -Depth 6
} else {
  $rows | Format-Table -AutoSize
}

$failed = @($rows | Where-Object { $_.gate -ne "pass" })
if ($failed.Count -gt 0) {
  exit 1
}
