// The mpv side of the e2e specs that drive real mpv: is the native host installed, and closing the
// spec's own mpv windows.
//
// Only the spec's own mpv is closed: one whose command line or IPC playlist names the spec's
// servers, never the developer's.

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
 * What the native host logged since a moment, with its debug log on (FASTSTREAM_MPV_DEBUG; next to
 * the manifest).
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
 * Sends one command to an mpv over its IPC server.
 * @param {string} server - Its --input-ipc-server.
 * @param {Array<*>} command
 * @param {number=} timeoutMs
 * @return {Promise<{error: string, data?: *}|null>} mpv's reply; null when it did not answer.
 */
export function mpvRequest(server, command, timeoutMs = 2000) {
  const RequestId = 4711;
  return new Promise((resolve) => {
    const socket = net.connect(server);
    let buffered = '';
    let timer = null;
    const done = (reply) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reply);
    };
    timer = setTimeout(() => done(null), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('error', () => done(null));
    socket.on('connect', () => {
      socket.write(JSON.stringify({command, request_id: RequestId}) + '\n');
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
          done(reply);
          return;
        }
      }
    });
  });
}

/**
 * The files in an mpv's playlist, asked over its IPC server.
 * @param {string} server - Its --input-ipc-server.
 * @param {number=} timeoutMs
 * @return {Promise<Array<string>>} The playlist's filenames; none when mpv did not answer.
 */
export async function mpvPlaylist(server, timeoutMs = 2000) {
  const reply = await mpvRequest(server, ['get_property', 'playlist'], timeoutMs);
  return Array.isArray(reply?.data) ? reply.data.map((entry) => String(entry.filename)) : [];
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
