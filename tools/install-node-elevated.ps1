<#
update-local.ps1's elevated installer for Node.js: the script its Node.js step starts with
RunAs, so the UAC prompt is for this script, and msiexec is started inside it, already
elevated. msiexec must not be pointed at the file the un-elevated half checked, because a
process running as this user can replace it after that check: instead, the staged
MSI is copied into a folder that only Administrators and SYSTEM can write, and the copy is
what gets checked, right before msiexec is started on it. The checks are the two the
un-elevated half ran: SHA-256 against what SHASUMS256.txt says - the one number handed in
as $Sha256 - and a valid code signature from the OpenJS Foundation; what passes both is
what the elevated msiexec installs.

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-node-elevated.ps1 -Msi <path> -Sha256 <hash>

Exits with msiexec's own code (0 or 3010 means installed), or, before msiexec runs, with
50: the staged installer is gone; 51: the copy's SHA-256 is not $Sha256; 52: the copy has
no valid signature of the OpenJS Foundation. update-local.ps1 names these in what it
reports; msiexec never returns codes like them.
#>
param([string]$Msi, [string]$Sha256)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'update-local-lib.ps1')

if (-not ($Sha256 -match '^[0-9a-f]{64}$')) { throw '-Sha256 has to be the 64 hex digits the un-elevated half read off SHASUMS256.txt' }
# Copying is the first step that needs the staged file to be there.
if (-not $Msi -or -not (Test-Path -LiteralPath $Msi)) { exit 50 }

# Under %SystemRoot%\Temp, not under %ProgramData%: the folder New-AdminOnlyDirectory makes
# below holds the copy behind a DACL only Administrators and SYSTEM are in, and an owner
# that is Administrators, so no process running as this user can write to it, rewrite the
# DACL as its owner, or replace it: renaming and deleting need rights the DACL does not
# give. It goes again however this ends, like the staged folder does.
$file = Split-Path -Leaf $Msi
$temp = Join-Path $env:SystemRoot 'Temp'
New-Item -ItemType Directory -Path $temp -Force | Out-Null
$work = Join-Path $temp ('node-' + [guid]::NewGuid().ToString('N'))
New-AdminOnlyDirectory $work
try {
    # From here on, the checks and msiexec read one and the same file: the folder's ACL
    # keeps everything running as this user out from now to the end of the install.
    $copy = Join-Path $work $file
    Copy-Item -LiteralPath $Msi -Destination $copy
    # The checks run on the copy: the staged original was checked by the un-elevated half,
    # but a same-user process can have replaced it between the check and here.
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $copy).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { exit 51 }
    # The signature is checked on the copy for the same reason the hash is.
    $signature = Get-AuthenticodeSignature -LiteralPath $copy
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'OpenJS Foundation') { exit 52 }
    # The checks and this start are the one elevated process, and the file was closed
    # between them: msiexec reads what they passed.
    $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList "/i `"$copy`" /passive /norestart" -Wait -PassThru
    # 3010: installed, a restart completes it.
    exit $process.ExitCode
}
finally {
    # The folder goes however this ends: a refused copy or a failed install would
    # otherwise leave the ~30 MB installer at %SystemRoot%\Temp (issue #244's shape here).
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
