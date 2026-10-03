@echo off
rem Double-click: checks this PC's FastStream tools and reports (tools\update-local.ps1 says
rem what). When something is out of date (exit code 2) it asks before changing anything,
rem and Y runs tools\update-local.ps1 -Apply.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update-local.ps1" %*
if not errorlevel 2 goto done
echo.
choice /C YN /M "Update these now"
if errorlevel 2 goto done
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update-local.ps1" -Apply %*
:done
pause
