// The mpv side of the e2e specs that drive real mpv: whether the native host is
// installed, and closing the mpv windows a spec started.
//
// mpv is started detached, so it outlives the host, and a spec closes it when done -
// but only its own. The cleanup used to close every mpv.exe that was not running when
// the spec loaded, which also took one the developer opened meanwhile, or one FastStream
// opened from their own Firefox. A spec's mpv is known by its stream: older hosts put the
// stream URL and the page's Referer on mpv's command line, both on the spec's test servers.
// The thin helper (host 15) starts mpv with no stream and loads it over mpv's IPC pipe, so
// its command line names nothing; such an mpv is asked over that pipe what its playlist
// holds (a read only). (A window that ran before the spec keeps the developer's: a test
// stream loaded into their own FastStream mpv window is left open, as it was before.)

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

// The spec's start: each spec file runs in a worker of its own, which loads this module.
const loadedAt = Date.now();

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

/**
 * @return {Array<{pid: number, startedAt: number, commandLine: string}>} The running mpv.exe
 *   processes, each with its start (ms since the epoch).
 */
export function mpvProcesses() {
  if (process.platform !== 'win32') {
    return [];
  }
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -Filter \'Name=\'\'mpv.exe\'\'\' | ' +
        'ForEach-Object { [string]$_.ProcessId + [char]9 + ' +
        '([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + [char]9 + $_.CommandLine }'],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
    return out.split(/\r?\n/)
        .map((line) => /^(\d+)\t(\d+)\t(.*)$/.exec(line))
        .filter(Boolean)
        .map((m) => ({pid: Number(m[1]), startedAt: Number(m[2]), commandLine: m[3]}));
  } catch (e) {
    return [];
  }
}

/**
 * @param {string} commandLine - An mpv's command line.
 * @return {?string} The IPC server it was started with (--input-ipc-server), if any.
 */
export function ipcServerOf(commandLine) {
  const match = /--input-ipc-server=([^"\s]+)/.exec(commandLine);
  return match ? match[1] : null;
}

/**
 * The files in an mpv's playlist, asked over its IPC server. Only get_property is sent.
 * @param {string} server - Its --input-ipc-server.
 * @param {number=} timeoutMs - How long to wait for its answer.
 * @return {Promise<Array<string>>} The playlist's filenames; none when mpv did not answer.
 */
export function mpvPlaylist(server, timeoutMs = 2000) {
  const RequestId = 4711;
  return new Promise((resolve) => {
    const socket = net.connect(server);
    let buffered = '';
    let timer = null;
    const done = (files) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(files);
    };
    timer = setTimeout(() => done([]), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', () => done([]));
    socket.on('connect', () => {
      socket.write(JSON.stringify({command: ['get_property', 'playlist'], request_id: RequestId}) + '\n');
    });
    // mpv's events come on the same pipe, before and after the answer.
    socket.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop();
      for (const line of lines) {
        let reply;
        try {
          reply = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (reply.request_id === RequestId) {
          done(Array.isArray(reply.data) ? reply.data.map((entry) => String(entry.filename)) : []);
          return;
        }
      }
    });
  });
}

/**
 * The mpv processes a spec started: those whose command line names one of its servers,
 * and those started after the spec loaded whose playlist names one (the thin helper's).
 * @param {Array<string>} origins - The spec's servers, e.g. 'http://127.0.0.1:41989'.
 * @param {{processes: (Array<Object>|undefined), since: (number|undefined),
 *   timeoutMs: (number|undefined)}=} options - For tests: the processes (mpvProcesses()),
 *   the spec's start (this module's load), how long each mpv may take to answer.
 * @return {Promise<Array<number>>} Their pids.
 */
export async function specMpvPids(origins, {processes = mpvProcesses(), since = loadedAt, timeoutMs} = {}) {
  const hosts = origins.map((origin) => new URL(origin).host);
  const namesASpecServer = (text) => hosts.some((host) => text.includes(host));
  const pids = [];
  for (const p of processes) {
    if (namesASpecServer(p.commandLine)) {
      pids.push(p.pid);
      continue;
    }
    const server = ipcServerOf(p.commandLine);
    if (server && p.startedAt >= since && (await mpvPlaylist(server, timeoutMs)).some(namesASpecServer)) {
      pids.push(p.pid);
    }
  }
  return pids;
}

/**
 * Closes the mpv windows a spec started, and only those.
 * @param {Array<string>} origins - The spec's servers.
 */
export async function closeSpecMpv(origins) {
  for (const pid of await specMpvPids(origins)) {
    try {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], {stdio: 'ignore'});
    } catch (e) {
      // Already gone.
    }
  }
}
