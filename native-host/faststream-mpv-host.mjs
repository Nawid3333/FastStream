#!/usr/bin/env node
// @ts-check
// FastStream mpv native messaging host.
//
// Receives messages from the FastStream extension over the Firefox
// native messaging protocol (4-byte little-endian length prefix + JSON) and
// launches mpv on the user's machine.
//
// Messages:
//   {type: 'ping'}                -> {ok, mpv, path}
//   {type: 'open', url, headers?, mpvPath?, fullscreen?, contentType?, pageUrl?} -> {ok, error?}
//
// contentType ('anime'|'movie', optional) is appended to the URL handed to
// mpv as a #fs-content= fragment marker -- never sent to the CDN, but
// visible to gpu-toggles.lua's is_anime_content() via mpv's `path` property
// for content-aware shader selection.
//
// pageUrl (optional) is the browser tab's page URL. It is not passed on as
// such: a short hash of it goes into the same fragment as fs-id=, the stable
// key mpv's stream-resume.lua saves the playback position under (the stream
// URL itself usually carries an expiring token, so it changes on every
// visit), and a percent-encoded copy goes in as fs-page= for source-info.lua's
// "Site page" entry (copy it, reopen it in the browser). Neither tag is ever
// sent to the CDN.
//
// Configuration (optional): config.json next to this script:
//   {"mpvPath": "C:\\Program Files\\mpv\\mpv.exe", "debug": false}
// A path sent by the extension (options page "mpv path") takes precedence.
// With "debug": true (or FASTSTREAM_MPV_DEBUG=1) every message, the mpv
// command line and the launch result are appended to faststream-mpv-host.log
// next to this script.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {execFile, spawn} from 'child_process';
import net from 'net';
import os from 'os';
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

/**
 * Finds mpv on the PATH, as an absolute path.
 *
 * A bare `mpv` handed on as-is was trusted without a look: "Test mpv connection" said
 * mpv was there on a machine without it. And on Windows mpv is started through WMI,
 * whose provider process searches its own PATH, not the user's, so a per-user install
 * (scoop, a portable folder on the user's PATH) was not found there either. Looks for
 * mpv.exe on Windows: PATHEXT order would find mpv.com first, the console wrapper.
 *
 * @param {Object<string, string|undefined>} [env] - The environment to search.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @return {string|null} The executable, or null when no PATH directory has it.
 */
export function findMpvOnPath(env = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  // Windows keeps it as Path; a copied environment may have either spelling.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  const dirs = String((key && env[key]) || '').split(windows ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir.replace(/^"(.*)"$/, '$1'), windows ? 'mpv.exe' : 'mpv');
    try {
      if (fs.statSync(file).isFile()) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch (e) {
      // Not in this directory.
    }
  }
  return null;
}

// A UNC or device path (\\server\share, //server, \\?\, \\.\): Windows signs in to a
// UNC host with the user's credentials on a mere stat.
const NetworkOrDevicePath = /^[\\/]{2}/;

// The executable's own name: mpv, mpv.exe, mpv.com, or a build named after it
// (mpv-x86_64.exe). The path comes from the options page, and the host starts whatever
// it names, so a settings change must not turn this into "run any program".
const MpvExecutableName = /^mpv[\w.-]*$/i;

