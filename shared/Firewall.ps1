. (Join-Path $PSScriptRoot 'Config.ps1')
$taskAdmin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $taskAdmin) { throw 'Run Allow-LAN.cmd as administrator to permit the shared page on Private networks.' }
$taskRule='SwapStudio-Shared-'+$taskPort
$taskExisting=Get-NetFirewallRule -Name $taskRule -ErrorAction SilentlyContinue
if (-not $taskExisting) {
    New-NetFirewallRule -Name $taskRule -DisplayName ('Swap Studio shared page '+$taskPort) -Direction Inbound -Action Allow -Protocol TCP -LocalPort $taskPort -Program $taskNode -Profile Private -RemoteAddress LocalSubnet | Out-Null
} else {
    $taskExisting | Set-NetFirewallRule -Enabled True -Action Allow -Profile Private -RemoteAddress LocalSubnet -Program $taskNode -Protocol TCP -LocalPort $taskPort
}
Write-Output ('Allowed private LAN access to page port '+$taskPort+'. ComfyUI remains private.')
