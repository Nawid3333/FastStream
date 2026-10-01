<#
Brings this PC's FastStream tools up to date in one go. Double-click update-local.cmd in the
repository's root, or run:

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\update-local.ps1 [-DryRun]

  - Node.js: the newest release of the major .nvmrc names, the one CI builds with, once it is
    5 days old (CI's rule). The installer comes from nodejs.org and is checked against its
    SHASUMS256.txt; Windows asks for admin rights to run it.
  - npm, installed globally (%APPDATA%\npm): its newest release, 5 days old.
  - pnpm, installed globally with npm: at least the version package.json pins
    ("packageManager"); inside the repository pnpm switches to that version by itself.
  - The repository, on main with nothing uncommitted: git pull --ff-only, then pnpm install
    --frozen-lockfile into the store node_modules was installed from, and fsaunpack's npm ci
    (scripts off) when it is installed.
  - The mpv helper: native-host\install.ps1 again when the repository's host is not the
    installed one, with the mpv and Node paths it was installed with.

It never touches Firefox (it updates itself, and FastStream from this repository's releases),
mpv (its own repository updates it), or WSL (pnpm run verify:linux updates its distros).
-DryRun says what it would do and changes nothing. -Repo <path> works on another checkout
than the one this script is in.
#>
param([switch]$DryRun, [string]$Repo = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 may still offer TLS 1.0 first; nodejs.org wants 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repo = (Resolve-Path -LiteralPath $Repo).Path
$summary = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]

function Note([string]$line) {
    Write-Host "  $line"
    $summary.Add($line)
}

# Runs one change, or only names it with -DryRun. A native command's exit code counts.
function Invoke-Change([string]$what, [scriptblock]$action) {
    if ($DryRun) {
        Note "would: $what"
        return
    }
    $global:LASTEXITCODE = 0
    & $action
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
    Note "done: $what"
}

# A step that fails is reported at the end; the others still run.
function Invoke-Step([string]$title, [scriptblock]$body) {
    Write-Host ''
    Write-Host "== $title" -ForegroundColor Cyan
    try {
        & $body
    } catch {
        Write-Host "  failed: $($_.Exception.Message)" -ForegroundColor Red
        $failed.Add("${title}: $($_.Exception.Message)")
    }
}

function Get-NewestRelease([string]$what, [string]$name) {
    $out = & node (Join-Path $PSScriptRoot 'newest-release.mjs') $what $name
    if ($LASTEXITCODE -ne 0) { throw "could not look up the newest $name" }
    return (($out | Out-String).Trim())
}

# The version a tool reports, from outside the repository (inside it, pnpm runs the
# version package.json pins).
function Get-ToolVersion([string]$tool) {
    Push-Location $env:TEMP
    try {
        $out = & $tool --version
        if ($LASTEXITCODE -ne 0) { throw "$tool --version failed" }
        return ((($out | Out-String).Trim()) -replace '^v', '')
    } finally {
        Pop-Location
    }
}

Invoke-Step 'Node.js' {
    $major = [int]((Get-Content -Raw (Join-Path $repo '.nvmrc')).Trim())
    $have = Get-ToolVersion 'node'
    $want = Get-NewestRelease 'node' "$major"
    if (([version]$have).Major -gt $major) {
        Note "Node.js ${have}: kept, newer than the $major.x .nvmrc names"
    } elseif (-not $want) {
        Note "Node.js ${have}: no $major.x release is 5 days old yet, kept"
    } elseif ([version]$have -ge [version]$want) {
        Note "Node.js ${have}: up to date"
    } else {
        $base = "https://nodejs.org/dist/v$want"
        $file = "node-v$want-x64.msi"
        $msi = Join-Path $env:TEMP $file
        Invoke-Change "Node.js $have -> $want (nodejs.org installer; Windows asks for admin rights)" {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $msi
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
            $line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($file) + '\s*$') } | Select-Object -First 1
            if (-not $line) { throw "SHASUMS256.txt names no $file" }
            $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash.ToLowerInvariant()
            if ($expected -ne $actual) { throw "$file does not match SHASUMS256.txt ($actual, expected $expected)" }
            $process = Start-Process -FilePath msiexec.exe -ArgumentList "/i `"$msi`" /passive /norestart" -Verb RunAs -Wait -PassThru
            # 3010: installed, a restart completes it.
            if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw "the installer ended with $($process.ExitCode)" }
            Remove-Item -LiteralPath $msi -ErrorAction SilentlyContinue
        }
    }
}

Invoke-Step 'npm' {
    $have = Get-ToolVersion 'npm'
    $want = Get-NewestRelease 'npm' 'npm'
    if (-not $want -or [version]$have -ge [version]$want) {
        Note "npm ${have}: up to date"
    } else {
        Invoke-Change "npm $have -> $want" { & npm install --global --ignore-scripts "npm@$want" }
    }
}

Invoke-Step 'pnpm' {
    $pin = ((Get-Content -Raw (Join-Path $repo 'package.json') | ConvertFrom-Json).packageManager) -replace '^pnpm@', ''
    $have = Get-ToolVersion 'pnpm'
    if ([version]$have -ge [version]$pin) {
        Note "pnpm ${have}: up to date (package.json pins $pin)"
    } else {
        Invoke-Change "pnpm $have -> $pin, the version package.json pins" { & npm install --global --ignore-scripts "pnpm@$pin" }
    }
}

# Whether the repository is on main with nothing uncommitted: only then is it pulled, and
# only then is its mpv helper the one to install.
$script:onMain = $false
Invoke-Step 'The repository' {
    Push-Location $repo
    try {
        $dirty = & git status --porcelain
        $branch = ((& git rev-parse --abbrev-ref HEAD) | Out-String).Trim()
        if ($dirty) {
            Note 'repository: uncommitted changes, not pulled'
        } elseif ($branch -ne 'main') {
            Note "repository: on $branch, not main; not pulled"
        } else {
            $script:onMain = $true
            Invoke-Change 'git pull --ff-only' { & git pull --ff-only }
            # The store node_modules was installed from: another one makes pnpm stop.
            $storeArgs = @()
            $modules = Join-Path $repo 'node_modules\.modules.yaml'
            if (Test-Path -LiteralPath $modules) {
                $match = Select-String -LiteralPath $modules -Pattern '"?storeDir"?:\s*"?([^",]+)' | Select-Object -First 1
                if ($match) {
                    $store = $match.Matches[0].Groups[1].Value.Trim() -replace '\\\\', '\' -replace '[\\/]v\d+$', ''
                    $storeArgs = @('--store-dir', $store)
                }
            }
            $label = ('pnpm install --frozen-lockfile ' + ($storeArgs -join ' ')).Trim()
            Invoke-Change $label { & pnpm install --frozen-lockfile @storeArgs }
            if (Test-Path -LiteralPath (Join-Path $repo 'fsaunpack\node_modules')) {
                Push-Location (Join-Path $repo 'fsaunpack')
                try {
                    Invoke-Change 'fsaunpack: npm ci --ignore-scripts' { & npm ci --ignore-scripts }
                } finally {
                    Pop-Location
                }
            }
        }
    } finally {
        Pop-Location
    }
}

Invoke-Step 'The mpv helper' {
    $installDir = Join-Path $env:LOCALAPPDATA 'FastStreamMpvHost'
    $installed = Join-Path $installDir 'faststream-mpv-host.mjs'
    $source = Join-Path $repo 'native-host\faststream-mpv-host.mjs'
    if (-not (Test-Path -LiteralPath $installed)) {
        Note 'mpv helper: not installed on this PC (native-host\install.ps1 installs it)'
    } elseif (-not $script:onMain -and -not $DryRun) {
        Note 'mpv helper: left as it is, since the repository is not on a clean main'
    } elseif ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath $source).Hash) {
        Note 'mpv helper: up to date'
    } else {
        $config = Get-Content -Raw (Join-Path $installDir 'config.json') | ConvertFrom-Json
        $bat = Get-Content -Raw (Join-Path $installDir 'com.faststream.mpv.bat')
        $node = 'node'
        if ($bat -match '"([^"]*node(\.exe)?)"') { $node = $Matches[1] }
        Invoke-Change "mpv helper: install.ps1 again (mpv $($config.mpvPath), Node $node)" {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo 'native-host\install.ps1') -MpvPath $config.mpvPath -NodePath $node
        }
    }
}

Write-Host ''
Write-Host '== Summary' -ForegroundColor Cyan
foreach ($line in $summary) { Write-Host "  $line" }
Write-Host '  Not touched: Firefox (updates itself), mpv (its own repository), WSL (pnpm run verify:linux).'
if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host 'Failed:' -ForegroundColor Red
    foreach ($line in $failed) { Write-Host "  $line" -ForegroundColor Red }
    exit 1
}
exit 0