export function resolveMpvPath(messagePath) {
  const config = readConfig();
  const candidates = [
    messagePath,
    config.mpvPath,
    ...DefaultMpvPaths,
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    if (candidate === 'mpv') {
      const found = findMpvOnPath();
      if (found) {
        return found;
      }
      continue;
    }
    if (NetworkOrDevicePath.test(candidate)) {
      continue;
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
      if (!MpvExecutableName.test(path.basename(candidate))) {
        continue;
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

// An open message is a URL, a page URL and three headers: a few KB. The length prefix
// is trusted for the allocation, so a bigger one is refused rather than allocated
// (up to 4 GB).
export const MaxMessageBytes = 1024 * 1024;

/**
 * Reads one native-messaging frame.
 * @param {import('stream').Readable} [input] - The stream to read; stdin by default.
 * @return {Promise<?Object>} The message, or null for none, a malformed one or one
 *   over MaxMessageBytes.
 */
export function readMessage(input = process.stdin) {
  return new Promise((resolve) => {
    /** @type {?Buffer} */
    let header = null;
    let headerRead = 0;
    /** @type {?Buffer} */
    let body = null;
    let bodyRead = 0;

    const finish = (result) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
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
            if (length === 0 || length > MaxMessageBytes) {
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

    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onEnd);
  });
}

// Named pipe for mpv's JSON IPC. Only instances this host starts are given
// it, which is what keeps "reuse the open window" from ever reaching an mpv
// the user launched themselves -- that one has no such pipe, so it is
// invisible here and can never be loaded into or closed by us.
const IpcPipe = '\\\\.\\pipe\\faststream-mpv';

// How long to wait for mpv's window to exist before giving up on focusing it.
// mpv only creates its window once the stream has opened (unless it is started
// with --force-window=immediate, see launchMpv), so this bounds a slow CDN or
// HLS manifest rather than mpv's own startup. A late window is still worth
// raising: past this deadline it simply opens behind the browser. 30s is
// half of mpv's own 60s --network-timeout, after which it has given up on the
// stream anyway.
const WindowWaitSeconds = 30;

// Headroom on top of WindowWaitSeconds for PowerShell startup, the Add-Type
// compile and the focus retries, before the shell is killed.
const PowerShellTimeoutMs = (WindowWaitSeconds + 15) * 1000;

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
 * Appends a key=value tag to a URL's fragment. A URL fragment is never
 * transmitted to the HTTP server, so this cannot break a signed/tokenized CDN
 * URL, and mpv's scripts read it back off the `path` property.
 *
 * @param {string} streamUrl - The stream URL headed to mpv.
 * @param {string} tag - The tag, e.g. `fs-content=anime`.
 * @return {string} The URL with the tag appended.
 */
function withFragmentTag(streamUrl, tag) {
  const hashIndex = streamUrl.indexOf('#');
  if (hashIndex === -1) {
    return `${streamUrl}#${tag}`;
  }

  const existingFragment = streamUrl.slice(hashIndex + 1);
  return existingFragment.length > 0 ? `${streamUrl}&${tag}` : `${streamUrl}${tag}`;
}

/**
 * Drops fs-* tags a stream URL already carries in its fragment. The tags this host
 * appends come after them, and mpv's scripts must never read one a page made up (a
 * stream URL can come from a page): a forged fs-id= would move another site's resume
 * position, a forged fs-page= the "Site page" link.
 * @param {string} streamUrl - The stream URL as the extension sent it.
 * @return {string} The URL without fs-* fragment tags.
 */
export function withoutFsTags(streamUrl) {
  const hashIndex = streamUrl.indexOf('#');
  if (hashIndex === -1) {
    return streamUrl;
  }
  const kept = streamUrl.slice(hashIndex + 1).split('&')
      .filter((part) => !/^fs-/i.test(part));
  return kept.some(Boolean) ?
    streamUrl.slice(0, hashIndex + 1) + kept.join('&') :
    streamUrl.slice(0, hashIndex);
}

// The headers mpv is given, as MpvBackend.pickRelayHeaders picks them. The host checks
// again: anything that talks to it gets this far.
const RelayHeaderNames = /^(referer|origin|user-agent)$/i;

// Printable ASCII only, space to tilde: no CR/LF (a second header in mpv's request), no
// NUL, and none of the typographic quotes PowerShell treats as quote characters. A real
// Referer, Origin or User-Agent never needs anything else; a browser sends non-ASCII
// percent-encoded.
const RelayHeaderValue = /^[ -~]{1,4096}$/;

/**
 * The "Name: value" fields mpv is given for an open message's headers. Headers other
 * than Referer, Origin and User-Agent, and values that are not printable ASCII, are
 * dropped.
 * @param {*} headers - The message's headers, [{name, value}].
 * @return {Array<string>}
 */
export function relayHeaderFields(headers) {
  if (!Array.isArray(headers)) {
    return [];
  }
  const fields = [];
  for (const header of headers) {
    if (header && typeof header.name === 'string' && typeof header.value === 'string' &&
        RelayHeaderNames.test(header.name) && RelayHeaderValue.test(header.value)) {
      fields.push(`${header.name}: ${header.value}`);
    }
  }
  return fields;
}

/**
 * Whether a URL may be handed to mpv: http or https only. mpv also opens local files
 * and UNC paths, and a UNC path makes Windows sign in to that host with the user's
 * credentials. The extension checks this too (MpvBackend.isStreamUrl); the host checks
 * again because anything that can talk to it gets this far. The string itself has to
 * start with the scheme: the URL parser alone reads `https:\\host\share` as https://host/share.
 * @param {*} url - The candidate.
 * @return {boolean}
 */
export function isStreamUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return false;
  }
  try {
    const {protocol} = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch (e) {
    return false;
  }
}

/**
 * Appends an fs-content=anime|movie marker to a stream URL's fragment, for
 * gpu-toggles.lua's is_anime_content() to read back off mpv's `path`
 * property.
 *
 * @param {string} streamUrl - The stream URL headed to mpv.
 * @param {string} [contentType] - 'anime' or 'movie'; anything else is a
 *   no-op and streamUrl is returned unchanged.
 * @return {string} The URL, with the marker appended when contentType is set.
 */
export function withContentTypeFragment(streamUrl, contentType) {
  if (contentType !== 'anime' && contentType !== 'movie') {
    return streamUrl;
  }
  return withFragmentTag(streamUrl, `fs-content=${contentType}`);
}

/**
 * The resume key for a page: the first 16 hex digits of its URL's sha256.
 * Hashed, so the key is short and the same on every visit. (The address itself
 * goes into the URL too, as fs-page=; see pageFragmentFor.)
 *
 * @param {string} [pageUrl] - The browser tab's page URL.
 * @return {string|undefined} The key, or undefined for a missing or
 *   non-http(s) URL.
 */
export function resumeIdFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
    return undefined;
  }
  return crypto.createHash('sha256').update(pageUrl).digest('hex').slice(0, 16);
}

/**
 * Percent-encodes a page URL so it survives as one fragment tag value. mpv's
 * source-info.lua reads the tag back and decodes it. http(s) pages only, so
 * nothing else ever reaches the fragment as fs-page=.
 *
 * @param {string} [pageUrl] - The browser tab's page URL.
 * @return {string|undefined} The encoded page URL, or undefined for a
 *   missing or non-http(s) URL.
 */
export function pageFragmentFor(pageUrl) {
  if (typeof pageUrl !== 'string' || !/^https?:\/\//i.test(pageUrl)) {
    return undefined;
  }
  return encodeURIComponent(pageUrl);
}

/**
 * The URL to hand mpv for an open message: the stream URL plus its
 * fs-content=, fs-id= and fs-page= fragment tags.
 *
 * @param {Object} message - The open message from the extension.
 * @return {string} The URL for mpv.
 */
export function mpvTargetUrl(message) {
  const target = withContentTypeFragment(withoutFsTags(message.url), message.contentType);
  const resumeId = resumeIdFor(message.pageUrl);
  const withId = resumeId ? withFragmentTag(target, `fs-id=${resumeId}`) : target;
  // The page URL itself, percent-encoded, for source-info.lua's
  // "Site page" menu entry (copy it, open it in the browser). Same rule as
  // fs-id: http(s) pages only, still never sent to the CDN.
  const pageFragment = pageFragmentFor(message.pageUrl);
  return pageFragment ? withFragmentTag(withId, `fs-page=${pageFragment}`) : withId;
}

const IpcLockFile = path.join(os.tmpdir(), 'faststream-mpv-ipc.lock');

// Longer than any exchange with mpv takes (mpvIpcRequest gives up after 1.5 s): a lock
// this old was left by a host that was killed.
const IpcLockStaleMs = 10000;

/**
 * Runs fn while holding a lock every host process shares. Each "Send to mpv" is its own
 * host process, and loading into the running mpv sets the headers globally, then loads
 * the file: two sends a few milliseconds apart could run as set A, set B, load B, load A,
 * and A then played with B's headers (a 403 on a CDN that checks them).
 * @param {() => Promise<*>} fn - The exchange with mpv.
 * @param {string} [lockFile] - The lock; a shared one in the temp folder by default.
 * @param {number} [waitMs] - How long to wait for another host before going ahead anyway.
 * @return {Promise<*>} What fn returns.
 */
export async function withIpcLock(fn, lockFile = IpcLockFile, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  /** @type {?number} */
  let fd = null;
  while (fd === null && Date.now() <= deadline) {
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // No lock to be had here (a read-only temp folder): go ahead without.
        break;
      }
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > IpcLockStaleMs) {
          fs.rmSync(lockFile, {force: true});
          continue;
        }
      } catch (e2) {
        // Gone in between: try again at once.
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
      fs.rmSync(lockFile, {force: true});
    }
  }
}

