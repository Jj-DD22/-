param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskState = Join-Path $taskRoot 'data'
New-Item -ItemType Directory -Path $taskState -Force | Out-Null
$taskHash = [Security.Cryptography.SHA256]::Create()
$taskKey = ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskRoot.ToLowerInvariant())))).Replace('-','')
$taskMutex = New-Object Threading.Mutex($false, ('Local\SwapStudio-' + $taskKey.Substring(0,24)))
if (-not $taskMutex.WaitOne(0)) { Write-Output 'Swap Studio is already starting. Please wait.'; exit 0 }
try {
    $taskConfig = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'settings.json') | ConvertFrom-Json
    $taskNode = Join-Path $taskRoot 'runtime\node\node.exe'
    $taskPython = Join-Path $taskRoot 'runtime\python_embeded\python.exe'
    foreach ($taskFile in @($taskNode,$taskPython,(Join-Path $taskRoot 'runtime\ComfyUI\main.py'))) {
        if (-not (Test-Path -LiteralPath $taskFile)) { throw 'Package is incomplete. Extract the whole ZIP first, then run Start.cmd.' }
    }
    $taskInstancePath = Join-Path $taskState 'instance.json'
    $taskAppPath = Join-Path $taskRoot 'app'
    $taskExpectedId = ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskAppPath.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()
    if (Test-Path -LiteralPath $taskInstancePath) {
        $taskPrevious = Get-Content -Raw -LiteralPath $taskInstancePath | ConvertFrom-Json
        try {
            $taskIdentity = Invoke-RestMethod -Uri ($taskPrevious.url + 'api/instance') -TimeoutSec 2
            if ($taskIdentity.app -eq 'swap-studio' -and $taskIdentity.instanceId -eq $taskExpectedId) {
                $taskAlive = @()
                foreach ($taskOwned in $taskPrevious.processes) {
                    $taskProcess = Get-Process -Id $taskOwned.id -ErrorAction SilentlyContinue
                    if ($taskProcess -and $taskProcess.Path -eq $taskOwned.path -and $taskProcess.StartTime.ToUniversalTime().Ticks -eq [long]$taskOwned.started) { $taskAlive += $taskProcess }
                }
                if ($taskAlive.Count -eq 2) {
                    Write-Output ('Already running: ' + $taskPrevious.url)
                    if (-not $NoBrowser) { Start-Process $taskPrevious.url }
                    exit 0
                }
                foreach ($taskOwned in $taskAlive) { Stop-Process -Id $taskOwned.Id }
                Write-Output 'Restarting after an incomplete engine startup...'
            }
        } catch {}
    }
    function Find-AvailablePort([int]$Start) {
        if ($Start -lt 1024 -or $Start -gt 65000) { throw 'Invalid port in settings.json.' }
        for ($taskPort = $Start; $taskPort -lt ($Start + 30); $taskPort++) {
            $taskSocket = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $taskPort)
            try { $taskSocket.Start(); return $taskPort } catch {} finally { $taskSocket.Stop() }
        }
        throw 'No free local port was found. Close other copies and try again.'
    }
    $taskWebPort = Find-AvailablePort ([int]$taskConfig.pagePort)
    $taskEnginePort = Find-AvailablePort ([int]$taskConfig.enginePort)
    if ($taskEnginePort -eq $taskWebPort) { $taskEnginePort = Find-AvailablePort ($taskWebPort + 1) }
    $env:SWAP_STUDIO_PORT = [string]$taskWebPort
    $env:SWAP_COMFY_URL = 'http://127.0.0.1:' + $taskEnginePort
    $env:SWAP_PYTHON = $taskPython
    $env:SWAP_JOB_DIR = Join-Path $taskState 'jobs'
    $env:SWAP_ENGINE_PORT = [string]$taskEnginePort
    $env:SWAP_DEVICE = [string]$taskConfig.device
    $env:PYTHONUTF8 = '1'
    $taskLog = Join-Path $taskState 'logs'
    New-Item -ItemType Directory -Path $taskLog -Force | Out-Null
    $taskRun = Get-Date -Format 'yyyyMMdd-HHmmss'
    Write-Output 'Checking the bundled runtime and models...'
    & $taskPython -X utf8 (Join-Path $PSScriptRoot 'check_package.py') --quick 2>&1 | Out-File -LiteralPath (Join-Path $taskLog ($taskRun+'-check.log')) -Encoding UTF8
    if ($LASTEXITCODE -ne 0) { throw ('Runtime/model check failed. See '+$taskLog+'. If a DLL is missing, see README.txt.') }
    $taskEngineScript = Join-Path $PSScriptRoot 'launch_engine.py'
    $taskEngine = Start-Process -FilePath $taskPython -ArgumentList @('-s','-u',('"'+$taskEngineScript+'"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLog ($taskRun+'-engine.log')) -RedirectStandardError (Join-Path $taskLog ($taskRun+'-engine-error.log')) -PassThru
    $taskServerScript = Join-Path $taskAppPath 'server.mjs'
    $taskServer = Start-Process -FilePath $taskNode -ArgumentList @(('"'+$taskServerScript+'"')) -WorkingDirectory $taskAppPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLog ($taskRun+'-page.log')) -RedirectStandardError (Join-Path $taskLog ($taskRun+'-page-error.log')) -PassThru
    $taskUrl = 'http://127.0.0.1:' + $taskWebPort + '/'
    $taskRecord = @{url=$taskUrl;instanceId=$taskExpectedId;enginePort=$taskEnginePort;processes=@(
        @{id=$taskEngine.Id;path=$taskPython;started=$taskEngine.StartTime.ToUniversalTime().Ticks},
        @{id=$taskServer.Id;path=$taskNode;started=$taskServer.StartTime.ToUniversalTime().Ticks}
    )}
    $taskRecord | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskInstancePath -Encoding UTF8
    $taskReady = $false
    for ($taskAttempt=0; $taskAttempt -lt 40; $taskAttempt++) {
        try { $taskIdentity = Invoke-RestMethod -Uri ($taskUrl+'api/instance') -TimeoutSec 1
            if ($taskIdentity.instanceId -eq $taskExpectedId) { $taskReady=$true; break }
        } catch {}
        if ($taskServer.HasExited) { throw ('Page startup failed. See '+$taskLog) }
        Start-Sleep -Milliseconds 300
    }
    if (-not $taskReady) { throw ('Page startup timed out. See '+$taskLog) }
    Write-Output ('Opened: ' + $taskUrl)
    Write-Output 'The engine may need a moment. The page checks its status automatically.'
    if (-not $NoBrowser) { Start-Process $taskUrl }
} catch {
    # Stop only children just created by this failed startup.
    foreach ($taskOwned in @($taskServer,$taskEngine)) { if ($taskOwned -and -not $taskOwned.HasExited) { Stop-Process -Id $taskOwned.Id -ErrorAction SilentlyContinue } }
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally { $taskMutex.ReleaseMutex(); $taskMutex.Dispose() }
