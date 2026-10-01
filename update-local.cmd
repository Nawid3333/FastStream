@echo off
rem Double-click: checks this PC's FastStream tools and reports (tools\update-local.ps1 says
rem what). It changes nothing; it offers tools\update-local.ps1 -Apply to update.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update-local.ps1" %*
pause
