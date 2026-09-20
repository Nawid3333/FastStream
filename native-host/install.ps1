# Installs the FastStream mpv native messaging host on Windows, for Firefox.
#
# - Copies the host into %LOCALAPPDATA%\FastStreamMpvHost
# - Writes a .bat wrapper (node + host script) and the host manifest
# - Registers com.faststream.mpv in the registry for Firefox
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 `
#       [-MpvPath <path>] [-NodePath <path>]
#
# The extension is allowed by the fixed ID thanatus@Nawid from the build manifest.

param(
    [string]$MpvPath = 'C:\Program Files\mpv\mpv.exe',
    [string]$NodePath = 'node'
)

$ErrorActionPreference = 'Stop'

$HostName_ = 'com.faststream.mpv'
$FirefoxId = 'thanatus@Nawid'
$InstallDir = Join-Path $env:LOCALAPPDATA 'FastStreamMpvHost'
$HostScript = Join-Path $PSScriptRoot 'faststream-mpv-host.mjs'

if (-not (Test-Path $HostScript)) {
    Write-Error "Host script not found: $HostScript"
    exit 1
}

$nodeCmd = (Get-Command $NodePath -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
    Write-Error "node not found. Install Node.js (>=20) or pass -NodePath <path-to-node.exe>."
    exit 1
}

if (-not (Test-Path $MpvPath)) {
    Write-Warning "mpv not found at '$MpvPath' - the host will fall back to 'mpv' on PATH."
}

# 1. Copy the host and write config
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $HostScript (Join-Path $InstallDir 'faststream-mpv-host.mjs') -Force

@{
    mpvPath = $MpvPath
} | ConvertTo-Json | Set-Content (Join-Path $InstallDir 'config.json') -Encoding ASCII

# 2. .bat wrapper - the manifest 'path' executable is run directly with no
#    arguments, so node + script must be wrapped.
$batPath = Join-Path $InstallDir "$HostName_.bat"
@"
@echo off
"$nodeCmd" "$(Join-Path $InstallDir 'faststream-mpv-host.mjs')" %*
"@ | Set-Content $batPath -Encoding ASCII

# 3. Native messaging manifest
$manifest = [ordered]@{
    name               = $HostName_
    description        = 'FastStream mpv host - opens detected streams in mpv'
    path               = $batPath
    type               = 'stdio'
    allowed_extensions = @($FirefoxId)
}

$manifestPath = Join-Path $InstallDir "$HostName_.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath -Encoding ASCII

# 4. Registration
$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\' + $HostName_
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
Write-Host "Registered for Firefox (extension $FirefoxId)."

Write-Host ""
Write-Host "FastStream mpv host installed."
Write-Host "  Manifest: $manifestPath"
Write-Host "  mpv:      $MpvPath"
Write-Host ""
Write-Host "Restart Firefox, then use 'Test mpv connection' in FastStream settings."
