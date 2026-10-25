# Reload only this application's page process. Keep ComfyUI, models and jobs intact.
. (Join-Path $PSScriptRoot 'Config.ps1')
$taskRecordPath=Join-Path $taskData 'instance.json'
$taskRecord=Get-Content -LiteralPath $taskRecordPath -Raw | ConvertFrom-Json
$taskOwned=Test-OwnedProcess $taskRecord.server
if (-not $taskOwned) { throw 'Recorded page process identity changed; no process was stopped.' }
$taskLiveJobs=@(Get-ChildItem -LiteralPath (Join-Path $taskData 'jobs') -Filter job.json -Recurse | ForEach-Object {Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json} | Where-Object {$_.status -notin @('succeeded','failed','cancelled')})
if ($taskLiveJobs.Count) { throw 'Wait for active jobs before reloading the page.' }
Stop-Process -Id $taskOwned.Id
& (Join-Path $PSScriptRoot 'Start.ps1') -NoBrowser
