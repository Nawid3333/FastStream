#!/usr/bin/env node
// FastStream mpv native messaging host.
//
// Receives messages from the FastStream extension over the Chrome/Firefox
// native messaging protocol (4-byte little-endian length prefix + JSON) and
// launches mpv on the user's machine.
//
// Messages:
//   {type: 'ping'}                -> {ok, mpv, path}
//   {type: 'open', url, headers?, mpvPath?, fullscreen?} -> {ok, error?}
//
// Configuration (optional): config.json next to this script:
//   {"mpvPath": "C:\\Program Files\\mpv\\mpv.exe", "debug": false}
// A path sent by the extension (options page "mpv path") takes precedence.
// With "debug": true (or FASTSTREAM_MPV_DEBUG=1) every message, the mpv
// command line and the launch result are appended to faststream-mpv-host.log
// next to this script.

import fs from 'fs';
import path from 'path';
import {execFile, spawn} from 'child_process';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const DefaultMpvPaths = [
  process.env.FASTSTREAM_MPV_PATH,
  'C:\\Program Files\\mpv\\mpv.exe',
  'C:\\Program Files (x86)\\mpv\\mpv.exe',
  'mpv',
].filter(Boolean);

/**
 * Appends one line to the debug log, when debugging is switched on with
 * `{"debug": true}` in config.json or FASTSTREAM_MPV_DEBUG=1.
 *
 * Never writes to stdout: that channel carries length-prefixed native
 * messages, and stray bytes on it corrupt the reply the browser is parsing.
 *
 * @param {Object} config - The parsed config.json.
 * @param {string} label - Short tag for the entry.
 * @param {*} [detail] - Optional JSON-serializable payload.
 * @return {void}
 */
function debugLog(config, label, detail) {
  if (!config.debug && !process.env.FASTSTREAM_MPV_DEBUG) {
    return;
  }
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      label,
      detail,
    });
    fs.appendFileSync(path.join(__dirname, 'faststream-mpv-host.log'),
        line + '\n');
  } catch (e) {
    // Logging must never take the host down.
  }
}

function readConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return {};
  }
}

function resolveMpvPath(messagePath) {
  const config = readConfig();
  const candidates = [
    messagePath,
    config.mpvPath,
    ...DefaultMpvPaths,
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    if (candidate === 'mpv') {
      // Trust PATH resolution without stat-ing a bare name.
      return candidate;
    }
    try {
      // Accept both the exe itself and its folder (e.g. the user entered
      // "C:\Program Files\mpv" instead of "C:\Program Files\mpv\mpv.exe").
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const exe = path.join(candidate, 'mpv.exe');
        fs.accessSync(exe, fs.constants.X_OK);
        return exe;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (e) {
      // Try the next candidate.
    }
  }

  return null;
}

/**
 * Writes one native-messaging frame and resolves once it has actually been
 * flushed. stdout is a pipe here, so writes are asynchronous -- calling
 * process.exit() straight after one can truncate the reply and leave the
 * extension with "Native host has exited".
 * @param {Object} message - The JSON payload to send.
 * @return {Promise<void>} Resolves when the frame has been flushed.
 */
function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return new Promise((resolve) => {
    process.stdout.write(Buffer.concat([header, payload]), () => resolve());
  });
}

function readMessage() {
  return new Promise((resolve) => {
    let header = null;
    let headerRead = 0;
    let body = null;
    let bodyRead = 0;

    const finish = (result) => {
      process.stdin.removeAllListeners();
      resolve(result);
    };

    const onData = (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (body === null) {
          // Keep filling the header until all 4 bytes are in: a short first
          // chunk would otherwise fall through to the body branch below
          // while body is still null.
          if (header === null) {
            header = Buffer.alloc(4);
          }
          const toCopy = Math.min(chunk.length - offset, 4 - headerRead);
          chunk.copy(header, headerRead, offset, offset + toCopy);
          headerRead += toCopy;
          offset += toCopy;
          if (headerRead === 4) {
            const length = header.readUInt32LE(0);
            if (length === 0) {
              finish(null);
              return;
            }
            body = Buffer.alloc(length);
          }
        } else {
          const toCopy = Math.min(chunk.length - offset, body.length - bodyRead);
          chunk.copy(body, bodyRead, offset, offset + toCopy);
          bodyRead += toCopy;
          offset += toCopy;
          if (bodyRead === body.length) {
            try {
              finish(JSON.parse(body.toString('utf8')));
            } catch (e) {
              finish(null);
            }
            return;
          }
        }
      }
    };

    const onEnd = () => {
      finish(null);
    };

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onEnd);
  });
}

/**
 * Quotes one argument for a Windows command line, per the rules
 * CommandLineToArgvW uses to take it apart again.
 * @param {string} value - The raw argument.
 * @return {string} The quoted argument.
 */
