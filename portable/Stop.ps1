$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskStatePath = Join-Path $taskRoot 'data\instance.json'
if (-not (Test-Path -LiteralPath $taskStatePath)) { Write-Output 'Swap Studio is not running.'; exit 0 }
$taskRecord = Get-Content -Raw -LiteralPath $taskStatePath | ConvertFrom-Json
$taskHealth = $null
try { $taskHealth = Invoke-RestMethod -Uri ($taskRecord.url+'api/health') -TimeoutSec 3 } catch {}
if ($taskHealth.activeJobId) { throw 'A job is still running. Cancel it in the page or wait for it to finish, then run Stop.cmd again.' }
foreach ($taskOwned in $taskRecord.processes) {
    $taskProcess = Get-Process -Id $taskOwned.id -ErrorAction SilentlyContinue
    if ($taskProcess -and $taskProcess.Path -eq $taskOwned.path -and $taskProcess.StartTime.ToUniversalTime().Ticks -eq [long]$taskOwned.started) {
        Stop-Process -Id $taskProcess.Id
    }
}
Write-Output 'Stopped this copy of Swap Studio. Images and results are kept.'
