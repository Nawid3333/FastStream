<#
Checks this PC's FastStream tools against what CI uses, and reports. Double-click
update-local.cmd in the repository's root, or run:

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\update-local.ps1 [-Repo <path>]

It changes nothing. Each check says what to do next; to apply everything it reports as
out of date, run:

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\update-local.ps1 -Apply

update-local.cmd asks "Update these now?" after a check that found something, and Y runs
exactly that. Exit codes: 0 nothing to do (or all applied), 1 a step failed, 2 the check
found something to update.

What it checks, and what -Apply does about it:
  - Node.js: the newest release of the major .nvmrc names, the one CI builds with, once it
    is 5 days old (CI's rule). -Apply fetches the installer from nodejs.org, checked against
    its SHASUMS256.txt and the OpenJS Foundation's code signature; Windows asks for admin
    rights to run it.
  - npm, installed globally (%APPDATA%\npm): its newest release, 5 days old. -Apply installs
    it with npm install --global --ignore-scripts.
  - pnpm, installed globally with npm: at least the version package.json pins
    ("packageManager"); inside the repository pnpm switches to that version by itself.
    -Apply installs it the same way.
  - The repository: on main with nothing uncommitted, how many commits main is behind origin
    (the check reports against what git already knows; -Apply fetches, then runs
    git pull --ff-only), then pnpm install --frozen-lockfile into the store node_modules was
    installed from, and fsaunpack's npm ci (scripts off) when it is installed: each only when
    its lockfile changed after its last install.
  - The mpv helper: whether %LOCALAPPDATA%\FastStreamMpvHost's copy is the repository's;
    -Apply runs native-host\install.ps1 again, with the mpv and Node paths it was installed
    with.

It never touches Firefox (it updates itself, and FastStream from this repository's
releases), mpv (its own repository updates it), or WSL (pnpm run verify:linux updates its
distros). -DryRun is accepted as an old name for the check; -Repo <path> works on another
checkout than the one this script is in.
#>
param([switch]$Apply, [switch]$DryRun, [string]$Repo = (Split-Path -Parent $PSScriptRoot))

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'update-local-lib.ps1')

# Windows PowerShell 5.1 may still offer TLS 1.0 first; nodejs.org wants 1.2.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$repo = (Resolve-Path -LiteralPath $Repo).Path
$summary = New-Object System.Collections.Generic.List[string]
$failed = New-Object System.Collections.Generic.List[string]

function Note([string]$line) {
    Write-Host "  $line"
    $summary.Add($line)
}

# Runs one change, or only names it. A native command's exit code counts.
function Invoke-Change([string]$what, [scriptblock]$action) {
    if (-not $Apply) {
        Note "available: $what"
        return
    }
    $global:LASTEXITCODE = 0
    # Windows PowerShell 5.1 turns what a native command writes to stderr (git's fetch report,
    # npm's warnings) into a terminating error under 'Stop' when output is redirected: the
    # exit code alone judges.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $action
    }
    finally {
        $ErrorActionPreference = $previous
    }
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
    Note "done: $what"
}

