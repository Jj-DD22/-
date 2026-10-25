$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot 'runtime\python_embeded\python.exe'
& $taskPython -X utf8 (Join-Path $PSScriptRoot 'check_package.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
