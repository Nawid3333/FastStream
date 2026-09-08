# Installs the FastStream mpv native messaging host on Windows.
#
# - Copies the host into %LOCALAPPDATA%\FastStreamMpvHost
# - Writes a .bat wrapper (node + host script) and the host manifest
# - Registers com.faststream.mpv in the registry for Chrome/Chromium browsers
#   and Firefox
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 `
#       [-Browser chrome|firefox|both] [-MpvPath <path>] [-ExtensionId <id>]
#
# -ExtensionId is required for Chrome-family browsers: the extension's ID
# (chrome://extensions -> Developer mode -> ID). Firefox uses the fixed ID
# thanatus@Nawid from the build manifest.

param(
    [ValidateSet('chrome', 'firefox', 'both')]
    [string]$Browser = 'both',
    [string]$MpvPath = 'C:\Program Files\mpv\mpv.exe',
    [string]$ExtensionId = '',
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

if (($Browser -ne 'firefox') -and -not $ExtensionId) {
    Write-Warning "No -ExtensionId given: Chrome-family registration will be skipped."
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

# 2. .bat wrapper - Chrome runs the manifest 'path' executable directly with
#    no arguments, so node + script must be wrapped.
$batPath = Join-Path $InstallDir "$HostName_.bat"
@"
@echo off
"$nodeCmd" "$(Join-Path $InstallDir 'faststream-mpv-host.mjs')" %*
"@ | Set-Content $batPath -Encoding ASCII

# 3. Native messaging manifest (shared by Chrome and Firefox)
$manifest = [ordered]@{
    name        = $HostName_
    description = 'FastStream mpv host - opens detected streams in mpv'
    path        = $batPath
    type        = 'stdio'
}
if ($ExtensionId) {
    $manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest.allowed_extensions = @($FirefoxId)

$manifestPath = Join-Path $InstallDir "$HostName_.json"
$manifest | ConvertTo-Json -Depth 4 | Set-Content $manifestPath -Encoding ASCII

# 4. Registration
if (($Browser -ne 'firefox') -and $ExtensionId) {
    $registryRoots = @(
        'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
        'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
        'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
        'HKCU:\Software\Vivaldi\NativeMessagingHosts'
    )
    foreach ($root in $registryRoots) {
        $key = Join-Path $root $HostName_
        New-Item -Path $key -Force | Out-Null
        Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    }
    Write-Host "Registered for Chrome/Edge/Brave/Vivaldi (HKCU, extension $ExtensionId)."
}

if ($Browser -ne 'chrome') {
    $key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\' + $HostName_
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath
    Write-Host "Registered for Firefox (extension $FirefoxId)."
}

Write-Host ""
Write-Host "FastStream mpv host installed."
Write-Host "  Manifest: $manifestPath"
Write-Host "  mpv:      $MpvPath"
Write-Host ""
Write-Host "Restart your browser, then use 'Test mpv connection' in FastStream settings."