/**
 * Loads a URL into the mpv instance already running on our pipe.
 *
 * @param {Object} message - The open message from the extension.
 * @param {Array<string>} headerFields - "Name: value" strings for mpv.
 * @param {string} title - Media title to display.
 * @param {typeof mpvIpcRequest} [ipcRequest] - Injectable for tests; defaults
 *   to the real named-pipe transport.
 * @param {string} [lockFile] - withIpcLock's lock; the shared one by default.
 * @return {Promise<{ok: boolean, pid?: number}>} ok:false when no instance of
 *   ours answered, in which case the caller should start one.
 */
export async function loadIntoExisting(message, headerFields, title, ipcRequest = mpvIpcRequest, lockFile = IpcLockFile) {
  /** @type {Array<{command: Array<*>}>} */
  const commands = [
    {command: ['set_property', 'http-header-fields', headerFields]},
    {command: ['set_property', 'force-media-title', title]},
  ];
  if (message.fullscreen) {
    commands.push({command: ['set_property', 'fullscreen', true]});
  }
  commands.push({command: ['loadfile', mpvTargetUrl(message), 'replace']});
  commands.push({command: ['get_property', 'pid']});

  // The headers are set for the whole player, then the file loads: another host's
  // send must not come in between (withIpcLock).
  const result = await withIpcLock(() => ipcRequest(commands), lockFile);
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
    // Cold starts are slow in this mpv setup: gpu-next on a Vulkan context,
    // uosc, thumbfast and the shader pipeline all initialise before the VO
    // window exists, and network streams add demuxer-open time on top. A 3s
    // deadline regularly expired on cold starts, and so did 10s once a slow
    // stream held the window back past it (the host logged focus=nowindow and
    // mpv then appeared behind the browser) -- see WindowWaitSeconds.
    '    $deadline = (Get-Date).AddSeconds(' + WindowWaitSeconds + ')',
    '    $h = [IntPtr]::Zero',
    '    $seen = $false',
    '    $misses = 0',
    '    while ((Get-Date) -lt $deadline) {',
    '      $p = Get-Process -Id ' + pidExpr + ' -ErrorAction SilentlyContinue',
    '      if ($p) { $seen = $true } else { $misses++ }',
    '      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) ' +
      '{ $h = $p.MainWindowHandle; break }',
    // mpv gone again after we saw it: it failed to open the URL and quit.
    // Give up instead of polling the full deadline for a window that can
    // never appear.
    '      if ($seen -and -not $p) { break }',
    // Never there at all: mpv quit before the first look (an option mpv
    // refuses, a broken install). Stop after about 2 s, not the full 30.
    '      if (-not $seen -and $misses -ge 20) { break }',
    '      Start-Sleep -Milliseconds 100',
    '    }',
    '    if ($h -ne [IntPtr]::Zero) {',
    '      $null = [FSFg]::AllowSetForegroundWindow([int]' + pidExpr + ')',
    // A single attempt can be refused when the foreground owner changes
    // between AttachThreadInput and SetForegroundWindow (the user clicking
    // somewhere during startup). Retry while the window did not actually
    // end up in the foreground.
    '      $tries = 0',
    '      $ok = $false',
    '      $fgok = $false',
    '      while ($tries -lt 3 -and -not $fgok) {',
    '        $tries++',
    '        $fg = [FSFg]::GetForegroundWindow()',
    '        $t = [FSFg]::GetWindowThreadProcessId($fg, [ref]([uint32]0))',
    '        $me = [FSFg]::GetCurrentThreadId()',
    '        $null = [FSFg]::AttachThreadInput($me, $t, $true)',
    '        $null = [FSFg]::ShowWindow($h, 5)',
    '        $null = [FSFg]::BringWindowToTop($h)',
    '        $ok = [FSFg]::SetForegroundWindow($h)',
    '        $null = [FSFg]::AttachThreadInput($me, $t, $false)',
    '        Start-Sleep -Milliseconds 250',
    '        $now = [FSFg]::GetForegroundWindow()',
    '        $fgok = ($now -eq $h)',
    '      }',
    '      Write-Output ("FOCUS=" + $ok + " FGOK=" + $fgok + ' +
      '" TRIES=" + $tries)',
    '    } elseif (-not $seen) { Write-Output "FOCUS=gone" }',
    '    else { Write-Output "FOCUS=nowindow" }',
    '  } catch { Write-Output "FOCUS=error" }',
  ];
}

