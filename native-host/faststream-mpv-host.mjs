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
import net from 'net';
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

// Named pipe for mpv's JSON IPC. Only instances this host starts are given
// it, which is what keeps "reuse the open window" from ever reaching an mpv
// the user launched themselves -- that one has no such pipe, so it is
// invisible here and can never be loaded into or closed by us.
const IpcPipe = '\\\\.\\pipe\\faststream-mpv';

/**
 * Sends commands to the mpv instance listening on our pipe.
 *
 * @param {Array<Object>} commands - mpv JSON IPC commands, in order.
 * @param {number} [timeoutMs] - How long to wait for the pipe and replies.
 * @return {Promise<{ok: boolean, replies?: Array<Object>, error?: string}>}
 *   ok:false simply means no instance of ours is running.
 */
export function mpvIpcRequest(commands, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const replies = [];
    let buffer = '';

    const socket = net.connect(IpcPipe);

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch (e) {
        // Already gone.
      }
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish(replies.length ?
        {ok: true, replies} :
        {ok: false, error: 'mpv ipc timeout'});
    }, timeoutMs);

    // Any connect error means there is no live instance of ours: a stale pipe
    // after mpv was closed behaves the same way.
    socket.on('error', () => finish({ok: false, error: 'no mpv ipc'}));

    socket.on('connect', () => {
      commands.forEach((command, index) => {
        socket.write(JSON.stringify(
            Object.assign({request_id: index + 1}, command)) + String.fromCharCode(10));
      });
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(String.fromCharCode(10));
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed.request_id !== undefined) {
            replies.push(parsed);
          }
        } catch (e) {
          // Event lines that are not replies; ignore.
        }
      }
      if (replies.length >= commands.length) {
        finish({ok: true, replies});
      }
    });
  });
}

/**
 * Loads a URL into the mpv instance already running on our pipe.
 *
 * @param {Object} message - The open message from the extension.
 * @param {Array<string>} headerFields - "Name: value" strings for mpv.
 * @param {string} title - Media title to display.
 * @param {typeof mpvIpcRequest} [ipcRequest] - Injectable for tests; defaults
 *   to the real named-pipe transport.
 * @return {Promise<{ok: boolean, pid?: number}>} ok:false when no instance of
 *   ours answered, in which case the caller should start one.
 */
export async function loadIntoExisting(message, headerFields, title, ipcRequest = mpvIpcRequest) {
  const commands = [
    {command: ['set_property', 'http-header-fields', headerFields]},
    {command: ['set_property', 'force-media-title', title]},
  ];
  if (message.fullscreen) {
    commands.push({command: ['set_property', 'fullscreen', true]});
  }
  commands.push({command: ['loadfile', message.url, 'replace']});
  commands.push({command: ['get_property', 'pid']});

  const result = await ipcRequest(commands);
  if (!result.ok) {
    return {ok: false};
  }

  // The loadfile reply is what decides success. mpvIpcRequest can resolve
  // ok:true on its own timeout as soon as *any* reply has come back (so a
  // live-but-slow pipe still counts as "ours"), which means the loadfile
  // reply specifically might not be in yet. Treat that as unconfirmed, not
  // successful -- otherwise this returns {ok: true} without ever knowing
  // whether the video actually loaded, and the caller skips starting a
  // fresh instance that would have played it.
  const loadReply = result.replies.find((r) => r.request_id === commands.length - 1);
  if (!loadReply || (loadReply.error && loadReply.error !== 'success')) {
    return {ok: false};
  }

  const pidReply = result.replies.find((r) => r.request_id === commands.length);
  return {
    ok: true,
    pid: pidReply && typeof pidReply.data === 'number' ? pidReply.data : undefined,
  };
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
 * PowerShell that declares the window APIs used to activate mpv.
 * @return {Array<string>} Script lines.
 */
function focusApiLines() {
  return [
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class FSFg {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int p);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '}',
    '"@',
  ];
}

/**
 * PowerShell that waits for a process's window and pulls it to the front.
 *
 * A process created by the WMI service has no right to take the foreground,
 * so mpv's own --focus-on=open is silently refused and its window opens
 * behind the browser. Attaching to the foreground thread's input queue is the
 * documented way back: it makes this thread a peer of whoever currently owns
 * the foreground, and SetForegroundWindow is then honoured.
 *
 * @param {string} pidExpr - PowerShell expression holding the process id.
 * @return {Array<string>} Script lines.
 */
function focusWindowLines(pidExpr) {
  return [
    '  try {',
    '    $deadline = (Get-Date).AddSeconds(3)',
    '    $h = [IntPtr]::Zero',
    '    while ((Get-Date) -lt $deadline) {',
    '      $p = Get-Process -Id ' + pidExpr + ' -ErrorAction SilentlyContinue',
    '      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) ' +
      '{ $h = $p.MainWindowHandle; break }',
    '      Start-Sleep -Milliseconds 100',
    '    }',
    '    if ($h -ne [IntPtr]::Zero) {',
    '      $null = [FSFg]::AllowSetForegroundWindow([int]' + pidExpr + ')',
    '      $fg = [FSFg]::GetForegroundWindow()',
    '      $t = [FSFg]::GetWindowThreadProcessId($fg, [ref]([uint32]0))',
    '      $me = [FSFg]::GetCurrentThreadId()',
    '      $null = [FSFg]::AttachThreadInput($me, $t, $true)',
    '      $null = [FSFg]::ShowWindow($h, 5)',
    '      $null = [FSFg]::BringWindowToTop($h)',
    '      $ok = [FSFg]::SetForegroundWindow($h)',
    '      $null = [FSFg]::AttachThreadInput($me, $t, $false)',
    '      Start-Sleep -Milliseconds 300',
    '      $now = [FSFg]::GetForegroundWindow()',
    '      Write-Output ("FOCUS=" + $ok + " FGOK=" + ($now -eq $h))',
    '    } else { Write-Output "FOCUS=nowindow" }',
    '  } catch { Write-Output "FOCUS=error" }',
  ];
}

/**
 * Runs a PowerShell script and returns its stdout.
 * @param {Array<string>} lines - Script lines.
 * @param {number} timeoutMs - Kill the shell after this long.
 * @return {Promise<string>} Captured stdout, empty on failure.
 */
function runPowerShell(lines, timeoutMs) {
  // -EncodedCommand takes UTF-16LE base64, which sidesteps every layer of
  // shell quoting the URL would otherwise have to survive.
  const encoded = Buffer.from(lines.join(String.fromCharCode(10)), 'utf16le')
      .toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {timeout: timeoutMs, windowsHide: true},
        (error, stdout) => resolve(String(stdout || '')));
  });
}

