. (Join-Path $PSScriptRoot 'Config.ps1')
$taskRecordPath=Join-Path $taskData 'instance.json'
if (-not (Test-Path -LiteralPath $taskRecordPath)) { Write-Output 'Shared studio is not running.';exit 0 }
$taskRecord=Get-Content -Raw -LiteralPath $taskRecordPath | ConvertFrom-Json
$taskBusy=@(Get-ChildItem -LiteralPath (Join-Path $taskData 'jobs') -Filter job.json -Recurse -ErrorAction SilentlyContinue | ForEach-Object {Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json} | Where-Object {$_.status -notin @('succeeded','failed','cancelled')})
if ($taskBusy.Count) { throw 'Jobs are still running or waiting. Cancel them in their browser or wait before stopping.' }
if ($taskRecord.engine -and (Test-OwnedProcess $taskRecord.engine)) {
    $taskQueue=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$taskEnginePort+'/queue') -TimeoutSec 5
    if (@($taskQueue.queue_running).Count -or @($taskQueue.queue_pending).Count) { throw 'ComfyUI has other active jobs. Wait before stopping.' }
}
foreach ($taskOwned in @($taskRecord.server,$taskRecord.engine)) { $taskProcess=Test-OwnedProcess $taskOwned;if ($taskProcess) {Stop-Process -Id $taskProcess.Id} }
Write-Output 'Shared studio stopped. Files are preserved.'