/**
 * Runs a PowerShell script and returns its stdout.
 *
 * The script must be fixed text: data goes in through `env` and is read back as
 * `$env:NAME`. -EncodedCommand only gets the script past the command line; inside it,
 * a single-quoted string also ends at the typographic quotes U+2018-U+201B, so escaping
 * `'` alone let a header value close the string and run code.
 *
 * @param {Array<string>} lines - Script lines.
 * @param {number} timeoutMs - Kill the shell after this long.
 * @param {Object<string, string>} [env] - Extra environment variables for the script.
 * @return {Promise<string>} Captured stdout, empty on failure.
 */
export function runPowerShell(lines, timeoutMs, env = {}) {
  const encoded = Buffer.from(lines.join(String.fromCharCode(10)), 'utf16le')
      .toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {timeout: timeoutMs, windowsHide: true, env: {...process.env, ...env}},
        (error, stdout) => resolve(String(stdout || '')));
  });
}

// The environment variable launchViaWmi hands mpv's command line over in.
export const CommandLineEnv = 'FASTSTREAM_MPV_COMMAND_LINE';

// CreateProcess refuses a longer command line.
const MaxCommandLineChars = 32767;

/**
 * The PowerShell that starts mpv through WMI and focuses its window. Fixed text: the
 * command line is read from the environment (CommandLineEnv).
 * @return {Array<string>} Script lines.
 */
