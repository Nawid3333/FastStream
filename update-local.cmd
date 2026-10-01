@echo off
rem Double-click: brings this PC's FastStream tools up to date (tools\update-local.ps1 says what).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update-local.ps1" %*
pause
