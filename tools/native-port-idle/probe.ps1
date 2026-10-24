# Does an open native-messaging port keep an MV3 event page running? The question behind MPV
# autoplay's watch (MpvBackend.watch keeps one port to the helper open for as long as mpv
# plays, and nothing else wakes the background meanwhile). docs/notes/mpv.md has the answer
# for Firefox 158; this asks a Firefox again, e.g. a new version:
#   pwsh tools/native-port-idle/probe.ps1 [-Modes drop,silent] [-TimeoutMs 5000] [-WaitMs 40000]
# A headless Firefox with a throwaway profile, a probe add-on and a test-only native host (no
# mpv, nothing of FastStream's own helper). The host is registered for this user under
# HKCU\Software\Mozilla\NativeMessagingHosts\faststream.idle.probe for the run and removed after.
# Modes: drop - the host exits after 2 s, so the page has no port (the control: it should stop
# a timeout later); silent - the port stays open, nothing is sent; out - the page sends every
# 1.5 s; in - the host sends every second.
param(
  [string[]]$Modes = @('drop', 'silent'),
  [int]$TimeoutMs = 5000,
  [int]$WaitMs = 40000
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node).Source
# The folder host.mjs and run.mjs use, as node names it.
$work = & $node -e "console.log(require('path').join(require('os').tmpdir(), 'faststream-idle-probe'))"
New-Item -ItemType Directory -Force $work | Out-Null
$cmd = Join-Path $work 'probe-host.cmd'
"@echo off`r`n`"$node`" `"$(Join-Path $PSScriptRoot 'host.mjs')`" %*`r`n" | Set-Content -LiteralPath $cmd -Encoding ascii -NoNewline
$manifest = Join-Path $work 'faststream.idle.probe.json'
@{ name = 'faststream.idle.probe'; description = 'FastStream idle probe (test only)'; path = $cmd
   type = 'stdio'; allowed_extensions = @('idle-probe@faststream.test') } | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding ascii
$zip = Join-Path $work 'idle-probe.zip'
$xpi = Join-Path $work 'idle-probe.xpi'
Remove-Item $zip, $xpi -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $PSScriptRoot 'ext\*') -DestinationPath $zip
Move-Item $zip $xpi
$key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\faststream.idle.probe'
try {
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name '(default)' -Value $manifest
  foreach ($mode in $Modes) {
    & $node (Join-Path $PSScriptRoot 'run.mjs') $mode $TimeoutMs $WaitMs
    if ($LASTEXITCODE -ne 0) { throw "the probe failed in mode $mode" }
    ''
  }
} finally {
  Remove-Item -Path $key -Recurse -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  "registration removed: $(-not (Test-Path $key))"
}
