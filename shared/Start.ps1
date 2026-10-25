param([switch]$NoBrowser)
. (Join-Path $PSScriptRoot 'Config.ps1')
New-Item -ItemType Directory -Path $taskData -Force | Out-Null
$taskHash=[Security.Cryptography.SHA256]::Create()
$taskIdentity=([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($taskAppRoot.ToLowerInvariant())))).Replace('-','').ToLowerInvariant()
$taskMutex=New-Object Threading.Mutex($false,('Local\SwapShared-'+$taskIdentity.Substring(0,24)))
if (-not $taskMutex.WaitOne(0)) { Write-Output 'Shared studio is starting. Please wait.'; exit 0 }
try {
    $taskRecordPath=Join-Path $taskData 'instance.json'
    if (Test-Path -LiteralPath $taskRecordPath) {
        $taskPrevious=Get-Content -Raw -LiteralPath $taskRecordPath | ConvertFrom-Json
        $taskRunning=Test-OwnedProcess $taskPrevious.server
        if ($taskRunning) {
            Write-Output ('Already running: '+$taskPrevious.lanUrl)
            if (-not $NoBrowser) { Start-Process $taskPrevious.lanUrl }
            exit 0
        }
    }
    foreach ($taskFile in @($taskNode,$taskPython,(Join-Path $taskEngineDir 'main.py'),(Join-Path $taskModelDir 'diffusion_models\flux-2-klein-4b-Q4_K_M.gguf'),(Join-Path $taskModelDir 'text_encoders\Qwen3-4B-Q4_K_M.gguf'),(Join-Path $taskModelDir 'vae\flux2-vae.safetensors'))) {
        if (-not $taskFile -or -not (Test-Path -LiteralPath $taskFile)) { throw 'Runtime/models not found. Place this folder inside the complete host package, or configure shared/settings.local.json. See README.' }
    }
    if (Get-NetTCPConnection -State Listen -LocalPort $taskPort -ErrorAction SilentlyContinue) { throw ('Port '+$taskPort+' is busy. Change port in shared/settings.json.') }
    $taskAddresses=@($taskConfig.allowedAddresses)
    if (-not $taskAddresses.Count) {
        $taskAddresses=@(Get-NetIPConfiguration | Where-Object {$_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up'} | ForEach-Object {$_.IPv4Address.IPAddress} | Where-Object {$_ -match '^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)'})
    }
    if (-not $taskAddresses.Count) { throw 'No LAN address found. Connect Wi-Fi/Ethernet or set allowedAddresses in settings.json.' }
    $taskLog=Join-Path $taskData 'logs';New-Item -ItemType Directory -Path $taskLog -Force | Out-Null
    $taskRun=Get-Date -Format 'yyyyMMdd-HHmmss'
    $env:SWAP_SHARED='1';$env:SWAP_STUDIO_PORT=[string]$taskPort;$env:SWAP_ALLOWED_ADDRESSES=$taskAddresses -join ','
    $env:SWAP_SHARED_DATA=$taskData;$env:SWAP_JOB_DIR=Join-Path $taskData 'jobs'
    $env:SWAP_COMFY_URL='http://127.0.0.1:'+$taskEnginePort;$env:SWAP_ENGINE_PORT=[string]$taskEnginePort
    $env:SWAP_PYTHON=$taskPython;$env:SWAP_ENGINE_DIR=$taskEngineDir;$env:SWAP_MODEL_DIR=$taskModelDir
    $env:SWAP_DEVICE=[string]$taskConfig.device;$env:SWAP_CPU_THREADS=[string]$taskConfig.cpuThreads;$env:PYTHONUTF8='1'
    $taskEngineRecord=$null
    if (Get-NetTCPConnection -State Listen -LocalPort $taskEnginePort -ErrorAction SilentlyContinue) {
        $taskStats=Invoke-RestMethod -Uri ($env:SWAP_COMFY_URL+'/system_stats') -TimeoutSec 5
        if (-not $taskStats.system) { throw 'Engine port is occupied by another service.' }
        if ($taskPrevious -and (Test-OwnedProcess $taskPrevious.engine)) { $taskEngineRecord=$taskPrevious.engine }
        Write-Output 'Reusing the existing local ComfyUI engine.'
    } else {
        $taskEngine=Start-Process -FilePath $taskPython -ArgumentList @('-s','-u',('"'+(Join-Path $PSScriptRoot 'launch_engine.py')+'"')) -WorkingDirectory $taskAppRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLog ($taskRun+'-engine.log')) -RedirectStandardError (Join-Path $taskLog ($taskRun+'-engine-error.log')) -PassThru
        $taskEngine.PriorityClass='BelowNormal'
        $taskEngineRecord=@{id=$taskEngine.Id;path=$taskPython;started=$taskEngine.StartTime.ToUniversalTime().Ticks}
    }
    $taskServer=Start-Process -FilePath $taskNode -ArgumentList @(('"'+(Join-Path $taskAppRoot 'server.mjs')+'"')) -WorkingDirectory $taskAppRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskLog ($taskRun+'-page.log')) -RedirectStandardError (Join-Path $taskLog ($taskRun+'-page-error.log')) -PassThru
    $taskUrl='http://127.0.0.1:'+$taskPort+'/'
    $taskLanUrl='http://'+$taskAddresses[0]+':'+$taskPort+'/'
    $taskReady=$false
    for ($taskAttempt=0;$taskAttempt -lt 40;$taskAttempt++) {
        try { $taskResponse=Invoke-RestMethod -Uri ($taskUrl+'api/instance') -TimeoutSec 1;if ($taskResponse.instanceId -eq $taskIdentity -and $taskResponse.shared) {$taskReady=$true;break} } catch {}
        if ($taskServer.HasExited) { throw 'Shared page failed to start. See logs.' };Start-Sleep -Milliseconds 250
    }
    if (-not $taskReady) { throw 'Shared page startup timed out. See logs.' }
    @{url=$taskUrl;lanUrl=$taskLanUrl;server=@{id=$taskServer.Id;path=$taskNode;started=$taskServer.StartTime.ToUniversalTime().Ticks};engine=$taskEngineRecord} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $taskRecordPath -Encoding UTF8
    $taskCode=(Get-Content -Raw -LiteralPath (Join-Path $taskData 'access-code.txt')).Trim()
    @("换物工坊共享版","同事访问：$taskLanUrl","访问码：$taskCode",'', '同一局域网内使用。主机保持开机。不同浏览器的任务分别保存。','生成完成后及时下载结果；会话有效期为 7 天。','如另一台设备无法连接，请在主机运行“允许局域网访问.cmd”。') | Set-Content -LiteralPath (Join-Path $taskData '同事访问说明.txt') -Encoding UTF8
    Write-Output ('Shared page: '+$taskLanUrl)
    Write-Output ('Access code and link: '+(Join-Path $taskData '同事访问说明.txt'))
    if (-not $NoBrowser) { Start-Process $taskLanUrl;Start-Process (Join-Path $taskData '同事访问说明.txt') }
} catch {
    foreach ($taskChild in @($taskServer,$taskEngine)) { if ($taskChild -and -not $taskChild.HasExited) { Stop-Process -Id $taskChild.Id -ErrorAction SilentlyContinue } }
    Write-Error $_ -ErrorAction Continue;exit 1
} finally {$taskMutex.ReleaseMutex();$taskMutex.Dispose()}
