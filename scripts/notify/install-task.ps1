# Registers (or replaces) the scheduled task that runs the Telegram bot at
# logon, hidden, restarting it if it ever stops. Run once:
#   powershell -ExecutionPolicy Bypass -File scripts\notify\install-task.ps1
# Remove: Unregister-ScheduledTask -TaskName "Portfolio Telegram bot"

$name = "Portfolio Telegram bot"
$runner = Join-Path $PSScriptRoot "run.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Settings $settings -Description "Portfolio Tracker Telegram-értesítő (scripts/notify)" `
  -Force | Out-Null
Start-ScheduledTask -TaskName $name
Write-Output "Telepítve és elindítva: $name"
