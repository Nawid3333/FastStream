// The mpv side of the e2e specs that drive real mpv: whether the native host is
// installed, and closing the mpv windows a spec started.
//
// mpv is started detached, so it outlives the host, and a spec closes it when done -
// but only its own. The cleanup used to close every mpv.exe that was not running when
// the spec loaded, which also took one the developer opened meanwhile, or one FastStream
// opened from their own Firefox. A spec's mpv is known by its command line: the host
// puts the stream URL and the page's Referer there, both on the spec's test servers.
// (A window the host reuses keeps its first command line; a test stream loaded into the
// developer's own FastStream mpv window is therefore left open, as it was before.)

import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** @return {?string} The native host's manifest Firefox finds, if it exists. */
function hostManifest() {
  try {
    const key = ['HKCU', 'Software', 'Mozilla', 'NativeMessagingHosts',
      'com.faststream.mpv'].join('\\');
    const out = execFileSync('reg', ['query', key],
        {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    const match = out.match(/REG_SZ\s+(.+)/);
    return match && fs.existsSync(match[1].trim()) ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

/** @return {boolean} Whether the native host is registered for Firefox. */
export function hostInstalled() {
  return hostManifest() !== null;
}

/**
 * What the native host logged since a moment, when its debug log is on (CI turns it on
 * with FASTSTREAM_MPV_DEBUG): each open request the extension sent, and what the host
 * started for it. install.ps1 puts the log next to the manifest.
 * @param {number} since - Date.now() of that moment.
 * @return {string[]} The log's lines since then; none without a log.
 */
export function hostLogSince(since) {
  const manifest = hostManifest();
  if (!manifest) {
    return [];
  }
  try {
    const log = fs.readFileSync(path.join(path.dirname(manifest), 'faststream-mpv-host.log'), 'utf8');
    return log.split(/\r?\n/).filter((line) => {
      try {
        return Date.parse(JSON.parse(line).time) >= since;
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    return [];
  }
}

/** @return {Array<{pid: number, commandLine: string}>} The running mpv.exe processes. */
export function mpvProcesses() {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter \'Name=\'\'mpv.exe\'\'\' | ' +
        'ForEach-Object { [string]$_.ProcessId + [char]9 + $_.CommandLine }'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return out.split(/\r?\n/)
        .map((line) => /^(\d+)\t(.*)$/.exec(line))
        .filter(Boolean)
        .map((m) => ({pid: Number(m[1]), commandLine: m[2]}));
  } catch (e) {
    return [];
  }
}

/**
 * The mpv processes a spec started: those whose command line names one of its servers.
 * @param {Array<string>} origins - The spec's servers, e.g. 'http://127.0.0.1:41989'.
 * @return {Array<number>} Their pids.
 */
export function specMpvPids(origins) {
  const hosts = origins.map((origin) => new URL(origin).host);
  return mpvProcesses()
      .filter((p) => hosts.some((host) => p.commandLine.includes(host)))
      .map((p) => p.pid);
}

/**
 * Closes the mpv windows a spec started, and only those.
 * @param {Array<string>} origins - The spec's servers.
 */
export function closeSpecMpv(origins) {
  for (const pid of specMpvPids(origins)) {
    try {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], {stdio: 'ignore'});
    } catch (e) {
      // Already gone.
    }
  }
}
