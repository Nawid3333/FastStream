# Dot-sourced by update-local.ps1 (and its test): New-PrivateDirectory,
# Invoke-InPrivateDirectory, Test-ChangedSince, ConvertFrom-WslVersionText.

# Windows PowerShell started under PowerShell 7 - by cmd.exe or node in a PowerShell 7
# terminal, as VS Code's is - inherits 7's module folders ahead of its own, and then fails to
# load Microsoft.PowerShell.Security ("found in module ... but the module could not be
# loaded"): no Get-Acl, so the Node.js step failed. PowerShell 7 cleans the path only for a
# powershell.exe it starts itself. Its folders are dropped here, before any module loads.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object {
        $_ -and $_ -notmatch '\\PowerShell\\(\d+\\)?Modules\\?$' -and $_ -notmatch '\\WindowsApps\\Microsoft\.PowerShell_'
    }) -join ';'
}

# True when $File was written after $Marker, or $Marker does not exist (nothing installed yet).
function Test-ChangedSince([string]$File, [string]$Marker) {
    if (-not (Test-Path -LiteralPath $Marker)) { return $true }
    return (Get-Item -LiteralPath $File).LastWriteTimeUtc -gt (Get-Item -LiteralPath $Marker -Force).LastWriteTimeUtc
}

# Creates $Path with an ACL that admits only the current user, Administrators and SYSTEM,
# inheritance off. update-local.ps1 stages the Node.js installer there: %TEMP% is writable
# by any process running as this user, and one of them could swap the MSI between the hash
# check and the elevated msiexec.
# Accounts by SID, never by name: Windows names its built-in accounts in its own language
# ("Administratoren" on German Windows), and an English name fails there with "Some or all
# identity references could not be translated" (2026-10-03, the user's PC).
function New-PrivateDirectory([string]$Path) {
    New-Item -ItemType Directory -Path $Path | Out-Null
    $acl = Get-Acl -LiteralPath $Path
    # Inheritance off, inherited entries dropped: the default %ProgramData% ACL inherits
    # entries other users can create files in.
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $owners = @(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().User,
        (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')), # Administrators
        (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')) # SYSTEM
    )
    foreach ($sid in $owners) {
        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

# Runs $Body with a fresh private directory at $Path and removes the directory afterwards,
# however $Body ends: a thrown check, a declined admin prompt or a failed install left the
# ~30 MB Node.js installer behind in %ProgramData% (issue #244).
function Invoke-InPrivateDirectory([string]$Path, [scriptblock]$Body) {
    New-PrivateDirectory $Path
    try {
        & $Body
    }
    finally {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# The WSL version in what `wsl.exe --version` prints: the number on its first line with
# text, "WSL version: 2.6.1.0" ("WSL-Version: 2.6.1.0" on German Windows, so the label is
# not read). Without WSL_UTF8=1 wsl.exe writes UTF-16, which Windows PowerShell reads as a
# NUL after every character: those are dropped. $null for text whose first line has no
# version, as the help an old wsl.exe prints for an option it does not know.
function ConvertFrom-WslVersionText([string]$Text) {
    $clean = $Text -replace [string][char]0, ''
    foreach ($line in ($clean -split '\r?\n')) {
        if ($line.Trim()) {
            $m = [regex]::Match($line, '\d+(\.\d+){1,3}')
            if ($m.Success) { return $m.Value }
            return $null
        }
    }
    return $null
}
