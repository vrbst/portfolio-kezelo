# Keeps the Telegram bot running: restarts it 30 s after any exit. Started by
# the "Portfolio Telegram bot" scheduled task at logon (see install-task.ps1).
# Log: .notify\bot.log (rotated at 5 MB).

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root
$log = Join-Path $root ".notify\bot.log"

while ($true) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) {
    Move-Item -Force $log "$log.1"
  }
  # cmd redirection keeps the log plain UTF-8 (PowerShell 5.1's >> writes UTF-16).
  cmd /c "node node_modules\tsx\dist\cli.mjs scripts\notify\bot.ts >> `"$log`" 2>&1"
  Start-Sleep -Seconds 30
}