/**
 * Brings an already-running mpv window to the front.
 * @param {number} pid - The mpv process id.
 * @return {Promise<string>} The FOCUS= line PowerShell reported.
 */
async function focusPid(pid) {
  const out = await runPowerShell([
    ...focusApiLines(),
    '$target = ' + String(Number(pid)),
    ...focusWindowLines('$target'),
  ], 15000);
  const match = /FOCUS=(\S+)(?:\s+FGOK=(\S+))?/.exec(out);
  return match ? match[0] : 'FOCUS=unknown';
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
  const psCommandLine = commandLine.replace(/'/g, '\'\'');

  const lines = [
    ...focusApiLines(),
    'try { $null = [FSFg]::AllowSetForegroundWindow(-1) } catch {}',
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
      '-Arguments @{CommandLine=\'' + psCommandLine + '\'}',
    'Write-Output ("RC=" + $r.ReturnValue + " PID=" + $r.ProcessId)',
    'if ($r.ReturnValue -eq 0) {',
    ...focusWindowLines('$r.ProcessId'),
    '}',
  ];

  return runPowerShell(lines, 20000).then((text) => {
    const match = /RC=(\d+)(?:\s+PID=(\d*))?/.exec(text);
    if (!match) {
      return {ok: false, error: 'unexpected WMI output: ' + text};
    }
    if (match[1] !== '0') {
      return {ok: false, error: 'WMI Create returned ' + match[1]};
    }
    const focus = /FOCUS=(\S+)/.exec(text);
    const fgOk = /FGOK=(\S+)/.exec(text);
    return {
      ok: true,
      pid: match[2] ? Number(match[2]) : undefined,
      focus: focus ? focus[1] : undefined,
      foreground: fgOk ? fgOk[1] : undefined,
    };
  });
}

async function launchMpv(mpvPath, message, config) {
  const args = [];
  const headerFields = [];

  if (message.headers && Array.isArray(message.headers)) {
    for (const header of message.headers) {
      if (header && header.name && header.value) {
        headerFields.push(`${header.name}: ${header.value}`);
      }
    }
  }

  // One --http-header-fields-append per header. The plain
  // --http-header-fields form takes a comma-separated list, so a value
  // containing a comma (legal in a Referer URL) would be split into two
  // malformed headers.
  for (const field of headerFields) {
    args.push(`--http-header-fields-append=${field}`);
  }

  let title = 'FastStream';
  try {
    title = new URL(message.url).hostname || title;
  } catch (e) {
    // Keep the default title for non-URLs.
  }

  // Reuse the window we already own, rather than stacking up players. Only
  // instances started with our pipe answer, so an mpv the user opened
  // themselves is never loaded into.
  if (message.singleInstance) {
    const existing = await loadIntoExisting(message, headerFields, title);
    if (existing.ok) {
      let focus;
      if (existing.pid) {
        focus = await focusPid(existing.pid);
      }
      debugLog(config, 'reused', {pid: existing.pid, focus});
      return {ok: true};
    }
    args.push(`--input-ipc-server=${IpcPipe}`);
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
        debugLog(config, 'wmi-created',
            {pid: result.pid, focus: result.focus,
              foreground: result.foreground});
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

// Only run the native-messaging loop when executed directly (the .bat
// wrapper does `node faststream-mpv-host.mjs`) -- not when a test suite
// imports this module for its pure functions, which would otherwise block
// forever on main()'s stdin read.
if (process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
