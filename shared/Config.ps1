$ErrorActionPreference = 'Stop'
$taskAppRoot = Split-Path -Parent $PSScriptRoot
$taskConfigPath = Join-Path $PSScriptRoot 'settings.json'
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'settings.local.json')) { $taskConfigPath = Join-Path $PSScriptRoot 'settings.local.json' }
$taskConfig = Get-Content -Raw -LiteralPath $taskConfigPath | ConvertFrom-Json
$taskData = if ($taskConfig.dataDirectory) { [IO.Path]::GetFullPath($taskConfig.dataDirectory) } else { Join-Path $taskAppRoot '.shared-data' }
$taskPortable = $taskConfig.portableRoot
if (-not $taskPortable) {
    foreach ($taskCandidate in @($taskAppRoot,(Split-Path -Parent $taskAppRoot),(Join-Path (Split-Path -Parent $taskAppRoot) 'SwapStudio-Windows-1.0.0'))) {
        if (Test-Path -LiteralPath (Join-Path $taskCandidate 'runtime\python_embeded\python.exe')) { $taskPortable=$taskCandidate; break }
    }
}
$taskNode = $taskConfig.nodePath
if (-not $taskNode) { if ($taskPortable) { $taskNode=Join-Path $taskPortable 'runtime\node\node.exe' } else { $taskNode=(Get-Command node -ErrorAction SilentlyContinue).Source } }
$taskPython = $taskConfig.pythonPath
if (-not $taskPython -and $taskPortable) { $taskPython=Join-Path $taskPortable 'runtime\python_embeded\python.exe' }
$taskEngineDir = $taskConfig.engineDirectory
if (-not $taskEngineDir -and $taskPortable) { $taskEngineDir=Join-Path $taskPortable 'runtime\ComfyUI' }
$taskModelDir = $taskConfig.modelDirectory
if (-not $taskModelDir -and $taskPortable) { $taskModelDir=Join-Path $taskPortable 'models' }
$taskPort = [int]$taskConfig.port
$taskEnginePort = [int]$taskConfig.enginePort
if ($taskPort -lt 1024 -or $taskPort -gt 65000 -or $taskEnginePort -lt 1024 -or $taskEnginePort -gt 65000 -or $taskPort -eq $taskEnginePort) { throw 'Invalid page/engine port.' }
function Test-OwnedProcess($record) {
    if (-not $record) { return $null }
    $process = Get-Process -Id $record.id -ErrorAction SilentlyContinue
    if ($process -and $process.Path -eq $record.path -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$record.started) { return $process }
    return $null
}
