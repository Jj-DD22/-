@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0shared\Stop.ps1"
if errorlevel 1 pause
