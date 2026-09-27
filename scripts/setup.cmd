@echo off
rem Double-click this on Windows. It runs setup.ps1 without changing the machine's
rem PowerShell execution policy, which blocks unsigned scripts by default.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