export function wmiLaunchLines() {
  return [
    ...focusApiLines(),
    'try { $null = [FSFg]::AllowSetForegroundWindow(-1) } catch {}',
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
      '-Arguments @{CommandLine=$env:' + CommandLineEnv + '}',
    'Write-Output ("RC=" + $r.ReturnValue + " PID=" + $r.ProcessId)',
    'if ($r.ReturnValue -eq 0) {',
    ...focusWindowLines('$r.ProcessId'),
    '}',
  ];
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
  ], PowerShellTimeoutMs);
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
 * @return {Promise<{ok: boolean, pid?: number, error?: string, focus?: string, foreground?: string}>}
 *   Result; focus and foreground are what the PowerShell script reported.
 */
function launchViaWmi(mpvPath, args) {
  const commandLine = [mpvPath, ...args].map(quoteWindowsArg).join(' ');
  if (commandLine.length >= MaxCommandLineChars) {
    return Promise.resolve({ok: false, error: 'the stream URL is too long for mpv\'s command line'});
  }

  return runPowerShell(wmiLaunchLines(), PowerShellTimeoutMs, {[CommandLineEnv]: commandLine}).then((text) => {
    const match = /RC=(\d+)(?:\s+PID=(\d*))?/.exec(text);
    if (!match) {
      return {ok: false, error: 'unexpected WMI output: ' + text};
    }
    if (match[1] !== '0') {
      return {ok: false, error: 'WMI Create returned ' + match[1]};
    }
    const focus = /FOCUS=(\S+)/.exec(text);
    if (focus && focus[1] === 'gone') {
      return {ok: false, error: 'mpv quit right after it started: check the mpv path, and mpv.conf for an option mpv refuses'};
    }
    const fgOk = /FGOK=(\S+)/.exec(text);
    const tries = /TRIES=(\d+)/.exec(text);
    return {
      ok: true,
      pid: match[2] ? Number(match[2]) : undefined,
      focus: focus ? focus[1] : undefined,
      foreground: fgOk ? fgOk[1] : undefined,
      tries: tries ? Number(tries[1]) : undefined,
    };
  });
}

async function launchMpv(mpvPath, message, config) {
  const args = [];
  const headerFields = relayHeaderFields(message.headers);

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
  // Create the window at startup instead of when the first video frame is
  // ready. By default mpv has no window until the stream has been opened and
  // probed, which on a slow anime CDN/HLS manifest can take longer than the
  // focus helper is willing to wait -- mpv then appears late and behind the
  // browser. With an immediate window the helper always finds it within a
  // second or two, and the stream loads visibly inside a focused player.
  args.push('--force-window=immediate');
  args.push('--no-terminal');
  args.push('--');
  args.push(mpvTargetUrl(message));

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
      // No direct spawn as a fallback: Firefox kills it the moment this host
      // exits (see launchViaWmi), so it reported success for an mpv that was
      // gone before it showed anything.
      return {ok: false, error: 'Could not start mpv: ' + result.error};
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
    if (!isStreamUrl(message.url)) {
      debugLog(config, 'refused', {url: message.url});
      await sendMessage({ok: false, error: 'mpv is only given http(s) streams'});
      process.exit(0);
      return;
    }
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
