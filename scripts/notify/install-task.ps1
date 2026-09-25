# Registers (or replaces) the scheduled task that runs the Telegram bot,
# restarting it if it ever stops.
#
#   powershell -ExecutionPolicy Bypass -File scripts\notify\install-task.ps1
#       → starts at logon (no admin needed; nothing runs until you log in)
#   powershell -ExecutionPolicy Bypass -File scripts\notify\install-task.ps1 -AtStartup
#       → starts at boot, without logging in (run from an ADMIN PowerShell).
#         Runs as you in S4U mode: no password stored, no access to your
#         credential store — so GITHUB_TOKEN must be set in .notify/.env.
#
# Remove: Unregister-ScheduledTask -TaskName "Portfolio Telegram bot"

param([switch]$AtStartup)

$name = "Portfolio Telegram bot"
$runner = Join-Path $PSScriptRoot "run.ps1"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

if ($AtStartup) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType S4U -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive -RunLevel Limited
}

# Stop a running copy first so the bot never runs twice (Telegram allows
# only one poller per bot).
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $name
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*notify\bot.ts*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description "Portfolio Tracker Telegram-értesítő (scripts/notify)" `
  -Force | Out-Null
Start-ScheduledTask -TaskName $name
$mode = if ($AtStartup) { "a gép indulásakor" } else { "bejelentkezéskor" }
Write-Output "Telepítve és elindítva: $name ($mode indul)"
