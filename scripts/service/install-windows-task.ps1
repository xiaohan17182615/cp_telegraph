param(
  [Parameter(Mandatory = $false)]
  [string]$ProjectDir = (Resolve-Path ".").Path,

  [Parameter(Mandatory = $false)]
  [string]$TaskName = "WechatCodexBridge"
)

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)?.Source
if (-not $npm) {
  $npm = (Get-Command npm -ErrorAction Stop).Source
}

$action = New-ScheduledTaskAction -Execute $npm -Argument "run serve" -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Run WeChat Codex Bridge at user logon" -Force | Out-Null
Write-Host "Registered scheduled task: $TaskName"
