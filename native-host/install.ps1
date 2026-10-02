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
# -InstallDir and -NoRegister are for tests: install into a scratch folder and leave the
# registry alone, so a test never touches the real installation.
#
# The extension is allowed by the fixed ID thanatus@Nawid from the build manifest.

param(
    [string]$MpvPath = 'C:\Program Files\mpv\mpv.exe',
    [string]$NodePath = 'node',
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'FastStreamMpvHost'),
    [switch]$NoRegister
)

$ErrorActionPreference = 'Stop'

$HostName_ = 'com.faststream.mpv'
$FirefoxId = 'thanatus@Nawid'
$HostScript = Join-Path $PSScriptRoot 'faststream-mpv-host.mjs'

# Windows PowerShell 5.1 writes -Encoding ASCII as '?' for every other character, and
# its -Encoding UTF8 puts a byte order mark in front, which JSON.parse refuses. A user
# name like "Jose" with an accent broke every path in these files. UTF-8, no BOM.
$Utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Write-Utf8File([string]$Path, [string]$Text) {
    [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

if (-not (Test-Path $HostScript)) {
    Write-Error "Host script not found: $HostScript"
    exit 1
}

$nodeCmd = (Get-Command $NodePath -ErrorAction SilentlyContinue).Source
if (-not $nodeCmd) {
    Write-Error "node not found. Install Node.js (22 or newer) or pass -NodePath <path-to-node.exe>."
    exit 1
}

if (-not (Test-Path $MpvPath)) {
    Write-Warning "mpv not found at '$MpvPath' - the host will fall back to 'mpv' on PATH."
}

# 1. Copy the host and write config
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item $HostScript (Join-Path $InstallDir 'faststream-mpv-host.mjs') -Force

# mpvPath is set; anything else config.json already holds stays ("debug": true, README.md):
# a reinstall (update-local.ps1 runs this one) used to drop it, and the log with it.
$configPath = Join-Path $InstallDir 'config.json'
$config = [ordered]@{}
if (Test-Path -LiteralPath $configPath) {
    try {
        $old = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
        foreach ($property in $old.PSObject.Properties) {
            $config[$property.Name] = $property.Value
        }
    } catch {
        Write-Warning "config.json could not be read ($($_.Exception.Message)); writing a new one."
    }
}
$config['mpvPath'] = $MpvPath
Write-Utf8File $configPath ($config | ConvertTo-Json)

# 2. .bat wrapper - Windows won't start a .mjs as a program, so the manifest
#    points at this, which runs it with node and hands on Firefox's arguments.
#    cmd reads a batch file in the console's code page, line by line: chcp 65001
#    makes it read the paths below as the UTF-8 they are written in.
$batPath = Join-Path $InstallDir "$HostName_.bat"
Write-Utf8File $batPath (@"
@echo off
chcp 65001 > nul
"$nodeCmd" "$(Join-Path $InstallDir 'faststream-mpv-host.mjs')" %*
"@ -replace "`r?`n", "`r`n")

# 3. Native messaging manifest
$manifest = [ordered]@{
    name               = $HostName_
    description        = 'FastStream mpv host - opens detected streams in mpv'
    path               = $batPath
    type               = 'stdio'
    allowed_extensions = @($FirefoxId)
}

$manifestPath = Join-Path $InstallDir "$HostName_.json"
Write-Utf8File $manifestPath ($manifest | ConvertTo-Json -Depth 4)

# 4. Registration
if (-not $NoRegister) {
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
Write-Host "Restart Firefox, then use 'Test mpv connection' in FastStream settings."