# A step that fails is reported at the end; the others still run.
function Invoke-Step([string]$title, [scriptblock]$body) {
    Write-Host ''
    Write-Host "== $title" -ForegroundColor Cyan
    try {
        & $body
    }
    catch {
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
# [version] reads 1-4 numbers: "v27.0.0-nightly1" or "10.1.0+sha512.x" lose their suffix.
function ConvertTo-Version([string]$text) {
    $m = [regex]::Match($text, '\d+(\.\d+){0,3}')
    if (-not $m.Success) { throw "no version in '$text'" }
    # [version] wants two numbers at least: "22" is 22.0.
    $value = $m.Value
    if ($value -notmatch '\.') { $value = "$value.0" }
    return [version]$value
}

function Get-ToolVersion([string]$tool) {
    Push-Location $env:TEMP
    try {
        $out = & $tool --version
        if ($LASTEXITCODE -ne 0) { throw "$tool --version failed" }
        return ((($out | Out-String).Trim()) -replace '^v', '')
    }
    finally {
        Pop-Location
    }
}

Invoke-Step 'Node.js' {
    $major = (ConvertTo-Version (Get-Content -Raw -LiteralPath (Join-Path $repo '.nvmrc'))).Major
    $have = Get-ToolVersion 'node'
    $want = Get-NewestRelease 'node' "$major"
    if ((ConvertTo-Version $have).Major -gt $major) {
        Note "Node.js ${have}: kept, newer than the $major.x .nvmrc names"
    }
    elseif (-not $want) {
        Note "Node.js ${have}: no $major.x release is 5 days old yet, kept"
    }
    elseif ((ConvertTo-Version $have) -ge (ConvertTo-Version $want)) {
        Note "Node.js ${have}: up to date"
    }
    else {
        if (-not $Apply) { Note "Node.js ${have}: $want is out (nodejs.org/dist/v$want/); -Apply installs it"; return }
        $base = "https://nodejs.org/dist/v$want"
        $file = "node-v$want-x64.msi"
        # Per-run staging directory whose ACL admits only this user, Administrators and
        # SYSTEM: %TEMP% is writable by any process running as this user, and one of them
        # could swap the MSI between the hash check and the elevated msiexec. The elevated
        # installer must verify a file nobody else could have replaced after the check.
        $work = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('FastStream\node-' + [guid]::NewGuid().ToString('N'))
        $msi = Join-Path $work $file
        Invoke-Change "Node.js $have -> $want (nodejs.org installer; Windows asks for admin rights)" {
            # Only this user (writes and hashes the file), Administrators and SYSTEM
            # (msiexec runs as one of them) may write there.
            New-PrivateDirectory $work
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 600 -Uri "$base/$file" -OutFile $msi
            $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
            $line = ($sums -split "`n") | Where-Object { $_ -match ('\s' + [regex]::Escape($file) + '\s*$') } | Select-Object -First 1
            if (-not $line) { throw "SHASUMS256.txt names no $file" }
            $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
            $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $msi).Hash.ToLowerInvariant()
            if ($expected -ne $actual) { throw "$file does not match SHASUMS256.txt ($actual, expected $expected)" }
            # A hash from the same host proves nothing against whoever serves both: the installer
            # must also carry the OpenJS Foundation's valid code signature.
            $signature = Get-AuthenticodeSignature -LiteralPath $msi
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenJS Foundation') {
                throw "$file is not signed by the OpenJS Foundation ($($signature.Status))"
            }
            $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList "/i `"$msi`" /passive /norestart" -Verb RunAs -Wait -PassThru
            # 3010: installed, a restart completes it.
            if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) { throw "the installer ended with $($process.ExitCode)" }
            Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

Invoke-Step 'npm' {
    $have = Get-ToolVersion 'npm'
    $want = Get-NewestRelease 'npm' 'npm'
    if (-not $want -or (ConvertTo-Version $have) -ge (ConvertTo-Version $want)) {
        Note "npm ${have}: up to date"
    }
    elseif (-not $Apply) {
        Note "npm ${have}: $want is out (npm install --global --ignore-scripts npm@$want); -Apply installs it"
    }
    else {
        Invoke-Change "npm $have -> $want" { & npm install --global --ignore-scripts "npm@$want" }
    }
}

Invoke-Step 'pnpm' {
    $pin = ((Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json).packageManager) -replace '^pnpm@', '' -replace '\+.*$', ''
    $have = Get-ToolVersion 'pnpm'
    if ((ConvertTo-Version $have) -ge (ConvertTo-Version $pin)) {
        Note "pnpm ${have}: up to date (package.json pins $pin)"
    }
    elseif (-not $Apply) {
        Note "pnpm ${have}: $pin is pinned (npm install --global --ignore-scripts pnpm@$pin); -Apply installs it"
    }
    else {
        Invoke-Change "pnpm $have -> $pin, the version package.json pins" { & npm install --global --ignore-scripts "pnpm@$pin" }
    }
}

# Whether the repository is on main with nothing uncommitted: only then is it pulled, and
# only then is its mpv helper the one to install. Checking the branch and tree is local;
# how far main is behind origin is only as fresh as the last fetch, so -Apply fetches first
# (its --ff-only then runs on top of fresh origin data), and the check does not: it reports
# against what git already knows.
$script:onMain = $false
Invoke-Step 'The repository' {
    Push-Location $repo
    try {
        $remote = (& git remote | Out-String).Trim() -split "`r?`n" | Select-Object -First 1
        $dirty = & git status --porcelain
        $branch = ((& git rev-parse --abbrev-ref HEAD) | Out-String).Trim()
        if ($dirty) {
            Note 'repository: uncommitted changes, not pulled'
        }
        elseif ($branch -ne 'main') {
            Note "repository: on $branch, not main; not pulled"
        }
        elseif (-not $remote) {
            Note 'repository: no remote, not pulled'
        }
        else {
            $script:onMain = $true
            if ($Apply) {
                Invoke-Change 'git fetch --prune --tags' { & git fetch --prune --tags }
            }
            $behind = [int]((& git rev-list --count "main..$remote/main") | Out-String).Trim()
            if ($behind -eq 0) {
                Note 'repository: up to date with origin/main'
            }
            elseif (-not $Apply) {
                Note "repository: $behind behind origin/main (git pull --ff-only); -Apply pulls, then installs"
                return
            }
            else {
                Invoke-Change 'git pull --ff-only' { & git pull --ff-only }
            }
            # The store node_modules was installed from: another one makes pnpm stop.
            $storeArgs = @()
            $modules = Join-Path $repo 'node_modules\.modules.yaml'
            if (Test-Path -LiteralPath $modules) {
                $match = Select-String -LiteralPath $modules -Encoding UTF8 -Pattern '"?storeDir"?:\s*"?([^",]+)' | Select-Object -First 1
                if ($match) {
                    $store = $match.Matches[0].Groups[1].Value.Trim() -replace '\\\\', '\' -replace '[\\/]v\d+$', ''
                    $storeArgs = @('--store-dir', $store)
                }
            }
            # An install only when the lockfile changed after the last one: git rewrites a file
            # only when it changes, and every install that changes something rewrites its
            # marker (pnpm's node_modules\.modules.yaml, npm's node_modules\.package-lock.json).
            # Offered every time, the check never came back clean (2026-10-03).
            $label = ('pnpm install --frozen-lockfile ' + ($storeArgs -join ' ')).Trim()
            if (Test-ChangedSince (Join-Path $repo 'pnpm-lock.yaml') $modules) {
                Invoke-Change $label { & pnpm install --frozen-lockfile @storeArgs }
            }
            else {
                Note 'node_modules: installed from the current pnpm-lock.yaml'
            }
            $unpack = Join-Path $repo 'fsaunpack'
            if (Test-Path -LiteralPath (Join-Path $unpack 'node_modules')) {
                if (Test-ChangedSince (Join-Path $unpack 'package-lock.json') (Join-Path $unpack 'node_modules\.package-lock.json')) {
                    Push-Location $unpack
                    try {
                        Invoke-Change 'fsaunpack: npm ci --ignore-scripts' { & npm ci --ignore-scripts }
                    }
                    finally {
                        Pop-Location
                    }
                }
                else {
                    Note 'fsaunpack: node_modules installed from the current package-lock.json'
                }
            }
        }
    }
    finally {
        Pop-Location
    }
}

Invoke-Step 'The mpv helper' {
    $installDir = Join-Path $env:LOCALAPPDATA 'FastStreamMpvHost'
    $installed = Join-Path $installDir 'faststream-mpv-host.mjs'
    $source = Join-Path $repo 'native-host\faststream-mpv-host.mjs'
    if (-not (Test-Path -LiteralPath $installed)) {
        Note 'mpv helper: not installed on this PC (native-host\install.ps1 installs it)'
    }
    elseif (-not $script:onMain -and $Apply) {
        Note 'mpv helper: left as it is, since the repository is not on a clean main'
    }
    elseif ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath $source).Hash) {
        Note 'mpv helper: up to date'
    }
    else {
        $config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installDir 'config.json') | ConvertFrom-Json
        $bat = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $installDir 'com.faststream.mpv.bat')
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
$due = -not $Apply -and ($summary | Where-Object { $_ -match '^(available:|repository:.*behind)' })
if ($due) {
    Write-Host '  Run tools\update-local.ps1 -Apply to bring everything reported above up to date.'
}
if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host 'Failed:' -ForegroundColor Red
    foreach ($line in $failed) { Write-Host "  $line" -ForegroundColor Red }
    exit 1
}
# 2: the check found something to update (update-local.cmd then offers to apply it).
if ($due) { exit 2 }
exit 0