function quoteWindowsArg(value) {
  const str = String(value);
  return '"' + str.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * Launches mpv through the WMI process provider.
 *
 * Firefox runs a native messaging host inside a job object created with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and every descendant of the host joins
 * that job. When the host exits after replying, the job closes and Windows
 * kills everything in it -- including an mpv started with detached:true and
 * unref(), neither of which escapes a job. Measured: a directly spawned mpv
 * and one started via `cmd /c start` are both killed; one created by the WMI
 * service survives, because it is parented to WmiPrvSE rather than to us.
 *
 * @param {string} mpvPath - Path to the mpv executable.
 * @param {Array<string>} args - Arguments to pass to mpv.
 * @return {Promise<{ok: boolean, pid?: number, error?: string}>} Result.
 */
function launchViaWmi(mpvPath, args) {
  const commandLine = [mpvPath, ...args].map(quoteWindowsArg).join(' ');
  const script =
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
    '-Arguments @{CommandLine=\'' +
    commandLine.replace(/'/g, '\'\'') +
    '\'}; Write-Output (\'RC=\' + $r.ReturnValue + ' + '\' PID=\' + $r.ProcessId)';

  return new Promise((resolve) => {
    execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {timeout: 20000, windowsHide: true},
        (error, stdout) => {
          if (error) {
            resolve({ok: false, error: String(error.message || error)});
            return;
          }
          const match = /RC=(\d+)(?:\s+PID=(\d*))?/.exec(String(stdout));
          if (!match) {
            resolve({ok: false, error: 'unexpected WMI output: ' + stdout});
            return;
          }
          if (match[1] !== '0') {
            resolve({ok: false, error: 'WMI Create returned ' + match[1]});
            return;
          }
          resolve({ok: true, pid: match[2] ? Number(match[2]) : undefined});
        });
  });
}

function launchMpv(mpvPath, message, config) {
  const args = [];

  if (message.headers && Array.isArray(message.headers)) {
    // One --http-header-fields-append per header. The plain
    // --http-header-fields form takes a comma-separated list, so a value
    // containing a comma (legal in a Referer URL) would be split into two
    // malformed headers.
    for (const header of message.headers) {
      if (header && header.name && header.value) {
        args.push(`--http-header-fields-append=${header.name}: ${header.value}`);
      }
    }
  }

  let title = 'FastStream';
  try {
    title = new URL(message.url).hostname || title;
  } catch (e) {
    // Keep the default title for non-URLs.
  }
  args.push(`--force-media-title=${title}`);
  if (message.fullscreen) {
    args.push('--fullscreen');
  }
  args.push('--no-terminal');
  args.push('--');
  args.push(message.url);

  debugLog(config, 'spawn', {mpvPath, args});

  // On Windows mpv has to be started by someone outside this process's job
  // object, or the browser kills it the moment this host exits. See
  // launchViaWmi.
  if (process.platform === 'win32') {
    return launchViaWmi(mpvPath, args).then((result) => {
      if (result.ok) {
        return {ok: true};
      }
      debugLog(config, 'wmi-failed', result);
      // WMI can be locked down or the service stopped. A direct spawn at
      // least works for as long as the browser lets it live, which beats
      // refusing to play at all.
      return launchDirect(mpvPath, args);
    });
  }

  return launchDirect(mpvPath, args);
}

/**
 * Starts mpv as an ordinary detached child. Correct everywhere except inside
 * a Windows job object, where the parent's death takes mpv with it.
 * @param {string} mpvPath - Path to the mpv executable.
 * @param {Array<string>} args - Arguments to pass to mpv.
 * @return {Promise<{ok: boolean, error?: string}>} Result.
 */
function launchDirect(mpvPath, args) {
  return new Promise((resolve) => {
    try {
      // No windowsHide: mpv.exe is a GUI binary, and windowsHide puts
      // SW_HIDE in the STARTUPINFO the player window is created from, which
      // is the wrong request to make of the very window the user is waiting
      // for. --no-terminal already covers the console side.
      const child = spawn(mpvPath, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // Give mpv a moment to fail on a bad path/exec so the extension can
      // surface the error, but do not wait for full playback start.
      const timer = setTimeout(() => resolve({ok: true}), 500);
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ok: false, error: String(err.message || err)});
      });
    } catch (e) {
      resolve({ok: false, error: String(e.message || e)});
    }
  });
}

async function main() {
  const config = readConfig();
  const message = await readMessage();
  debugLog(config, 'received', message);
  if (!message || typeof message !== 'object') {
    process.exit(0);
    return;
  }

  if (message.type === 'ping') {
    const mpvPath = resolveMpvPath(message.mpvPath);
    debugLog(config, 'ping', {mpvPath});
    if (mpvPath) {
      await sendMessage({ok: true, mpv: true, path: mpvPath});
    } else {
      await sendMessage({ok: true, mpv: false});
    }
    process.exit(0);
    return;
  }

  if (message.type === 'open' && typeof message.url === 'string' && message.url.length > 0) {
    const mpvPath = resolveMpvPath(message.mpvPath);
    if (!mpvPath) {
      await sendMessage({ok: false, error: 'mpv executable not found'});
      process.exit(0);
      return;
    }
    const result = await launchMpv(mpvPath, message, config);
    debugLog(config, 'launched', {mpvPath, url: message.url, result});
    await sendMessage(result);
    process.exit(0);
    return;
  }

  await sendMessage({ok: false, error: 'unknown message'});
  process.exit(0);
}

main();
