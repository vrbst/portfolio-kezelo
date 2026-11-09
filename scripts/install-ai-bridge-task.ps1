<#
.SYNOPSIS
  Az AI-híd (npm run ai-bridge) ütemezett feladata: bejelentkezéskor elindul, hiba esetén újraindul.

.DESCRIPTION
  A híd az AI-oldal "Új elemzés" gombjának helyi közvetítője (scripts/notify/analysis/bridge.ts): csak
  127.0.0.1:47811-en hallgat, és a my-claude-hubon át futtatja az elemzést.

  Ugyanaz a minta, mint a my-claude-hub feladatánál: `conhost.exe --headless` alatt fut (nincs konzolablak),
  ugyanazzal a felhasználóval, interaktív munkamenetben, bejelentkezéskor indul, hiba után 1 percenként
  újraindul, egyszerre egy példány. A naplója: logs\ai-bridge.log (a híd saját sorai, kevés; 5 MB felett a
  következő (újra)telepítéskor logs\ai-bridge.log.1 lesz).

  A szkript NEM fut le magától: kézzel futtasd, abból a mappából, ahol az app véglegesen él (a feladat a
  szkript melletti repóra mutat, ne egy ideiglenes worktree-ből telepítsd). Próbafuttatás: -WhatIf

.PARAMETER TaskName
  A feladat neve. Alapból: portfolio-ai-bridge.

.PARAMETER Remove
  Eltávolítja a feladatot.

.PARAMETER Status
  Kiírja a feladat állapotát.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-ai-bridge-task.ps1 -WhatIf
  powershell -ExecutionPolicy Bypass -File scripts\install-ai-bridge-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-ai-bridge-task.ps1 -Status
  powershell -ExecutionPolicy Bypass -File scripts\install-ai-bridge-task.ps1 -Remove
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string] $TaskName = 'portfolio-ai-bridge',
  [switch] $Remove,
  [switch] $Status
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$User = "$env:USERDOMAIN\$env:USERNAME"

if ($Status) {
  $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "A(z) '$TaskName' feladat nincs telepítve."; exit 1 }
  $i = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Host "Feladat: $TaskName  Állapot: $($t.State)  Utolsó futás: $($i.LastRunTime)  Utolsó eredmény: $($i.LastTaskResult)"
  exit 0
}

if ($Remove) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Ütemezett feladat eltávolítása')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "A(z) '$TaskName' feladat eltávolítva."
  }
  exit 0
}

# --- előfeltételek ---
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "A 'node' nem található a PATH-on. Telepítsd a Node 24-et (.nvmrc)." }
$major = [int]((& $node -v).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw "Node 24 vagy újabb kell (a telepített: $(& $node -v))." }
$tsx = Join-Path $RepoRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsx)) { throw "Hiányzik a tsx ($tsx): futtasd az 'npm ci' parancsot a $RepoRoot mappában." }
if ($RepoRoot -match '\\\.claude\\worktrees\\') {
  Write-Warning "A repó egy ideiglenes worktree ($RepoRoot): a feladat törlődő mappára mutatna. Telepíts a végleges mappából."
}

$logDir = Join-Path $RepoRoot 'logs'
$logFile = Join-Path $logDir 'ai-bridge.log'
$entry = Join-Path $RepoRoot 'scripts\notify\analysis\bridgeMain.ts'

# A konzolablak nélküli futáshoz a feladat `conhost.exe --headless` alatt indít egy cmd-t, ami a híd
# (stderr-re írt) sorait a naplófájlba irányítja. A leállításkor a cmd és a node is leáll.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
if (-not (Test-Path $conhost)) { throw "A conhost.exe nem található ($conhost): Windows 10 1809 vagy újabb kell." }
# A `call` előtag kell: a conhost a `""`-lel kezdődő argumentumot elrontaná (ellenőrizve).
$inner = 'call "{0}" "{1}" --tsconfig tsconfig.notify.json "{2}" >> "{3}" 2>&1' -f $node, $tsx, $entry, $logFile
$action = New-ScheduledTaskAction -Execute $conhost `
  -Argument ('--headless cmd.exe /d /c "{0}"' -f $inner) `
  -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User

$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

Write-Host "Ütemezett feladat: $TaskName"
Write-Host "  felhasználó : $User (bejelentkezéskor indul, interaktív munkamenetben)"
Write-Host "  program     : conhost --headless cmd /c node tsx bridgeMain.ts   (mappa: $RepoRoot; nincs konzolablak)"
Write-Host "  napló       : $logFile"
Write-Host '  újraindítás : hiba esetén 1 percenként, korlátlanul; egyszerre egy példány'

if ($PSCmdlet.ShouldProcess($TaskName, 'Ütemezett feladat regisztrálása')) {
  New-Item -ItemType Directory -Force $logDir | Out-Null
  if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) { Move-Item -Force $logFile "$logFile.1" }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Portfólió AI-híd: az Új elemzés gomb helyi közvetítője a my-claude-hubhoz (127.0.0.1:47811)' -Force | Out-Null
  Write-Host "Kész. Azonnali indítás: Start-ScheduledTask -TaskName $TaskName"
}
