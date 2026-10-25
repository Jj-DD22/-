@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0shared\Firewall.ps1"
if errorlevel 1 pause
