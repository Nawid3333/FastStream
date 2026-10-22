#!/usr/bin/env node
// @ts-check
// FastStream mpv native messaging host.
//
// Receives messages from the FastStream extension over the Firefox
// native messaging protocol (4-byte little-endian length prefix + JSON) and
// launches mpv on the user's machine.
//
// Messages of host 15, the thin helper (docs/notes/mpv.md, "Host 15: the thin helper"):
//   {type: 'play', target, title?, start?, headers?, subtitles?, fullscreen?, newWindow?,
//     mpvPath?}
//     -> {ok, error?, reused?, focus?, foreground?} (checkPlayMessage, playMpv): target is
//     the whole URL for mpv, built by the extension; mpv is started with helper-fixed
//     arguments only, and the stream goes to it over its pipe.
//   {type: 'ipc', commands: [array-form mpv commands, at most 32]} -> {ok: true, replies:
//     [{error, data}, ...]} | {ok: false, error, busy?} | {ok: false, error: 'refused', index,
//     reason} (runIpc; ipcCommandRefusal is the allowlist).
//   {type: 'relay', heartbeat?: {property, everyMs}, onStop?: [commands]} (over a port the
//     extension keeps open, connectNative) -> {type: 'relaying'}, then {type: 'mpv', data}
//     for each line mpv sends; the extension sends {type: 'mpv', command, id?} and gets
//     {type: 'mpv-reply', id, error, data} or {type: 'mpv-refused', id, reason};
//     {type: 'closed', reason} last (relayMpv).
// The messages before it, kept as they were for older extensions:
//   {type: 'ping', mpvPath?}      -> {ok, mpv, path}
//   {type: 'open', url, headers?, mpvPath?, fullscreen?, singleInstance?, contentType?,
//    pageUrl?, title?, start?, subtitles?} -> {ok, error?, reused?, focus?, foreground?}
//   {type: 'status', waitMs?}    -> {ok, running, decoder: {hardware, api, requested,
//                                    format, width, height} | null}
//   {type: 'watch'} (over a port the extension keeps open, connectNative; host 7) ->
//     {type: 'watching'}, then as they happen {type: 'path', path}, {type: 'ended', path},
//     {type: 'request', action: 'next'|'previous'}, and {type: 'closed', reason} last; the
//     extension may send {type: 'notify', title, detail, seconds?} and {type: 'hide'}
//     meanwhile (watchMpv; seconds and hide: host 11).
// Every answer also carries hostVersion (HostVersion below) and, from host 15, capabilities
// (Capabilities below): the thin helper's messages this host understands.
//
// An open that worked on Windows says how raising mpv's window went (focusOutcome):
// focus is "True"/"False" (what SetForegroundWindow answered), "nowindow" (no window
// within WindowWaitSeconds), "error" (the script failed) or "unknown" (no answer from it),
// and for a reused mpv also "gone"/"quit" (it ended before its window was found); a new
// mpv that ends so is a failed open instead. foreground is "True"/"False", whether mpv's
// window really was the foreground window 250 ms after (only when a window was found).
// reused is true when the stream went into the mpv already open (single-instance), whose
// window was raised the same way. Both describe that moment only: a window that goes
// behind the browser later is not seen. Absent off Windows, where nothing is raised.
//
// title is the tab's title for mpv's window, start the position to start at, subtitles
// the player's tracks as SubRip text ([{label, srt}]), and singleInstance loads the
// stream into the mpv this host started before, if it still runs (see launchMpv).
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
//   {"mpvPath": "C:\\Program Files\\mpv\\mpv.exe", "debug": false, "ipcToken": "<32 hex>"}
// A path sent by the extension (options page "mpv path") takes precedence.
// With "debug": true (or FASTSTREAM_MPV_DEBUG=1) every message, the mpv
// command line and the launch result are appended to faststream-mpv-host.log
// next to this script. ipcToken (install.ps1 writes one) makes the name of the
// pipe this host talks to mpv over its own (see ipcPipeFor).

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {execFile, spawn} from 'child_process';
import net from 'net';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// Which host this is, sent with every answer. A PC runs the copy install.ps1 made, which
// a `git pull` leaves alone, so the extension compares this with the version it was
// released with (RequiredHostVersion in chrome/background/MpvBackend.mjs) and says so
// when the installed host is older: on the toolbar button, the player's mpv button and
// "Test mpv connection". Raise it by one with every change to this file or to
// install.ps1 (what it installs is part of the host a PC has), together with
// RequiredHostVersion and the hashes in tests/unit/mpvHostVersion.test.mjs, which fails
// until they agree.
export const HostVersion = 19;

// The messages of the thin helper (host 15) this host understands, sent with every answer
// so that the extension knows what it may ask for without a version table of its own. A
// host before 15 answers them "unknown message", without this list, and the extension then
// uses the legacy messages for it.
export const Capabilities = Object.freeze(['play', 'ipc', 'relay']);

// No mpv path from the environment (FASTSTREAM_MPV_PATH until 2026-10-04): config.json's
// mpvPath and the options page's path name one, and an environment variable reached
// statSync unchecked (CodeQL js/path-injection, local sources).
const DefaultMpvPaths = [
  'C:\\Program Files\\mpv\\mpv.exe',
  'C:\\Program Files (x86)\\mpv\\mpv.exe',
  'mpv',
];

// "debug": true is easily left on after a troubleshooting session, and the log was never
// cut: past this size it is moved to faststream-mpv-host.log.1 (replacing the one before)
// and started anew.
export const MaxLogBytes = 5 * 1024 * 1024;

/**
 * Whether FASTSTREAM_MPV_DEBUG switches the debug log on: 1, true, yes or on, in any case.
 * Any value did, "0" and "false" too, and someone who set it to 0 to be sure got a log of
 * every stream and page they sent to mpv (final review, 2026-10-10).
 * @param {string|undefined} value - The variable's value.
 * @return {boolean}
 */
export function debugFromEnvironment(value) {
  return typeof value === 'string' && /^\s*(1|true|yes|on)\s*$/i.test(value);
}

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
 * @param {string} [file] - The log; faststream-mpv-host.log next to this script by default.
 * @return {void}
 */
export function debugLog(config, label, detail, file = path.join(__dirname, 'faststream-mpv-host.log')) {
  if (!config.debug && !debugFromEnvironment(process.env.FASTSTREAM_MPV_DEBUG)) {
    return;
  }
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      label,
      detail,
    });
    try {
      if (fs.statSync(file).size > MaxLogBytes) {
        fs.renameSync(file, file + '.1');
      }
    } catch (e) {
      // No log yet.
    }
    fs.appendFileSync(file, line + '\n');
  } catch (e) {
    // Logging must never take the host down.
  }
}

/**
 * A message as the debug log records it: the subtitles as their number and size, not
 * their text, which put up to a megabyte of dialogue into the log on every send.
 * @param {*} message - The message read.
 * @return {*} The message to log.
 */
export function loggedMessage(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.subtitles)) {
    return message;
  }
  const chars = message.subtitles.reduce((sum, s) => sum + (s && typeof s.srt === 'string' ? s.srt.length : 0), 0);
  return {...message, subtitles: {count: message.subtitles.length, chars}};
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
        // A relative PATH entry: WMI would look for it in its own working directory.
        return path.resolve(file);
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

/**
 * Whether a file name is an mpv the host may start: mpv, mpv.exe, mpv.com, or a build
 * named after it (mpv-x86_64.exe). The path comes from the options page, and the host
 * starts whatever it names, so a settings change must not turn this into "run any
 * program". On Windows only a .exe or .com: Windows runs a .bat or .cmd through cmd.exe,
 * which reads the arguments again (& | %VAR% inside a header value or a title).
 * @param {string} name - The file name.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @return {boolean}
 */
export function isMpvExecutableName(name, platform = process.platform) {
  return platform === 'win32' ? /^mpv[\w.-]*\.(exe|com)$/i.test(name) : /^mpv[\w.-]*$/i.test(name);
}

/**
 * The GUI build to start in place of mpv's console wrapper: mpv-x86_64.exe for
 * mpv-x86_64.com, mpv.exe for mpv.com, when it is there.
 *
 * The wrapper (mpv.com) starts the .exe beside it as a child of its own and waits for it.
 * So the process WMI reports is the wrapper's, which has no window: the focus helper looked
 * for one on that process, never found it, and mpv's window stayed behind the browser.
 * Started through WMI, the wrapper also opens a console window of its own.
 *
 * @param {string} file - The resolved executable.
 * @return {string} The sibling .exe for a .com that has one; file otherwise.
 */
export function preferGuiBuild(file) {
  if (!/\.com$/i.test(file)) {
    return file;
  }
  const exe = file.slice(0, -'.com'.length) + '.exe';
  try {
    if (fs.statSync(exe).isFile()) {
      fs.accessSync(exe, fs.constants.X_OK);
      return exe;
    }
  } catch (e) {
    // No .exe beside it: the wrapper is all there is.
  }
  return file;
}

/**
 * The mpv to start: the first usable candidate, as an absolute path (WMI resolves a
 * relative one against its own working directory, where it is not). On Windows a console
 * wrapper (mpv.com) gives way to the GUI build beside it (preferGuiBuild).
 * @param {string} [messagePath] - The options page's mpv path.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @return {string|null} The executable, or null when there is none.
 */
export function resolveMpvPath(messagePath, platform = process.platform) {
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
      // "C:\Program Files\mpv" instead of "C:\Program Files\mpv\mpv.exe"; on Linux and
      // macOS the folder holds "mpv", not "mpv.exe").
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        const exe = path.join(candidate, platform === 'win32' ? 'mpv.exe' : 'mpv');
        if (!fs.statSync(exe).isFile()) {
          continue;
        }
        fs.accessSync(exe, fs.constants.X_OK);
        return path.resolve(exe);
      }
      if (!isMpvExecutableName(path.basename(candidate), platform)) {
        continue;
      }
      fs.accessSync(candidate, fs.constants.X_OK);
      return path.resolve(platform === 'win32' ? preferGuiBuild(candidate) : candidate);
    } catch (e) {
      // Try the next candidate.
    }
  }

  return null;
}

/**
 * What a send says when no mpv was found: "mpv executable not found" left the user who had
 * just typed a path in the options wondering what was wrong with it, and the one who had
 * none what to do.
 * @param {*} messagePath - The options page's mpv path.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @return {string}
 */
export function mpvNotFoundError(messagePath, platform = process.platform) {
  if (typeof messagePath === 'string' && messagePath.trim() && messagePath !== 'mpv') {
    const exe = platform === 'win32' ? 'mpv.exe' : 'mpv';
    return `mpv was not found at "${messagePath}" (the mpv path in FastStream's options): ` +
      `give the full path of ${exe}, or of the folder it is in`;
  }
  return 'mpv was not found: install mpv, or give its path in FastStream\'s options (MPV section)';
}

/**
 * An answer as it goes to the extension: with this host's version and capabilities.
 * @param {Object} message - The answer.
 * @return {Object} The answer with hostVersion and capabilities.
 */
export function withHostVersion(message) {
  return {...message, hostVersion: HostVersion, capabilities: [...Capabilities]};
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
  const payload = Buffer.from(JSON.stringify(withHostVersion(message)), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return new Promise((resolve) => {
    process.stdout.write(Buffer.concat([header, payload]), () => resolve());
  });
}

// An open message is a URL, a page URL and three headers: a few KB, plus the subtitles
// the player's mpv button sends along (MpvBackend keeps the whole message under this).
// The length prefix is trusted for the allocation, so a bigger one is refused rather
// than allocated (up to 4 GB).
export const MaxMessageBytes = 1024 * 1024;

// What readMessage resolves to for a message over MaxMessageBytes: the host answers it
// with an error. Exiting without a word made the extension say "is the host installed?".
export const TooLarge = Symbol('message too large');

// Bytes readMessage read past its frame, by stream: the start of the next one, which
// readMessages takes first (glm's review, 2026-10-12: a message the extension posted right
// after 'watch' could come in the same chunk, and was dropped).
const unread = new WeakMap();

/**
 * Reads one native-messaging frame.
 *
 * A frame over MaxMessageBytes is read to its end without being kept, so the browser
 * finishes writing it before the host answers and exits.
 *
 * @param {import('stream').Readable} [input] - The stream to read; stdin by default.
 * @return {Promise<?Object|typeof TooLarge>} The message; TooLarge for one over
 *   MaxMessageBytes; null for none, a malformed one, or one cut short.
 */
export function readMessage(input = process.stdin) {
  return new Promise((resolve) => {
    /** @type {?Buffer} */
    let header = null;
    let headerRead = 0;
    /** @type {?Buffer} */
    let body = null;
    let bodyRead = 0;
    // The bytes of an over-size frame still to be read past.
    let skipping = 0;

    const finish = (result) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      resolve(result);
    };

    const onData = (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        if (skipping > 0) {
          const skipped = Math.min(chunk.length - offset, skipping);
          skipping -= skipped;
          offset += skipped;
          if (skipping === 0) {
            finish(TooLarge);
            return;
          }
        } else if (body === null) {
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
            if (length > MaxMessageBytes) {
              skipping = length;
              continue;
            }
            body = Buffer.alloc(length);
          }
        } else {
          const toCopy = Math.min(chunk.length - offset, body.length - bodyRead);
          chunk.copy(body, bodyRead, offset, offset + toCopy);
          bodyRead += toCopy;
          offset += toCopy;
          if (bodyRead === body.length) {
            if (offset < chunk.length) unread.set(input, chunk.subarray(offset));
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

/**
 * Where mpv's JSON IPC server listens: a named pipe on Windows, a Unix socket elsewhere.
 * Only instances this host starts are given it, which is what keeps "reuse the open
 * window" from ever reaching an mpv the user launched themselves -- that one has no such
 * pipe, so it is invisible here and can never be loaded into or closed by us.
 *
 * Windows has one pipe namespace for the whole machine: another account that created
 * the pipe first would receive every stream URL, page address and header sent to it, and
 * could answer "success" so that nothing plays. So the name carries ipcToken, a random
 * value install.ps1 writes into config.json, in the user's own folder; a config.json
 * without one (a manual install) keeps the old fixed name. Elsewhere the socket goes in
 * the user's own runtime folder ($XDG_RUNTIME_DIR; the temp folder, which macOS keeps per
 * user, without one). The Windows name used to be passed there as well, where it is a
 * relative path: mpv made a file of that name in its working directory, and reuse only
 * worked when mpv and the host happened to share one.
 *
 * @param {Object} config - The parsed config.json.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @param {Object<string, string|undefined>} [env] - The environment.
 * @return {string} The pipe or socket.
 */
export function ipcPipeFor(config, platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const token = config && typeof config.ipcToken === 'string' && /^[0-9a-f]{32}$/.test(config.ipcToken) ?
      '-' + config.ipcToken : '';
    return '\\\\.\\pipe\\faststream-mpv' + token;
  }
  const user = typeof process.getuid === 'function' ? process.getuid() : 0;
  // The token here too when config.json has one (glm's review, 2026-10-12): without
  // $XDG_RUNTIME_DIR the socket goes in the shared temp folder, where another account
  // could take the name first, as on Windows.
  const token = config && typeof config.ipcToken === 'string' && /^[0-9a-f]{32}$/.test(config.ipcToken) ?
    '-' + config.ipcToken : '';
  return path.posix.join(env.XDG_RUNTIME_DIR || os.tmpdir(), `faststream-mpv-${user}${token}.sock`);
}

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

// The wait for the window of an mpv that is already open (focusPid). It answered on its
// pipe and loaded the stream, so its window came long before (--force-window=immediate);
// one not there within seconds is hidden or not responding, and stays so. It waited
// WindowWaitSeconds, as a start does, and the answer came 30 s late: the extension
// pauses the page only on the answer, so the page played on beside mpv, and the same
// stream sent again meanwhile went nowhere (MpvBackend.openStream waits for the send
// under way). Seen on a PC whose open mpv window was not found (2026-10-21).
export const ReusedWindowWaitSeconds = 5;

/**
 * Sends commands to the mpv instance listening on our pipe.
 *
 * @param {Array<Object>} commands - mpv JSON IPC commands, in order.
 * @param {number} [timeoutMs] - How long to wait for the pipe.
 * @param {number} [replyTimeoutMs] - How long a connected mpv gets to answer: it answers
 *   IPC between other work, and opening a slow stream can hold it up for seconds.
 * @param {string} [pipe] - The pipe; ours by default (tests use their own).
 * @return {Promise<{ok: boolean, replies?: Array<Object>, error?: string, busy?: boolean}>}
 *   ok:false without busy means no instance of ours is running; busy:true means one is,
 *   and did not answer in time (starting a second one on the same pipe would leave that
 *   one without IPC).
 */
export function mpvIpcRequest(commands, timeoutMs = 1500, replyTimeoutMs = 6000, pipe = ipcPipeFor(readConfig())) {
  return new Promise((resolve) => {
    let settled = false;
    const replies = [];
    let buffer = '';

    const socket = net.connect(pipe);
    // Decoded as a stream: a character mpv sends in two chunks stays one character.
    socket.setEncoding('utf8');

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

    let connected = false;
    const giveUp = () => {
      if (replies.length) {
        finish({ok: true, replies});
      } else if (connected) {
        finish({ok: false, busy: true, error: 'mpv did not answer'});
      } else {
        finish({ok: false, error: 'mpv ipc timeout'});
      }
    };
    let timer = setTimeout(giveUp, timeoutMs);

    // Any connect error means there is no live instance of ours: a stale pipe
    // after mpv was closed behaves the same way.
    socket.on('error', () => finish({ok: false, error: 'no mpv ipc'}));
    // An mpv that quits as the commands arrive (its window closed) closes the pipe before it
    // answered them all: it is gone, not busy, even when it answered a first one. The reply
    // timeout ran out 6 s later with "mpv is busy", and with one answer in, loadIntoExisting
    // said "busy" at once, where a fresh mpv was what the send needed. (Once all answers are
    // in, finish has closed the pipe itself, and this is too late to count.)
    socket.on('close', () => finish({ok: false, error: 'mpv closed the ipc'}));

    socket.on('connect', () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(giveUp, replyTimeoutMs);
      commands.forEach((command, index) => {
        socket.write(JSON.stringify(
            Object.assign({request_id: index + 1}, command)) + String.fromCharCode(10));
      });
    });

    socket.on('data', (chunk) => {
      buffer += chunk;
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

// How often watchMpv tells mpv it still follows the window (host 10).
export const HeartbeatMs = 30000;

// The longest a notice of the extension stays in mpv (host 11), and how long mpv's own text
// stays when this mpv has no notify.lua and the notice names no time.
export const MaxNoticeSeconds = 60;
const DefaultTextSeconds = 4;
// How close to its end mpv may stop, paused or after a seek, and it is the end (watchMpv).
const EndSlackSeconds = 0.5;

/**
 * How long a notice asks to stay: seconds between 0 (exclusive) and MaxNoticeSeconds, to a
 * tenth; undefined for anything else (notify.lua's own default then, 2 s).
 * @param {*} seconds - What the extension sent.
 * @return {number|undefined}
 */
export function noticeSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(Math.min(seconds, MaxNoticeSeconds) * 10) / 10 || undefined;
}

// The script messages an mpv key, button or menu sends for the next or the previous episode
// (input.conf: "n script-message faststream-next") and, host 9, for autoplay on or off (the
// mpv setup's autoplay button); mpv gives them to every IPC client.
export const EpisodeMessages = {
  'faststream-next': 'next',
  'faststream-previous': 'previous',
  'faststream-autoplay': 'autoplay',
};

/**
 * Follows the mpv on our pipe for the extension, over a port it keeps open (connectNative):
 * the end of a file, and the keys that ask for the next or the previous episode, each sent
 * to the extension as it happens. For MPV autoplay (host 7, 2026-10-11): the extension goes
 * on to the next episode in the page and hands its stream to this same mpv.
 *
 * An end is eof-reached going from false to true for the file mpv has (keep-open stops at
 * the end), or an end-file "eof" (an mpv without keep-open). The first eof-reached is mpv's
 * state when the watch began, a file that ended before: no end. A file loaded into the
 * window (loadfile replace) comes as a new path, eof-reached unavailable, then false.
 *
 * Host 14 (2026-10-13): an end is also mpv in the last EndSlackSeconds of its file when it
 * pauses there or a seek lands there (playback-restart). A skip past the end of an HLS
 * stream with discontinuities stopped mpv at the end, paused, with eof-reached never set
 * (measured with the pinned mpv): MPV autoplay never started, until the user went back and
 * played the last seconds again (his report). The pause mpv was in when the watch began is
 * its state then, as eof-reached's first value is.
 *
 * Host 9: mpv's episode buttons show only while FastStream follows the window
 * (user-data/faststream/connected, cleared when the extension lets go), and its autoplay
 * button shows the extension's setting (user-data/faststream/autoplay, from state()).
 *
 * Host 10 (2026-10-12): a host killed hard (Task Manager, a Firefox crash) clears nothing,
 * and mpv's buttons stayed, sending to no one. So it also writes the time to
 * user-data/faststream/heartbeat when it connects and every HeartbeatMs after: the mpv
 * setup hides the buttons once that value has stood still for 90 s (three beats missed). A
 * new value every time, so a host started after a killed one counts as alive at once.
 *
 * Host 11 (2026-10-12): a notice may say how long it stays (notify.lua's seconds). Without
 * one every notice went after notify.lua's 2 s: "next episode in 5 s" was gone 3 s before
 * the episode came, and a sentence to read ("the page brought no stream within a minute;
 * open it in the browser to see why") was gone before it was read. And hide() takes the
 * notice down early (a countdown stopped with nothing else to say).
 * @param {(message: Object) => *} send - Sends a message to the extension.
 * @param {{pipe?: string, connect?: (pipe: string) => import('net').Socket,
 *   heartbeatMs?: number}} [io] - Tests.
 * @return {{notify: (title: string, detail?: string, seconds?: number) => void,
 *   hide: () => void, state: (state: Object) => void,
 *   stop: () => void, done: Promise<string>}} done resolves with why it ended.
 */
export function watchMpv(send, io = {}) {
  const socket = (io.connect || net.connect)(io.pipe || ipcPipeFor(readConfig()));
  // Decoded as a stream: a path with a character split across two chunks still matches.
  socket.setEncoding('utf8');
  let buffer = '';
  /** @type {boolean|undefined} */
  let eof;
  /** @type {?string} */
  let path = null;
  /** @type {?string} */
  let endedPath = null;
  let finished = false;
  let requests = 0;
  // The questions for the time left (endCheck), by request id; whether the first pause
  // value (mpv's state when the watch began) came.
  const endChecks = new Set();
  let pauseSeen = false;
  // A notice sent to notify.lua, by request id: one refused (no notify.lua in this mpv's
  // config) is shown with mpv's own text instead.
  /** @type {Map<number, {text: string, seconds: (number|undefined)}>} */
  const notices = new Map();
  /** @type {?ReturnType<typeof setInterval>} */
  let heartbeat = null;
  let lastBeat = 0;
  /** @type {(reason: string) => void} */
  let resolveDone = () => {};
  /** @type {Promise<string>} */
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  /**
   * @param {Array<*>} command
   * @param {number} [requestId]
   */
  const write = (command, requestId) => {
    if (finished) return;
    socket.write(JSON.stringify(requestId === undefined ? {command} : {command, request_id: requestId}) +
      String.fromCharCode(10));
  };
  const beat = () => {
    // Strictly rising, even with two beats in one millisecond (the tests).
    lastBeat = Math.max(Date.now(), lastBeat + 1);
    write(['set_property', 'user-data/faststream/heartbeat', lastBeat]);
  };
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (reason === 'stopped' && socket.writable) {
        // The extension let go, mpv runs on: its episode buttons go (they would send to no
        // one). end() sends the line before it closes; destroy() could drop it.
        socket.end(JSON.stringify({command: ['set_property', 'user-data/faststream/connected', false]}) +
          String.fromCharCode(10));
      } else {
        socket.destroy();
      }
    } catch (e) {
      // Already gone.
    }
    send({type: 'closed', reason});
    resolveDone(reason);
  };
  const ended = () => {
    if (path !== null && endedPath !== path) {
      endedPath = path;
      send({type: 'ended', path});
    }
  };
  // Asks mpv how much of its file is left: the answer may be an end (Host 14 above).
  const endCheck = () => {
    if (path === null || endedPath === path) return;
    requests++;
    const id = 1000 + requests;
    endChecks.add(id);
    write(['get_property', 'time-remaining'], id);
  };
  socket.on('error', () => finish('no mpv'));
  socket.on('close', () => finish('mpv closed'));
  socket.on('connect', () => {
    write(['observe_property', 1, 'path']);
    write(['observe_property', 2, 'eof-reached']);
    write(['observe_property', 3, 'pause']);
    write(['set_property', 'user-data/faststream/connected', true]);
    beat();
    heartbeat = setInterval(beat, io.heartbeatMs || HeartbeatMs);
    // The beat alone keeps no host running: it ends when the extension or mpv does.
    heartbeat.unref?.();
    send({type: 'watching'});
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(String.fromCharCode(10));
    buffer = lines.pop() || '';
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (!event || typeof event !== 'object') continue;
      if (event.event === 'property-change' && event.name === 'path') {
        path = typeof event.data === 'string' ? event.data : null;
        if (path !== null) {
          send({type: 'path', path});
        } else {
          // Between two files (a loadfile replace): the next may be the same one again, and
          // its end is another end (seen with the pinned mpv).
          endedPath = null;
        }
      } else if (event.event === 'property-change' && event.name === 'eof-reached') {
        if (eof === false && event.data === true) ended();
        eof = typeof event.data === 'boolean' ? event.data : undefined;
      } else if (event.event === 'end-file' && event.reason === 'eof') {
        ended();
      } else if (event.event === 'property-change' && event.name === 'pause') {
        if (pauseSeen && event.data === true) endCheck();
        pauseSeen = true;
      } else if (event.event === 'playback-restart') {
        endCheck();
      } else if (endChecks.has(event.request_id)) {
        endChecks.delete(event.request_id);
        if (event.error === 'success' && typeof event.data === 'number' && event.data <= EndSlackSeconds) ended();
      } else if (event.event === 'client-message' && Array.isArray(event.args)) {
        const action = EpisodeMessages[event.args[0]];
        if (action) send({type: 'request', action});
      } else if (notices.has(event.request_id)) {
        const notice = notices.get(event.request_id);
        notices.delete(event.request_id);
        if (event.error && event.error !== 'success' && notice) {
          write(['show-text', notice.text, (notice.seconds || DefaultTextSeconds) * 1000]);
        }
      }
    }
  });
  return {
    notify(title, detail = '', seconds) {
      // Plain text only, as on the ipc and relay paths: without notify.lua the notice is
      // mpv's show-text, which expands ${...} - a local path on the screen.
      if (!isPlainText(String(title), MaxNoticeText, true) || !isPlainText(String(detail), MaxNoticeText, true)) {
        return;
      }
      requests++;
      const id = 1000 + requests;
      const time = noticeSeconds(seconds);
      notices.set(id, {text: detail ? title + ': ' + detail : String(title), seconds: time});
      const command = ['script-message-to', 'notify', 'show', 'faststream', String(title), String(detail)];
      if (time !== undefined) command.push(String(time));
      write(command, id);
    },
    hide() {
      // No request id: an mpv without notify.lua refuses it, and there is nothing to take down.
      write(['script-message-to', 'notify', 'hide', 'faststream']);
    },
    state(state) {
      if (state && typeof state.autoplay === 'boolean') {
        write(['set_property', 'user-data/faststream/autoplay', state.autoplay]);
      }
    },
    stop() {
      finish('stopped');
    },
    done,
  };
}

/**
 * Reads native-messaging frames as they come, for a port the extension keeps open
 * (watchMpv). A frame over MaxMessageBytes ends the reading: the extension never sends one.
 * @param {import('stream').Readable} input - The stream; stdin.
 * @param {(message: Object) => void} onMessage - Gets each message.
 * @param {() => void} onEnd - Called once, when the stream ends.
 */
export function readMessages(input, onMessage, onEnd) {
  let pending = Buffer.alloc(0);
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    input.removeListener('data', onData);
    onEnd();
  };
  const onData = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const length = pending.readUInt32LE(0);
      if (length > MaxMessageBytes) {
        end();
        return;
      }
      if (pending.length < 4 + length) return;
      const body = pending.subarray(4, 4 + length);
      pending = pending.subarray(4 + length);
      let message = null;
      try {
        message = JSON.parse(body.toString('utf8'));
      } catch (e) {
        // A frame that is not JSON: skipped.
      }
      if (message && typeof message === 'object') onMessage(message);
    }
  };
  input.on('data', onData);
  input.on('end', end);
  input.on('error', end);
  // What readMessage read past its frame: the next frame's start (or more frames).
  const rest = unread.get(input);
  if (rest) {
    unread.delete(input);
    onData(rest);
  }
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

// The qualities the page's player offers the video in, at most, and the longest file
// address taken (page-qualities.js in the extension, MpvBackend.relayQualities).
const MaxQualities = 12;
const MaxQualityUrlChars = 2048;

/**
 * The qualities the page's player offers the video in, as one fragment tag value
 * (fs-quality=) for mpv's faststream-quality.lua, which switches between them: a JSON
 * array of {label, height, url}, percent-encoded. Checked here again, since anything that
 * talks to the host gets this far: http(s) files only (mpv opens local files and UNC paths
 * too, isStreamUrl) of at most MaxQualityUrlChars, each as the URL parser writes it without
 * a fragment of its own (the script finds the playing one by mpv's path up to its first '#'),
 * a label of at most 40 characters (whole characters) without control characters, a whole
 * height or 0, and at least two of them.
 * @param {*} qualities - The open message's qualities.
 * @return {string|undefined} The tag's value, or undefined without a usable list.
 */
export function qualityFragmentFor(qualities) {
  if (!Array.isArray(qualities)) {
    return undefined;
  }
  const list = [];
  for (const entry of qualities.slice(0, MaxQualities)) {
    if (!entry || !isStreamUrl(entry.url) || entry.url.length > MaxQualityUrlChars) {
      continue;
    }
    const label = typeof entry.label === 'string' ?
      cutText(entry.label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), 40) : '';
    const height = Number.isInteger(entry.height) && entry.height > 0 && entry.height <= 10000 ? entry.height : 0;
    const parsed = new URL(entry.url);
    parsed.hash = '';
    list.push({label, height, url: parsed.href});
  }
  return list.length >= 2 ? encodeURIComponent(JSON.stringify(list)) : undefined;
}

/**
 * The URL to hand mpv for an open message: the stream URL plus its
 * fs-content=, fs-id=, fs-page= and fs-quality= fragment tags.
 *
 * The stream URL as the URL parser writes it, the form a browser requests: the parser
 * drops tabs and newlines that isStreamUrl's check never saw, and percent-encodes spaces
 * and other characters a request line cannot carry. (mpv 0.41 cleans those up itself,
 * measured; the host does not count on every mpv doing so.)
 *
 * @param {Object} message - The open message from the extension; its url passed
 *   isStreamUrl.
 * @return {string} The URL for mpv.
 */
export function mpvTargetUrl(message) {
  const target = withContentTypeFragment(withoutFsTags(new URL(message.url).href), message.contentType);
  const resumeId = resumeIdFor(message.pageUrl);
  const withId = resumeId ? withFragmentTag(target, `fs-id=${resumeId}`) : target;
  // The page URL itself, percent-encoded, for source-info.lua's
  // "Site page" menu entry (copy it, open it in the browser). Same rule as
  // fs-id: http(s) pages only, still never sent to the CDN.
  const pageFragment = pageFragmentFor(message.pageUrl);
  const withPage = pageFragment ? withFragmentTag(withId, `fs-page=${pageFragment}`) : withId;
  // The page's other qualities of this video, for mpv's quality menu (faststream-quality.lua):
  // last, as it is the longest. A switch there loads another of them with the same tags.
  const qualities = qualityFragmentFor(message.qualities);
  return qualities ? withFragmentTag(withPage, `fs-quality=${qualities}`) : withPage;
}

// What else a sender may hand over with a stream (the player's mpv button): where to
// start, and the subtitles it shows, as SubRip text. Checked here again, since anything
// that talks to the host gets this far.
const MaxSubtitles = 8;
// No more than a whole message can carry.
const MaxSubtitleChars = MaxMessageBytes;
// The folders the subtitles are written into, one per send, in the user's temp folder.
export const SubtitleDirPrefix = 'faststream-mpv-subs-';
// mpv reads a subtitle file when it loads the stream; older folders are removed.
const SubtitleDirMaxAgeMs = 24 * 60 * 60 * 1000;

/**
 * The position to start the stream at, when the message names a usable one.
 * @param {{start?: *}} message - The open message.
 * @return {number|undefined} Seconds (millisecond precision), or undefined.
 */
export function startOf(message) {
  const t = message.start;
  return typeof t === 'number' && Number.isFinite(t) && t >= 1 && t < 1e7 ?
    Math.floor(t * 1000) / 1000 : undefined;
}

/**
 * The subtitles the message carries that the host takes: SubRip text, at most
 * MaxSubtitles, each at most MaxSubtitleChars long.
 * @param {{subtitles?: *}} message - The open message.
 * @return {Array<{srt: string, label: string}>} The subtitles.
 */
export function subtitlesOf(message) {
  if (!Array.isArray(message.subtitles)) {
    return [];
  }
  return message.subtitles
      .filter((s) => s && typeof s.srt === 'string' && s.srt.trim().length > 0 && s.srt.length <= MaxSubtitleChars)
      .slice(0, MaxSubtitles)
      .map((s) => ({srt: s.srt, label: typeof s.label === 'string' ? s.label : ''}));
}

/**
 * Writes subtitles into a fresh folder of their own (mkdtemp: a random name in the
 * user's temp folder) for mpv to load, after removing such folders older than a day.
 * The file name is what mpv's track list shows.
 * @param {Array<{srt: string, label: string}>} subtitles - From subtitlesOf.
 * @param {string} [base] - The folder to write under; the temp folder by default.
 * @return {Array<string>} The files, in order.
 */
export function writeSubtitleFiles(subtitles, base = os.tmpdir()) {
  if (subtitles.length === 0) {
    return [];
  }
  try {
    for (const entry of fs.readdirSync(base, {withFileTypes: true})) {
      if (entry.isDirectory() && entry.name.startsWith(SubtitleDirPrefix)) {
        const dir = path.join(base, entry.name);
        if (Date.now() - fs.statSync(dir).mtimeMs > SubtitleDirMaxAgeMs) {
          fs.rmSync(dir, {recursive: true, force: true});
        }
      }
    }
  } catch (e) {
    // Cleaning up is a courtesy; writing the new ones is what matters.
  }
  const dir = fs.mkdtempSync(path.join(base, SubtitleDirPrefix));
  return subtitles.map((s, i) => {
    const label = s.label.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    const file = path.join(dir, `${i + 1}${label ? ' ' + label : ''}.srt`);
    fs.writeFileSync(file, s.srt, 'utf8');
    return file;
  });
}

/**
 * Escapes one item of an mpv string list option: ',' separates the items, and a '\'
 * right before a ',' makes it part of the item. mpv removes no other backslash: escaped
 * as well, a '\' reached the server doubled (mpv 0.41, measured 2026-10-03). Written as
 * split/join: CodeQL's js/incomplete-sanitization reads a replace() that inserts '\' as
 * backslash escaping that forgot the backslash, which mpv's list syntax is not.
 * @param {string} item - The item.
 * @return {string} The escaped item.
 */
function listItem(item) {
  return item.split(',').join('\\,');
}

/**
 * mpv's per-file options for one stream: its headers and title, which come with the file
 * and go with it. Set for the whole player (set_property, or --http-header-fields on the
 * command line), they stayed for every later file in that window, so the next file got
 * this site's Referer and title; and two sends milliseconds apart could interleave as set
 * A, set B, load A, load B, A then playing with B's headers. A per-file option rides on
 * the one loadfile command (or the --{ ... --} group of a fresh start), so neither can
 * happen, and no lock between host processes is needed. Measured on mpv 0.41
 * (2026-10-02, a local server logging each request's headers): the file got them, commas
 * inside a value included, and the next file loaded without them; so did start and
 * sub-files.
 *
 * A header field that ends in a backslash is left out: in the list, mpv reads that
 * backslash and the separator after it as an escaped comma and joins the next field to it
 * (measured: the Referer swallowed the User-Agent, and mpv sent its own). No real
 * Referer, Origin or User-Agent ends in one.
 *
 * sub-files is a PATH list, not a string list: its items are separated by the system's
 * path delimiter (';' on Windows) and a backslash is part of the path (escaped as a string
 * list, mpv looked for "C:\\Users\\...", measured). A file whose path holds the delimiter
 * is left out.
 *
 * @param {Array<string>} headerFields - "Name: value" strings for mpv.
 * @param {string} title - Media title to display.
 * @param {{start?: (number|string), subFiles?: Array<string>}} [extras] - Where to start
 *   (seconds; play's start comes as checked text), and subtitle files to load with the stream.
 * @param {string} [delimiter] - The path list separator; the system's by default.
 * @return {Object<string, string>} loadfile's options.
 */
export function perFileOptions(headerFields, title, extras = {}, delimiter = path.delimiter) {
  /** @type {Object<string, string>} */
  const options = {
    'http-header-fields': headerFields.filter((field) => !field.endsWith('\\')).map(listItem).join(','),
    'force-media-title': title,
  };
  if (extras.start !== undefined) {
    options.start = String(extras.start);
  }
  const subFiles = (extras.subFiles || []).filter((file) => !file.includes(delimiter));
  if (subFiles.length > 0) {
    options['sub-files'] = subFiles.join(delimiter);
  }
  return options;
}

/**
 * Loads a URL into the mpv instance already running on our pipe.
 *
 * @param {Object} message - The open message from the extension.
 * @param {Array<string>} headerFields - "Name: value" strings for mpv.
 * @param {string} title - Media title to display.
 * @param {typeof mpvIpcRequest} [ipcRequest] - Injectable for tests; defaults
 *   to the real named-pipe transport.
 * @param {{start?: number, subFiles?: Array<string>}} [extras] - perFileOptions'.
 * @return {Promise<{ok: boolean, pid?: number, busy?: boolean, refused?: boolean, error?: string}>}
 *   ok:false when no instance of ours answered, in which case the caller should start
 *   one - unless busy: one is running and did not answer in time; or refused: one is
 *   running and refused the command (error is mpv's reason).
 */
export async function loadIntoExisting(message, headerFields, title, ipcRequest = mpvIpcRequest, extras = {}) {
  return loadInto(mpvTargetUrl(message), perFileOptions(headerFields, title, extras),
      Boolean(message.fullscreen), ipcRequest);
}

/**
 * Loads a URL, with its per-file options, into the mpv on a pipe: loadIntoExisting's work,
 * and play's (host 15), which gets the URL whole from the extension.
 * @param {string} target - The URL for mpv.
 * @param {Object<string, string>} options - loadfile's options (perFileOptions).
 * @param {boolean} fullscreen - Whether to make the window fullscreen first.
 * @param {(commands: Array<Object>) => ReturnType<typeof mpvIpcRequest>} ipcRequest - The
 *   transport, bound to its pipe.
 * @return {Promise<{ok: boolean, pid?: number, busy?: boolean, refused?: boolean, error?: string}>}
 *   As loadIntoExisting.
 */
export async function loadInto(target, options, fullscreen, ipcRequest) {
  /** @type {Array<{command: *}>} */
  const commands = [];
  if (fullscreen) {
    commands.push({command: ['set_property', 'fullscreen', true]});
  }
  // The file with its own headers and title: one command (perFileOptions). Named
  // arguments, since loadfile's options come after its index from mpv 0.38 on. No index:
  // -1 is its default there (player/command.c), and mpv before 0.38 has none and refused
  // the whole command, so the open window of a distro's mpv (Ubuntu 24.04: 0.37) took no
  // second video.
  commands.push({command: {
    name: 'loadfile',
    url: target,
    flags: 'replace',
    options,
  }});
  commands.push({command: ['get_property', 'pid']});

  const result = await ipcRequest(commands);
  if (!result.ok) {
    return result.busy ? {ok: false, busy: true} : {ok: false};
  }

  // The loadfile reply is what decides success. mpvIpcRequest can resolve
  // ok:true on its own timeout as soon as *any* reply has come back (so a
  // live-but-slow pipe still counts as "ours"), which means the loadfile
  // reply specifically might not be in yet. Treat that as unconfirmed, not
  // successful -- otherwise this returns {ok: true} without ever knowing
  // whether the video actually loaded, and the caller skips starting a
  // fresh instance that would have played it. Nor is it "no instance": ours
  // answered something, so it runs, and a second mpv on the same pipe would
  // get no IPC (busy).
  const replies = result.replies || [];
  const loadReply = replies.find((r) => r.request_id === commands.length - 1);
  if (!loadReply) {
    return {ok: false, busy: true};
  }
  if (loadReply.error && loadReply.error !== 'success') {
    // Ours runs (it answered), so a fresh start would be a second mpv on a pipe the first
    // one holds: it plays without IPC (measured: "Couldn't create first pipe instance"),
    // and every later send goes to the first one again. mpv 0.41 answers success even to
    // an unknown option or a bad value (it checks them when it opens the file), so an
    // error is about the command itself, as from an mpv that does not know its form.
    return {ok: false, refused: true, error: String(loadReply.error)};
  }

  const pidReply = replies.find((r) => r.request_id === commands.length);
  return {
    ok: true,
    pid: pidReply && typeof pidReply.data === 'number' ? pidReply.data : undefined,
  };
}

// How long a `status` message may wait for mpv to start decoding: a slow stream takes
// seconds to open, and until then mpv has no decoder to name.
export const MaxStatusWaitMs = 30000;
const StatusPollMs = 1000;

// What mpv is asked about its video decoder, in this order (decoderFromReplies).
const DecoderProperties = ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'];

/**
 * Reads mpv's answers about its video decoder.
 *
 * `hwdec-current` is the hardware decoding API in use ("d3d11va", "vulkan", "nvdec",
 * or "-copy" forms of them), "no" when mpv decodes in software, and unavailable while no
 * video decoder is loaded (the stream is still opening, or it has no video).
 *
 * @param {Array<Object>} replies - mpvIpcRequest's replies to DecoderProperties.
 * @return {?{hardware: boolean, api: string, requested: ?string, format: ?string,
 *   width: ?number, height: ?number}} null while no decoder is loaded.
 */
export function decoderFromReplies(replies) {
  /**
   * @param {number} index - The property's place in DecoderProperties.
   * @return {*} Its value, or undefined for an error or no reply.
   */
  const value = (index) => {
    const reply = (replies || []).find((r) => r && r.request_id === index + 1);
    return reply && (reply.error === undefined || reply.error === 'success') ? reply.data : undefined;
  };
  const api = value(0);
  if (typeof api !== 'string' || !api) {
    return null;
  }
  const text = (v) => (typeof v === 'string' && v ? v : null);
  const size = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  return {
    hardware: api !== 'no',
    api,
    requested: text(value(1)),
    format: text(value(2)),
    width: size(value(3)),
    height: size(value(4)),
  };
}

/**
 * Asks the mpv this host started (the one on our pipe) which video decoder it uses,
 * waiting up to waitMs for one to load. Only an instance started for single-instance use
 * has the pipe, so without it the answer is "not running" even when an mpv is open.
 *
 * @param {number} waitMs - How long to keep asking while mpv has no decoder yet.
 * @param {typeof mpvIpcRequest} [ipcRequest] - Injectable for tests.
 * @param {(ms: number) => Promise<void>} [sleep] - Injectable for tests.
 * @param {() => number} [now] - Injectable for tests.
 * @return {Promise<{running: boolean, decoder: ?Object}>}
 */
export async function queryDecoder(waitMs, ipcRequest = mpvIpcRequest,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now) {
  const wait = Math.min(Math.max(Number(waitMs) || 0, 0), MaxStatusWaitMs);
  const commands = DecoderProperties.map((name) => ({command: ['get_property', name]}));
  const start = now();
  for (;;) {
    const result = await ipcRequest(commands, 1500, 3000);
    // No pipe: no mpv of ours. A busy one runs, and may answer next time.
    if (!result.ok && !result.busy) {
      return {running: false, decoder: null};
    }
    const decoder = result.ok ? decoderFromReplies(result.replies || []) : null;
    if (decoder || now() - start + StatusPollMs > wait) {
      return {running: true, decoder};
    }
    await sleep(StatusPollMs);
  }
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
export function focusApiLines() {
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
    '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int p);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '}',
    '"@',
  ];
}

/**
 * PowerShell that shows a window, restoring a minimised one: SW_SHOW (5) leaves a
 * minimised window in the taskbar; SW_RESTORE (9) brings it back.
 *
 * ShowWindowAsync, not ShowWindow. runPowerShell starts PowerShell with windowsHide, which
 * puts SW_HIDE in its STARTUPINFO, and Windows applies that to the first ShowWindow call a
 * process makes, whatever window and value it names: the focus script's
 * ShowWindow(mpv, SW_SHOW) hid mpv's window. When SetForegroundWindow then worked at once,
 * no second call showed it again, and every later stream sent to that mpv found no window
 * (FOCUS=nowindow) until mpv quit (measured 2026-10-21: hidden after one call, shown after
 * a second; ShowWindowAsync, which mpv's own thread carries out, left it visible).
 * @param {string} hwndExpr - PowerShell expression holding the window handle.
 * @return {Array<string>} Script lines.
 */
export function showWindowLines(hwndExpr) {
  return [
    `if ([FSFg]::IsIconic(${hwndExpr})) { $null = [FSFg]::ShowWindowAsync(${hwndExpr}, 9) } ` +
      `else { $null = [FSFg]::ShowWindowAsync(${hwndExpr}, 5) }`,
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
 * @param {number} waitSeconds - How long to wait for the window: WindowWaitSeconds for an
 *   mpv just started, ReusedWindowWaitSeconds for one already open.
 * @return {Array<string>} Script lines.
 */
function focusWindowLines(pidExpr, waitSeconds) {
  return [
    '  try {',
    // Cold starts are slow in this mpv setup: gpu-next on a Vulkan context,
    // uosc, thumbfast and the shader pipeline all initialise before the VO
    // window exists, and network streams add demuxer-open time on top. A 3s
    // deadline regularly expired on cold starts, and so did 10s once a slow
    // stream held the window back past it (the host logged focus=nowindow and
    // mpv then appeared behind the browser) -- see WindowWaitSeconds.
    '    $deadline = (Get-Date).AddSeconds(' + Number(waitSeconds) + ')',
    '    $h = [IntPtr]::Zero',
    '    $seen = $false',
    '    $quit = $false',
    '    $misses = 0',
    '    while ((Get-Date) -lt $deadline) {',
    '      $p = Get-Process -Id ' + pidExpr + ' -ErrorAction SilentlyContinue',
    '      if ($p) { $seen = $true } else { $misses++ }',
    '      if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) ' +
      '{ $h = $p.MainWindowHandle; break }',
    // mpv gone again after we saw it, before it had a window: it quit at once (an option
    // it refuses, a broken install; with --force-window=immediate the window comes before
    // the stream is opened). FOCUS=quit, which launchViaWmi reports as the failure it is.
    // The first look almost always finds mpv still starting, so "never seen" (FOCUS=gone)
    // alone missed nearly every such quit, and the hand-off was reported as working.
    '      if ($seen -and -not $p) { $quit = $true; break }',
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
    ...showWindowLines('$h').map((line) => '        ' + line),
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
    '    elseif ($quit) { Write-Output "FOCUS=quit" }',
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
 * @return {Promise<string>} Captured stdout; after a failure (a timeout, PowerShell or WMI
 *   refusing), an ERROR= line with the reason: the launch said "unexpected WMI output: "
 *   with nothing after it, and the user had nothing to go on.
 */
export function runPowerShell(lines, timeoutMs, env = {}) {
  const encoded = Buffer.from(lines.join(String.fromCharCode(10)), 'utf16le')
      .toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        {timeout: timeoutMs, windowsHide: true, env: {...process.env, ...env}},
        (error, stdout, stderr) => {
          const out = String(stdout || '');
          const why = error ? String(stderr || '').trim() || error.message || String(error) : '';
          resolve(why ? out + String.fromCharCode(10) + 'ERROR=' + why.replace(/\s+/g, ' ').slice(0, 300) : out);
        });
  });
}

// The environment variable launchViaWmi hands mpv's command line over in.
export const CommandLineEnv = 'FASTSTREAM_MPV_COMMAND_LINE';

// CreateProcess refuses a longer command line.
const MaxCommandLineChars = 32767;

/**
 * mpv's command line as launchViaWmi hands it to CreateProcess.
 * @param {string} mpvPath
 * @param {Array<string>} args
 * @return {string}
 */
function windowsCommandLine(mpvPath, args) {
  return [mpvPath, ...args].map(quoteWindowsArg).join(' ');
}

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
    ...focusWindowLines('$r.ProcessId', WindowWaitSeconds),
    '}',
  ];
}

/**
 * The PowerShell that brings an already-running mpv window to the front (focusPid).
 * @param {number} pid - The mpv process id.
 * @return {Array<string>} Script lines.
 */
export function focusPidLines(pid) {
  return [
    ...focusApiLines(),
    '$target = ' + String(Number(pid)),
    ...focusWindowLines('$target', ReusedWindowWaitSeconds),
  ];
}

/**
 * Brings an already-running mpv window to the front.
 * @param {number} pid - The mpv process id.
 * @return {Promise<string>} The FOCUS= line PowerShell reported.
 */
async function focusPid(pid) {
  // Headroom for PowerShell's start, the Add-Type compile and the retries, as a start's.
  const out = await runPowerShell(focusPidLines(pid), (ReusedWindowWaitSeconds + 15) * 1000);
  const match = /FOCUS=(\S+)(?:\s+FGOK=(\S+))?/.exec(out);
  return match ? match[0] : 'FOCUS=unknown';
}

/**
 * What a focus script (focusWindowLines) reported, as the open reply carries it.
 * @param {string} text - The script's output, or focusPid's FOCUS= line.
 * @return {{focus?: string, foreground?: string}} focus is the FOCUS= value ("True",
 *   "False", "nowindow", "quit", "gone", "error", "unknown"), foreground the FGOK= value
 *   ("True", "False"); each only when the text has it.
 */
export function focusOutcome(text) {
  /** @type {{focus?: string, foreground?: string}} */
  const outcome = {};
  const focus = /FOCUS=(\S+)/.exec(text);
  const foreground = /FGOK=(\S+)/.exec(text);
  if (focus) {
    outcome.focus = focus[1];
  }
  if (foreground) {
    outcome.foreground = foreground[1];
  }
  return outcome;
}

// Win32_Process.Create's return codes (its documentation), as the user can act on them.
const WmiCreateErrors = new Map([
  ['2', 'access denied'],
  ['3', 'not enough rights'],
  ['8', 'unknown failure'],
  ['9', 'mpv was not found at its path'],
  ['21', 'invalid parameter'],
]);

/**
 * What the WMI launch script's output (wmiLaunchLines) means.
 *
 * An mpv that is gone before it had a window quit at once: FOCUS=gone when the first look
 * already missed it, FOCUS=quit when it was seen and then went. Both are a failed launch.
 *
 * @param {string} text - The script's output.
 * @return {{ok: boolean, pid?: number, error?: string, focus?: string, foreground?: string,
 *   tries?: number}} focus and foreground as focusOutcome reads them.
 */
export function wmiLaunchResult(text) {
  const match = /RC=(\d+)(?:\s+PID=(\d*))?/.exec(text);
  if (!match) {
    const why = /ERROR=(.*)/.exec(text);
    return {ok: false, error: why ? 'PowerShell could not start mpv: ' + why[1] : 'unexpected WMI output: ' + text};
  }
  if (match[1] !== '0') {
    // Win32_Process.Create's codes, named: "WMI Create returned 9" said nothing to act on.
    const reason = WmiCreateErrors.get(match[1]);
    return {ok: false, error: 'Windows could not start mpv (WMI code ' + match[1] + (reason ? ': ' + reason : '') + ')'};
  }
  const outcome = focusOutcome(text);
  if (outcome.focus === 'gone' || outcome.focus === 'quit') {
    return {ok: false, error: 'mpv quit right after it started: check the mpv path, and mpv.conf for an option mpv refuses'};
  }
  const tries = /TRIES=(\d+)/.exec(text);
  return {
    ok: true,
    pid: match[2] ? Number(match[2]) : undefined,
    ...outcome,
    tries: tries ? Number(tries[1]) : undefined,
  };
}

/**
 * Launches mpv through the WMI process provider.
 *
 * Firefox starts a native messaging host in a job object of its own and terminates that
 * job when the host exits (or is killed): TerminateJobObject in the Subprocess module's
 * wait() and kill(), toolkit/modules/subprocess/subprocess_win.worker.js (read on
 * mozilla-firefox/firefox main, 2026-10-04). Every process the host starts joins the job,
 * so it dies with the host -- an mpv started with detached:true and unref() as well,
 * neither of which leaves a job. Measured: a directly spawned mpv and one started via
 * `cmd /c start` are both killed; one created by the WMI service survives, because it is
 * parented to WmiPrvSE rather than to us.
 *
 * The job's only limit is JOB_OBJECT_LIMIT_BREAKAWAY_OK (not KILL_ON_JOB_CLOSE, as this
 * comment said until 2026-10-04), so a process created with CREATE_BREAKAWAY_FROM_JOB
 * would leave it too. Node's spawn cannot ask for that flag (libuv's detached deliberately
 * does not set it), and the host does not use it: not measured here.
 *
 * @param {string} mpvPath - Path to the mpv executable.
 * @param {Array<string>} args - Arguments to pass to mpv.
 * @return {Promise<{ok: boolean, pid?: number, error?: string, focus?: string, foreground?: string,
 *   tries?: number}>} wmiLaunchResult's reading of the script's output.
 */
function launchViaWmi(mpvPath, args) {
  const commandLine = windowsCommandLine(mpvPath, args);
  if (commandLine.length >= MaxCommandLineChars) {
    return Promise.resolve({ok: false, error: 'the stream URL is too long for mpv\'s command line'});
  }

  return runPowerShell(wmiLaunchLines(), PowerShellTimeoutMs, {[CommandLineEnv]: commandLine}).then(wmiLaunchResult);
}


/**
 * The first `max` characters of a text, as a reader counts them: a flag or an emoji joined
 * from several is one. Cut between its code points, a part of it was left, which mpv drew
 * as a broken character (#470; glm's review of the fix, 2026-10-13).
 * @param {string} text
 * @param {number} max
 * @return {string}
 */
function cutText(text, max) {
  let out = '';
  let count = 0;
  for (const {segment} of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)) {
    if (count++ === max) break;
    out += segment;
  }
  return out;
}

/**
 * The title mpv shows for a stream (window, taskbar, uosc's top bar): the browser tab's
 * title when the extension sent one, else the stream's host name.
 * @param {{url: string, title?: *}} message - The open message.
 * @return {string} The title.
 */
export function streamTitle(message) {
  if (typeof message.title === 'string') {
    // Control characters out (a title is one line), length bounded in whole characters: a
    // cut through an emoji left half of it, which mpv drew as a broken character (#470).
    const oneLine = Array.from(message.title, (c) => c.charCodeAt(0) < 32 || c === '\u007f' ? ' ' : c)
        .join('').replace(/\s+/g, ' ').trim();
    const clean = cutText(oneLine, 200);
    if (clean) {
      return clean;
    }
  }
  try {
    return new URL(message.url).hostname || 'FastStream';
  } catch (e) {
    return 'FastStream';
  }
}

/**
 * Plays an open message's stream in mpv: in the instance this host started before, when
 * the message asks for that and one runs, else in a new one.
 * @param {string} mpvPath - The mpv executable (resolveMpvPath).
 * @param {Object} message - The open message; its url passed isStreamUrl.
 * @param {Object} config - The parsed config.json.
 * @param {{ipcRequest?: typeof mpvIpcRequest, focus?: typeof focusPid,
 *   start?: (mpvPath: string, args: Array<string>) => Promise<{ok: boolean, error?: string,
 *     pid?: number, focus?: string, foreground?: string}>,
 *   platform?: string}} [io] - Stand-ins for tests: the IPC transport, the window focus,
 *   the launch of a new mpv (launchViaWmi on Windows, launchDirect elsewhere), and
 *   process.platform. The real ones by default.
 * @return {Promise<{ok: boolean, error?: string, reused?: boolean, focus?: string,
 *   foreground?: string}>} The reply for the extension; focus and foreground on Windows
 *   (see the message list at the top of this file).
 */
export async function launchMpv(mpvPath, message, config, io = {}) {
  const platform = io.platform || process.platform;
  const ipcRequest = io.ipcRequest || mpvIpcRequest;
  const focus = io.focus || focusPid;
  const pipe = ipcPipeFor(config, platform);
  const args = [];
  const headerFields = relayHeaderFields(message.headers);
  const title = streamTitle(message);
  /** @type {{start?: number, subFiles: Array<string>}} */
  const extras = {start: startOf(message), subFiles: []};
  try {
    extras.subFiles = writeSubtitleFiles(subtitlesOf(message));
  } catch (e) {
    // The stream still plays without them.
    debugLog(config, 'subtitles-failed', {error: String(e)});
  }

  // Reuse the window we already own, rather than stacking up players. Only
  // instances started with our pipe answer, so an mpv the user opened
  // themselves is never loaded into.
  /** @type {?ReturnType<typeof takeLaunchLock>} */
  let lock = null;
  if (message.singleInstance) {
    const tryExisting = () => loadIntoExisting(message, headerFields, title,
        (commands) => ipcRequest(commands, undefined, undefined, pipe), extras);
    let existing = await tryExisting();
    // Another helper is starting an mpv on this pipe (LaunchLockMs, playMpv): this stream
    // goes to that mpv once its pipe answers. Its own stream came on its command line, so
    // this one, loaded after, replaces it, as the later send should.
    if (!existing.ok && !existing.refused && !existing.busy) {
      const lockFile = io.lockFile || launchLockFile(pipe);
      lock = takeLaunchLock(lockFile, io.lock);
      if (!lock.taken) {
        debugLog(config, 'launch-wait', {});
        const sleep = io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        const now = io.now || Date.now;
        const until = now() + LaunchLockMs;
        while (!existing.ok && !existing.refused && launchLockHeld(lockFile, io.lock) && now() < until) {
          await sleep(PipeWaitPollMs);
          existing = await tryExisting();
        }
        if (!existing.ok && !existing.refused && !existing.busy) {
          lock = takeLaunchLock(lockFile, io.lock);
          if (!lock.taken) {
            return {ok: false, error: 'another mpv is starting and did not take the stream: try again in a moment'};
          }
        }
      }
    }
    if (existing.ok) {
      let focused;
      // The window is raised through PowerShell, which only Windows has.
      if (existing.pid && platform === 'win32') {
        focused = await focus(existing.pid);
      }
      debugLog(config, 'reused', {pid: existing.pid, focus: focused});
      return {ok: true, reused: true, ...focusOutcome(focused || '')};
    }
    // Running, but silent or refusing: a second mpv on the same pipe would get no IPC,
    // and every later send would go to the first one anyway.
    if (existing.refused) {
      debugLog(config, 'refused', {error: existing.error});
      return {ok: false, error: `the open mpv refused the stream (${existing.error}): close it and send again`};
    }
    if (existing.busy) {
      debugLog(config, 'busy', {});
      return {ok: false, error: 'mpv is busy and did not answer: try again in a moment'};
    }
    args.push(`--input-ipc-server=${pipe}`);
  }

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
  // The stream with its own headers and title, as a per-file group (--{ ... --}): they
  // go with this file, not with every later one in the window (perFileOptions). One
  // --http-header-fields-append per header: the plain --http-header-fields takes a
  // comma-separated list, and a comma is legal in a Referer URL. No "--" before the URL
  // (it would end the group's options too): main() lets only http(s) URLs this far, and
  // those cannot be read as an option.
  args.push('--{');
  for (const field of headerFields) {
    args.push(`--http-header-fields-append=${field}`);
  }
  args.push(`--force-media-title=${title}`);
  if (extras.start !== undefined) {
    args.push(`--start=${extras.start}`);
  }
  for (const file of extras.subFiles) {
    args.push(`--sub-files-append=${file}`);
  }
  let target = mpvTargetUrl(message);
  // Windows caps the command line (launchViaWmi refuses a longer one). The page's quality
  // list, percent-encoded once more in fs-quality=, took twelve long URLs past it while the
  // stream itself fitted, and the start failed (#470): mpv starts without the list, and only
  // its quality menu goes without it. A window already open gets it over the pipe, uncapped.
  if (platform === 'win32' && windowsCommandLine(mpvPath, [...args, target, '--}']).length >= MaxCommandLineChars) {
    const withoutQualities = mpvTargetUrl({...message, qualities: undefined});
    if (withoutQualities !== target) {
      debugLog(config, 'qualities-dropped', {length: target.length});
      target = withoutQualities;
    }
  }
  args.push(target);
  args.push('--}');

  debugLog(config, 'spawn', {mpvPath, args});

  // On Windows mpv has to be started by someone outside this process's job
  // object, or the browser kills it the moment this host exits. See
  // launchViaWmi.
  // The launch lock (above) waits on the mpv started from then on: this helper ends now,
  // and the next send waits for that mpv's pipe while it runs.
  const settleLock = (result) => {
    if (result.ok && Number.isInteger(result.pid)) lock?.hand(result.pid);
    else lock?.release();
    return result;
  };
  if (platform === 'win32') {
    const result = settleLock(await (io.start || launchViaWmi)(mpvPath, args));
    if (result.ok) {
      debugLog(config, 'wmi-created',
          {pid: result.pid, focus: result.focus,
            foreground: result.foreground});
      // How raising the window went, for the extension to show or log: the reply said
      // ok and nothing else, and an mpv that opened behind the browser looked like one in
      // front (focusOutcome).
      return {ok: true, ...focusFields(result)};
    }
    debugLog(config, 'wmi-failed', result);
    // No direct spawn as a fallback: Firefox kills it the moment this host
    // exits (see launchViaWmi), so it reported success for an mpv that was
    // gone before it showed anything.
    return {ok: false, error: 'Could not start mpv: ' + result.error};
  }

  return settleLock(await (io.start || launchDirect)(mpvPath, args));
}

/**
 * A launch result's focus and foreground, the ones it has.
 * @param {{focus?: string, foreground?: string}} result - launchViaWmi's result.
 * @return {{focus?: string, foreground?: string}}
 */
function focusFields(result) {
  /** @type {{focus?: string, foreground?: string}} */
  const fields = {};
  if (typeof result.focus === 'string') {
    fields.focus = result.focus;
  }
  if (typeof result.foreground === 'string') {
    fields.foreground = result.foreground;
  }
  return fields;
}

/**
 * Starts mpv as an ordinary detached child. Correct everywhere except inside
 * a Windows job object, where the parent's death takes mpv with it.
 * @param {string} mpvPath - Path to the mpv executable.
 * @param {Array<string>} args - Arguments to pass to mpv.
 * @return {Promise<{ok: boolean, pid?: number, error?: string}>} Result.
 */
export function launchDirect(mpvPath, args) {
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
      // surface the error, but do not wait for full playback start. An mpv that
      // quits within it (an option it refuses, a broken install) played nothing,
      // as the WMI path's FOCUS=gone.
      const timer = setTimeout(() => resolve({ok: true, pid: child.pid}), 500);
      child.once('error', (err) => {
        clearTimeout(timer);
        resolve({ok: false, error: String(err.message || err)});
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ok: false, error: `mpv quit right after it started (${signal || 'exit code ' + code}): check the mpv path, and mpv.conf for an option mpv refuses`});
      });
    } catch (e) {
      resolve({ok: false, error: String(e.message || e)});
    }
  });
}

// Host 15, the thin helper (2026-10-13; docs/notes/mpv.md, "Host 15: the thin helper").
//
// The helper changed 14 times in 10 days, and every change was a reinstall by hand, because
// policy lived in it: fragment tags, title cuts, end detection, notices, the heartbeat. From
// host 15 the extension (which updates itself) holds the policy, and the helper offers three
// primitives that should not need to change: play (start or reuse mpv and load one URL into
// it), ipc (mpv commands, one answer) and relay (mpv's lines to the extension and its
// commands to mpv, over a port).
//
// Only the FastStream extension can start the helper (allowed_extensions in its manifest),
// and even a compromised extension must get no more from it than before: mpv on an http(s)
// URL with Referer, Origin and User-Agent, a title, a start and subtitle files. Nothing it
// sends may make mpv or the helper run a program, load a script, read or write a file of its
// choosing, or open anything but http(s). The checks below are that boundary, default deny:
// play's checks (checkPlayMessage), and one allowlist of mpv commands (ipcCommandRefusal) for
// ipc, relay and a relay's onStop.

// The properties a command may read (get_property, observe_property): what playback, end
// detection and the decoder status use. Never options/*, working-directory, input-bindings,
// property-list, mpv-configuration and the like, which tell local paths and configuration
// (security review r10, risk 4).
export const ReadableProperties = new Set([
  'path', 'eof-reached', 'pause', 'time-remaining', 'time-pos', 'playback-time', 'percent-pos',
  'duration', 'media-title', 'fullscreen', 'idle-active', 'core-idle', 'paused-for-cache',
  'demuxer-cache-duration', 'hwdec-current', 'hwdec', 'video-format', 'width', 'height', 'pid',
  'volume', 'mute', 'speed',
]);

// The properties set_property may change, besides FastStream's own user-data.
export const SettableProperties = new Set(['fullscreen', 'pause', 'volume', 'mute', 'speed']);

// FastStream's own part of mpv's user-data, which the mpv setup's scripts read (connected,
// autoplay, heartbeat): readable and settable. Names of lower-case words only, so a script
// can rely on a tidy namespace.
const FastStreamUserData = /^user-data\/faststream(\/[a-z0-9_-]+)+$/;

// The script messages the extension may send to every script (script-message): FastStream's
// own, which mpv's built-in scripts do not listen for.
const FastStreamScriptMessage = /^faststream-[a-z0-9-]{1,40}$/;

// What one ipc message may carry, and a relay's onStop: the frame admits about 50,000
// commands, and none of FastStream's uses comes near these.
export const MaxIpcCommands = 32;
export const MaxOnStopCommands = 8;

// The longest property value (set_property) and notice text (notify, show-text, the
// arguments of a script message) the allowlist takes, the most script-message arguments,
// and the longest show-text, in milliseconds (MaxNoticeSeconds).
const MaxPropertyText = 4096;
const MaxNoticeText = 2048;
const MaxScriptMessageArgs = 8;
const MaxShowTextMs = MaxNoticeSeconds * 1000;

/**
 * Whether a value is a string of at most max characters with no control character in it (a
 * code below 32, or 127) and, with noExpansion, no '${': mpv expands properties in show-text
 * (and a script may in what it is sent), and ${working-directory} or ${path} would put local
 * detail on the screen.
 * @param {*} value - The value.
 * @param {number} max - The most characters.
 * @param {boolean} [noExpansion] - Whether '${' is refused too.
 * @return {boolean}
 */
export function isPlainText(value, max, noExpansion = false) {
  if (typeof value !== 'string' || value.length > max) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return false;
    }
  }
  return !(noExpansion && value.includes('$' + '{'));
}

/**
 * @param {*} name - A property name from the extension.
 * @return {boolean} Whether a command may read it.
 */
function isReadableProperty(name) {
  return typeof name === 'string' && (ReadableProperties.has(name) || FastStreamUserData.test(name));
}

/**
 * @param {*} name - A property name from the extension.
 * @return {boolean} Whether set_property may change it.
 */
function isSettableProperty(name) {
  return typeof name === 'string' && (SettableProperties.has(name) || FastStreamUserData.test(name));
}

/**
 * @param {*} value - A value for set_property.
 * @return {boolean} Whether it is a yes or no, a finite number, or a plain text.
 */
function isPropertyValue(value) {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ||
    isPlainText(value, MaxPropertyText, true);
}

/**
 * Whether a notice's seconds are whole seconds from 1 to MaxNoticeSeconds, as text.
 * notify.lua reads 0 as "until replaced or hidden", which would undo the cap.
 * @param {*} seconds - The 7th argument of a notify show.
 * @return {boolean}
 */
function isNoticeSeconds(seconds) {
  return typeof seconds === 'string' && /^[0-9]{1,2}$/.test(seconds) &&
    Number(seconds) >= 1 && Number(seconds) <= MaxNoticeSeconds;
}

/**
 * Why a script-message-to is refused, or null: only FastStream's notices in notify.lua,
 * show with a title, a detail and optional seconds, and hide. The sub-command is pinned, not
 * only the target, so what passes does not depend on the handlers notify.lua has.
 * @param {Array<*>} args - The command's arguments, after its name.
 * @return {?string}
 */
function noticeRefusal(args) {
  if (args[0] !== 'notify') {
    return 'script-message-to: only notify';
  }
  if (args[1] === 'hide') {
    return args.length === 3 && args[2] === 'faststream' ? null : 'notify hide: only faststream';
  }
  if (args[1] !== 'show' || args[2] !== 'faststream') {
    return 'notify: only show or hide of faststream';
  }
  if (args.length !== 5 && args.length !== 6) {
    return 'notify show: a title, a detail and the seconds only';
  }
  if (!isPlainText(args[3], MaxNoticeText, true) || !isPlainText(args[4], MaxNoticeText, true)) {
    return 'notify show: title or detail not allowed';
  }
  if (args.length === 6 && !isNoticeSeconds(args[5])) {
    return 'notify show: seconds not allowed';
  }
  return null;
}

/**
 * Why a script-message is refused, or null: a faststream-* message with at most
 * MaxScriptMessageArgs plain texts.
 * @param {Array<*>} args - The command's arguments, after its name.
 * @return {?string}
 */
function scriptMessageRefusal(args) {
  if (typeof args[0] !== 'string' || !FastStreamScriptMessage.test(args[0])) {
    return 'script-message: only faststream-* messages';
  }
  if (args.length - 1 > MaxScriptMessageArgs) {
    return 'script-message: too many arguments';
  }
  return args.slice(1).every((arg) => isPlainText(arg, MaxNoticeText)) ? null : 'script-message: argument not allowed';
}

/**
 * Why a show-text is refused, or null: a plain text without '${', and optionally whole
 * milliseconds from 0 to MaxShowTextMs.
 * @param {Array<*>} args - The command's arguments, after its name.
 * @return {?string}
 */
function showTextRefusal(args) {
  if (args.length !== 1 && args.length !== 2) {
    return 'show-text: a text and the milliseconds only';
  }
  if (!isPlainText(args[0], MaxNoticeText, true)) {
    return 'show-text: text not allowed';
  }
  if (args.length === 2 && !(Number.isInteger(args[1]) && args[1] >= 0 && args[1] <= MaxShowTextMs)) {
    return 'show-text: milliseconds not allowed';
  }
  return null;
}

/**
 * Why an mpv command from the extension is refused, or null when the allowlist lets it
 * through (ipc, relay, a relay's onStop). Only the array form, every argument type-checked;
 * anything else is refused:
 * - ['get_property', name], ['observe_property', id, name], ['unobserve_property', id]: name
 *   in ReadableProperties or FastStream's user-data (user-data/faststream/...), id an integer;
 * - ['set_property', name, value]: name in SettableProperties or FastStream's user-data, value
 *   a yes or no, a finite number, or a text of at most 4096 characters, no control
 *   character, no '${';
 * - ['script-message-to', 'notify', 'show', 'faststream', title, detail, seconds?] and
 *   ['script-message-to', 'notify', 'hide', 'faststream']: title and detail texts of at most
 *   2048 characters, no control character, no '${'; seconds whole seconds 1 to 60 as text;
 * - ['script-message', name, ...args]: name faststream-[a-z0-9-]{1,40}, at most 8 texts of at
 *   most 2048 characters, no control character;
 * - ['show-text', text] and ['show-text', text, ms]: text as a notice's title, ms an integer
 *   0 to 60000.
 * Never run, subprocess, load-script, loadfile, loadlist, script-binding, keypress, keybind,
 * expand-path, the object form ({name, ...}), or a property not named here.
 * @param {*} command - The command as the extension sent it.
 * @return {?string} Why it is refused; null when it is allowed.
 */
export function ipcCommandRefusal(command) {
  if (!Array.isArray(command) || command.length === 0) {
    return 'not an array-form command';
  }
  const [name, ...args] = command;
  switch (name) {
    case 'get_property':
      return args.length === 1 && isReadableProperty(args[0]) ? null : 'get_property: property not allowed';
    case 'observe_property':
      if (args.length !== 2 || !Number.isSafeInteger(args[0])) {
        return 'observe_property: an integer id and a property only';
      }
      return isReadableProperty(args[1]) ? null : 'observe_property: property not allowed';
    case 'unobserve_property':
      return args.length === 1 && Number.isSafeInteger(args[0]) ? null : 'unobserve_property: an integer id only';
    case 'set_property':
      if (args.length !== 2 || !isSettableProperty(args[0])) {
        return 'set_property: property not allowed';
      }
      return isPropertyValue(args[1]) ? null : 'set_property: value not allowed';
    case 'script-message-to':
      return noticeRefusal(args);
    case 'script-message':
      return scriptMessageRefusal(args);
    case 'show-text':
      return showTextRefusal(args);
    default:
      // The command's name, when it is one, to make the extension's own mistakes easy to see.
      return typeof name === 'string' && /^[a-z_-]{1,40}$/.test(name) ?
        `command not allowed: ${name}` : 'command not allowed';
  }
}

/**
 * Whether the allowlist lets an mpv command from the extension through (ipcCommandRefusal).
 * @param {*} command - The command as the extension sent it.
 * @return {boolean}
 */
export function allowedIpcCommand(command) {
  return ipcCommandRefusal(command) === null;
}

// The longest target play takes (bytes, UTF-8, as JSON writes it: mpv's path line carries
// it so to the extension, MaxRelayLineBytes): a stream URL and its fragment tags, of which
// the page's quality list (fs-quality=) is the longest, in a message of MaxMessageBytes.
export const MaxTargetBytes = 512 * 1024;
const MaxTitleChars = 1000;
const MaxPlayHeaders = 8;
const PlayStart = /^\d{1,7}(\.\d{1,3})?$/;
// relayHeaderFields' names and values, as one "Name: value" string (the protocol's form).
const PlayHeader = /^(referer|origin|user-agent): [ -~]{1,4096}$/i;

/**
 * A play message as checkPlayMessage passes it on.
 * @typedef {Object} PlaySpec
 * @property {string} target - The URL for mpv, as the extension built it.
 * @property {string} title - force-media-title.
 * @property {string|undefined} start - Seconds, as text.
 * @property {Array<string>} headerFields - "Name: value" strings.
 * @property {Array<{srt: string, label: string}>} subtitles - subtitlesOf's.
 * @property {boolean} fullscreen
 * @property {boolean} newWindow - A window of its own, not the one on the helper's pipe.
 * @property {string|undefined} mpvPath - The options page's mpv path, as the legacy open
 *   takes it: resolveMpvPath accepts only an mpv executable or its folder, no network or
 *   device path, so it names no program but mpv.
 */

/**
 * Checks a play message (host 15) and takes from it what play uses; any failure refuses the
 * whole message:
 * - target: an http(s) URL (isStreamUrl) of at most MaxTargetBytes, no control character;
 * - title: a text of at most 1000 characters, no control character; without one (or an
 *   empty one) the target's host name;
 * - start: seconds as text, /^\d{1,7}(\.\d{1,3})?$/;
 * - headers: at most 8 "Referer: ...", "Origin: ..." or "User-Agent: ..." strings of
 *   printable ASCII, none ending in a backslash (mpv would read it and the separator after it
 *   as an escaped comma, and join the next header to this one: measured);
 * - subtitles: at most 8 {label, srt} with SubRip text of at most MaxSubtitleChars (empty
 *   ones are left out, as subtitlesOf does);
 * - fullscreen and newWindow: a yes or no.
 * - mpvPath: the options page's mpv path, kept when it is one line of text; resolveMpvPath
 *   checks it as for the legacy open (only an mpv executable or its folder). Left out, a
 *   user who gave the path only there got "mpv was not found" from play while "Test mpv
 *   connection" found mpv.
 * Fields it does not know are ignored.
 * @param {*} message - The message.
 * @return {{ok: true, play: PlaySpec}|{ok: false, error: string}}
 */
export function checkPlayMessage(message) {
  const refuse = (error) => ({ok: /** @type {false} */ (false), error});
  const {target} = message;
  if (typeof target !== 'string' || !isStreamUrl(target)) {
    return refuse('mpv is only given http(s) streams');
  }
  if (Buffer.byteLength(JSON.stringify(target), 'utf8') - 2 > MaxTargetBytes) {
    return refuse('the stream URL is too long for mpv');
  }
  if (!isPlainText(target, Infinity)) {
    return refuse('the stream URL holds a control character');
  }

  let title;
  if (message.title === undefined || message.title === null || message.title === '') {
    title = new URL(target).hostname || 'FastStream';
  } else if (isPlainText(message.title, MaxTitleChars)) {
    title = message.title;
  } else {
    return refuse('the title is not one line of at most 1000 characters');
  }

  let start;
  if (message.start !== undefined && message.start !== null) {
    if (typeof message.start !== 'string' || !PlayStart.test(message.start)) {
      return refuse('the start is not a number of seconds');
    }
    start = message.start;
  }

  const headers = message.headers ?? [];
  if (!Array.isArray(headers) || headers.length > MaxPlayHeaders) {
    return refuse('the headers are not a list of at most 8');
  }
  for (const header of headers) {
    if (typeof header !== 'string' || !PlayHeader.test(header)) {
      return refuse('a header is not Referer, Origin or User-Agent with a printable ASCII value');
    }
    if (header.endsWith('\\')) {
      return refuse('a header ends in a backslash');
    }
  }

  const subtitles = message.subtitles ?? [];
  if (!Array.isArray(subtitles) || subtitles.length > MaxSubtitles || !subtitles.every((s) =>
    s && typeof s === 'object' && typeof s.srt === 'string' && s.srt.length <= MaxSubtitleChars &&
      (s.label === undefined || typeof s.label === 'string'))) {
    return refuse('the subtitles are not at most 8 SubRip texts with labels');
  }

  const fullscreen = message.fullscreen ?? false;
  const newWindow = message.newWindow ?? false;
  if (typeof fullscreen !== 'boolean' || typeof newWindow !== 'boolean') {
    return refuse('fullscreen and newWindow are a yes or no');
  }

  const mpvPath = isPlainText(message.mpvPath, 4096) ? message.mpvPath : undefined;

  return {
    ok: true,
    play: {target, title, start, headerFields: [...headers], subtitles: subtitlesOf({subtitles}), fullscreen, newWindow,
      mpvPath},
  };
}


// How long a new mpv gets to open its pipe (play), and how often the helper looks.
export const PipeWaitMs = 15000;
const PipeWaitPollMs = 200;

// One helper at a time starts an mpv on the helper's pipe. Each send is a helper process of
// its own, and two within one start (a second tab, a second click) both found no mpv there:
// each started one, and the second could not open the pipe - it played on without one,
// out of reach of every later send, key and end detection. The lock is a file only one
// process can create, naming the process it waits on (the helper, then the mpv it started);
// it no longer holds once that process is gone, or after LaunchLockMs.
export const LaunchLockMs = PipeWaitMs + 5000;

/**
 * The launch lock's file for a pipe, in the user's temp folder.
 * @param {string} pipe - The helper's pipe (ipcPipeFor).
 * @param {string} [dir] - Its folder (tests).
 * @return {string}
 */
export function launchLockFile(pipe, dir = os.tmpdir()) {
  const id = crypto.createHash('sha256').update(pipe).digest('hex').slice(0, 16);
  return path.join(dir, `faststream-mpv-launch-${id}.lock`);
}

/**
 * Whether a process runs.
 * @param {number} pid
 * @return {boolean}
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as someone this process may not signal.
    return !!e && e.code === 'EPERM';
  }
}

/**
 * Whether the launch lock holds: its file is there, younger than LaunchLockMs, and the
 * process it names still runs.
 * @param {string} file - launchLockFile.
 * @param {{now?: function(): number, alive?: function(number): boolean}} [io] - Stand-ins.
 * @return {boolean}
 */
export function launchLockHeld(file, io = {}) {
  try {
    if ((io.now || Date.now)() - fs.statSync(file).mtimeMs >= LaunchLockMs) return false;
    const pid = Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid);
    return !Number.isInteger(pid) || (io.alive || processAlive)(pid);
  } catch (e) {
    return false;
  }
}

/**
 * Takes the launch lock, unless another helper holds it.
 * @param {string} file - launchLockFile.
 * @param {{now?: function(): number, alive?: function(number): boolean}} [io] - Stand-ins.
 * @return {{taken: boolean, hand: function(number): void, release: function(): void}} hand
 *   names the process to wait on from then on (the mpv started); release lets the lock go.
 */
export function takeLaunchLock(file, io = {}) {
  const none = {hand: () => {}, release: () => {}};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({pid: process.pid}), {flag: 'wx'});
      let released = false;
      return {
        taken: true,
        hand: (pid) => {
          if (released) return;
          try {
            fs.writeFileSync(file, JSON.stringify({pid}));
          } catch (e) {
            // Without the lock the next send only starts an mpv of its own, as before.
          }
        },
        release: () => {
          if (released) return;
          released = true;
          try {
            fs.unlinkSync(file);
          } catch (e) {
            // Gone already.
          }
        },
      };
    } catch (e) {
      // A temp folder that takes no file: start as before, unlocked.
      if (!e || e.code !== 'EEXIST') return {taken: true, ...none};
      if (launchLockHeld(file, io)) return {taken: false, ...none};
      try {
        // Left by a helper that died, or an mpv that is gone: taken over.
        fs.unlinkSync(file);
      } catch (e2) {
        // Another helper took it over first.
      }
    }
  }
  return {taken: false, ...none};
}

/**
 * Play's new mpv's whole command line after the executable: fixed by the helper, nothing
 * from the message. The stream goes over the pipe once mpv is up, so no value of the
 * extension's meets Windows' command-line quoting (the review's conditional RCE, risk 1) or
 * its 32767-character cap. --idle=once keeps mpv open until the first file has come and gone;
 * --force-window=immediate makes the window at once, for the focus script to find (launchMpv).
 * @param {string} pipe - The pipe mpv listens on.
 * @param {boolean} fullscreen - Whether mpv starts fullscreen.
 * @return {Array<string>}
 */
export function freshMpvArgs(pipe, fullscreen) {
  const args = [`--input-ipc-server=${pipe}`, '--idle=once', '--force-window=immediate', '--no-terminal'];
  if (fullscreen) {
    args.push('--fullscreen');
  }
  return args;
}

/**
 * Waits for a new mpv to answer on its pipe (get_property pid), up to waitMs.
 * @param {(commands: Array<Object>) => ReturnType<typeof mpvIpcRequest>} ipcRequest - The
 *   transport, bound to the pipe.
 * @param {number} [waitMs] - How long to keep asking.
 * @param {(ms: number) => Promise<void>} [sleep] - Injectable for tests.
 * @param {() => number} [now] - Injectable for tests.
 * @return {Promise<boolean>} Whether it answered.
 */
export async function waitForPipe(ipcRequest, waitMs = PipeWaitMs,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now) {
  const deadline = now() + waitMs;
  for (;;) {
    const result = await ipcRequest([{command: ['get_property', 'pid']}]);
    if (result.ok) {
      return true;
    }
    if (now() + PipeWaitPollMs > deadline) {
      return false;
    }
    await sleep(PipeWaitPollMs);
  }
}

/**
 * Ends an mpv this helper started (playMpv), as Task Manager would.
 * @param {number} pid - Its process id.
 */
export function stopMpv(pid) {
  try {
    process.kill(pid);
  } catch {
    // It has gone already.
  }
}

/**
 * Plays a checked play message (host 15) in mpv.
 *
 * Not newWindow: the stream goes into the mpv on the helper's pipe, when one runs (as
 * launchMpv's single instance: one that is busy or refuses is an error, never a second mpv
 * on the same pipe). Otherwise, and for newWindow, a new mpv starts with freshMpvArgs only,
 * through WMI and the focus script on Windows (launchViaWmi) and as a child elsewhere
 * (launchDirect); once its pipe answers, the stream goes to it the same way. newWindow gives
 * the new mpv a pipe of its own (the helper's pipe, '-', random hex), used for this one load:
 * the window on the helper's pipe stays the one that later sends, ipc and relay reach.
 * @param {?string} mpvPath - The mpv executable (resolveMpvPath), or null when none was found:
 *   then only an mpv already open can play.
 * @param {PlaySpec} play - checkPlayMessage's.
 * @param {Object} config - The parsed config.json.
 * @param {{ipcRequest?: typeof mpvIpcRequest, focus?: typeof focusPid,
 *   start?: (mpvPath: string, args: Array<string>) => Promise<{ok: boolean, error?: string,
 *     pid?: number, focus?: string, foreground?: string}>,
 *   platform?: string, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   randomHex?: () => string, subtitleBase?: string, stop?: (pid: number) => void}} [io] -
 *   Stand-ins for tests, as launchMpv's, and the clock of the pipe wait, the new pipe's
 *   suffix, the folder the subtitle files go under and the end of a started mpv (stopMpv).
 * @return {Promise<{ok: boolean, error?: string, reused?: boolean, focus?: string,
 *   foreground?: string}>} The answer for the extension, as the legacy open's.
 */
export async function playMpv(mpvPath, play, config, io = {}) {
  const platform = io.platform || process.platform;
  const ipcRequest = io.ipcRequest || mpvIpcRequest;
  const focus = io.focus || focusPid;
  const basePipe = ipcPipeFor(config, platform);
  /** @type {Array<string>} */
  let subFiles = [];
  try {
    subFiles = writeSubtitleFiles(play.subtitles, io.subtitleBase);
  } catch (e) {
    // The stream still plays without them.
    debugLog(config, 'subtitles-failed', {error: String(e)});
  }
  const options = perFileOptions(play.headerFields, play.title, {start: play.start, subFiles});
  /**
   * @param {string} pipe
   * @param {boolean} fullscreen
   * @return {ReturnType<typeof loadInto>}
   */
  const load = (pipe, fullscreen) => loadInto(play.target, options, fullscreen,
      (commands) => ipcRequest(commands, undefined, undefined, pipe));

  if (!play.newWindow) {
    const existing = await load(basePipe, play.fullscreen);
    if (existing.ok) {
      let focused;
      // The window is raised through PowerShell, which only Windows has.
      if (existing.pid && platform === 'win32') {
        focused = await focus(existing.pid);
      }
      debugLog(config, 'reused', {pid: existing.pid, focus: focused});
      return {ok: true, reused: true, ...focusOutcome(focused || '')};
    }
    if (existing.refused) {
      debugLog(config, 'refused', {error: existing.error});
      return {ok: false, error: `the open mpv refused the stream (${existing.error}): close it and send again`};
    }
    if (existing.busy) {
      debugLog(config, 'busy', {});
      return {ok: false, error: 'mpv is busy and did not answer: try again in a moment'};
    }
  }

  // Another helper is starting an mpv on this pipe (LaunchLockMs): this stream goes to that
  // mpv once that helper is done with it - loaded before, its own stream would come after
  // this one and replace it.
  const lockFile = play.newWindow ? null : (io.lockFile || launchLockFile(basePipe));
  let lock = lockFile ? takeLaunchLock(lockFile, io.lock) : null;
  if (lock && !lock.taken) {
    debugLog(config, 'launch-wait', {});
    const sleep = io.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = io.now || Date.now;
    const until = now() + LaunchLockMs;
    while (launchLockHeld(lockFile, io.lock) && now() < until) {
      await sleep(PipeWaitPollMs);
    }
    const loaded = await load(basePipe, play.fullscreen);
    if (loaded.ok) {
      let focused;
      if (loaded.pid && platform === 'win32') {
        focused = await focus(loaded.pid);
      }
      debugLog(config, 'reused', {pid: loaded.pid, focus: focused});
      return {ok: true, reused: true, ...focusOutcome(focused || '')};
    }
    if (loaded.refused) {
      return {ok: false, error: `the open mpv refused the stream (${loaded.error}): close it and send again`};
    }
    // That start came to nothing: this helper starts one.
    lock = takeLaunchLock(lockFile, io.lock);
    if (!lock.taken) {
      return {ok: false, error: 'another mpv is starting and did not take the stream: try again in a moment'};
    }
  }
  try {
    return await startAndLoad();
  } finally {
    lock?.release();
  }

  /**
   * Starts an mpv on the pipe and loads the stream into it.
   * @return {Promise<{ok: boolean, error?: string, focus?: string, foreground?: string}>}
   */
  async function startAndLoad() {
    if (!mpvPath) {
      return {ok: false, error: mpvNotFoundError(play.mpvPath)};
    }
    const pipe = play.newWindow ?
      basePipe + '-' + (io.randomHex ? io.randomHex() : crypto.randomBytes(8).toString('hex')) : basePipe;
    const args = freshMpvArgs(pipe, play.fullscreen);
    debugLog(config, 'spawn', {mpvPath, args});
    // On Windows mpv has to be started by someone outside this process's job object, or the
    // browser kills it the moment this host exits (launchViaWmi); no direct spawn as a fallback.
    /** @type {{ok: boolean, error?: string, pid?: number, focus?: string, foreground?: string}} */
    const started = await (io.start || (platform === 'win32' ? launchViaWmi : launchDirect))(mpvPath, args);
    if (!started.ok) {
      debugLog(config, 'start-failed', started);
      return {ok: false, error: platform === 'win32' ? 'Could not start mpv: ' + started.error : String(started.error)};
    }
    debugLog(config, 'started', {pid: started.pid, focus: started.focus, foreground: started.foreground});

    const answered = await waitForPipe((commands) => ipcRequest(commands, 1000, 3000, pipe), PipeWaitMs, io.sleep, io.now);
    // --idle=once keeps an mpv that never loaded a file open for good: one that stays silent
    // or refuses the stream would be an empty window after the error (glm's review of host
    // 15). Only the one started here, by its own pid; a late answer is left alone, since mpv
    // may well have the stream.
    const end = () => {
      if (started.pid) {
        (io.stop || stopMpv)(started.pid);
      }
    };
    if (!answered) {
      debugLog(config, 'pipe-silent', {pipe});
      end();
      return {ok: false, error: `mpv started, but did not answer on its pipe within ${PipeWaitMs / 1000} s`};
    }
    // --fullscreen is on the command line already.
    const loaded = await load(pipe, false);
    if (!loaded.ok) {
      debugLog(config, 'load-failed', loaded);
      if (loaded.refused) {
        end();
      }
      return {ok: false, error: loaded.refused ?
        `the new mpv refused the stream (${loaded.error})` :
        'the new mpv did not take the stream: try again in a moment'};
    }
    // How raising the window went, as the legacy open says it (Windows only).
    return {ok: true, ...(platform === 'win32' ? focusFields(started) : {})};
  }
}

/**
 * Runs an ipc message's commands (host 15) on the mpv on the helper's pipe: all of them
 * allowlisted (ipcCommandRefusal), or none is sent. The helper numbers the requests itself
 * (mpvIpcRequest), so an id of the extension's can never meet one of its own.
 * @param {*} commands - The message's commands: array-form mpv commands, at most MaxIpcCommands.
 * @param {{ipcRequest?: typeof mpvIpcRequest, pipe?: string}} [io] - Stand-ins for tests.
 * @return {Promise<{ok: boolean, replies?: Array<{error: *, data: *}>, error?: string,
 *   busy?: boolean, index?: number, reason?: string}>} replies in the commands' order;
 *   error 'refused' with the index of the first refused command and why; or mpvIpcRequest's
 *   error (no mpv, busy).
 */
export async function runIpc(commands, io = {}) {
  if (!Array.isArray(commands) || commands.length > MaxIpcCommands) {
    return {ok: false, error: 'refused', reason: `commands is not a list of at most ${MaxIpcCommands}`};
  }
  for (let index = 0; index < commands.length; index++) {
    const reason = ipcCommandRefusal(commands[index]);
    if (reason) {
      return {ok: false, error: 'refused', index, reason};
    }
  }
  if (commands.length === 0) {
    return {ok: true, replies: []};
  }
  const result = await (io.ipcRequest || mpvIpcRequest)(commands.map((command) => ({command})),
      undefined, undefined, io.pipe || ipcPipeFor(readConfig()));
  if (!result.ok) {
    return {ok: false, error: result.error || 'no mpv ipc', ...(result.busy ? {busy: true} : {})};
  }
  const replies = result.replies || [];
  return {
    ok: true,
    replies: commands.map((command, index) => {
      const reply = replies.find((r) => r && r.request_id === index + 1);
      // mpvIpcRequest gives up with the answers it has after its reply time.
      return reply ? {error: reply.error, data: reply.data} : {error: 'no reply', data: undefined};
    }),
  };
}

// A relay's heartbeat: at least this often apart, and no further than setInterval can wait
// (past it, Node runs the interval every millisecond).
export const MinHeartbeatMs = 5000;
const MaxTimerMs = 2147483647;

/**
 * A relay message's options, checked: heartbeat a FastStream user-data property and an
 * interval of MinHeartbeatMs or more; onStop at most MaxOnStopCommands allowlisted commands.
 * @param {*} message - The first message on the port.
 * @return {{ok: true, heartbeat: ?{property: string, everyMs: number}, onStop: Array<Array<*>>}|
 *   {ok: false, error: string}}
 */
export function checkRelayMessage(message) {
  /** @type {?{property: string, everyMs: number}} */
  let heartbeat = null;
  if (message.heartbeat !== undefined && message.heartbeat !== null) {
    const {property, everyMs} = typeof message.heartbeat === 'object' ? message.heartbeat : {};
    if (typeof property !== 'string' || !FastStreamUserData.test(property) || !Number.isInteger(everyMs) ||
        everyMs < MinHeartbeatMs || everyMs > MaxTimerMs) {
      return {ok: false, error: `the heartbeat is not a user-data/faststream/ property and at least ${MinHeartbeatMs} ms`};
    }
    heartbeat = {property, everyMs};
  }
  const onStop = message.onStop ?? [];
  if (!Array.isArray(onStop) || onStop.length > MaxOnStopCommands) {
    return {ok: false, error: `onStop is not a list of at most ${MaxOnStopCommands} commands`};
  }
  for (let index = 0; index < onStop.length; index++) {
    const reason = ipcCommandRefusal(onStop[index]);
    if (reason) {
      return {ok: false, error: `onStop command ${index} refused: ${reason}`};
    }
  }
  return {ok: true, heartbeat, onStop};
}

// The longest line of mpv's the relay passes on (bytes, UTF-8): a native message to the
// extension may be 1 MB (MaxMessageBytes, with room for the message around the line). Over
// a stream's longest target (MaxTargetBytes), so the path event of every stream play took
// arrives: at 256 KB the path of a longer one was dropped, and end detection never saw it.
export const MaxRelayLineBytes = 1000 * 1024;
// How much of the end of a line over MaxRelayLineBytes is kept to find its request_id in.
const RequestIdWindow = 256;

/**
 * Relays between the extension and the mpv on the helper's pipe (host 15), over a port the
 * extension keeps open (connectNative): every line mpv sends goes to the extension as
 * {type: 'mpv', data} (one over MaxRelayLineBytes is dropped), except the replies to the
 * relay's own requests; the extension's allowlisted commands (receive) go to mpv with a request
 * id of the helper's, and mpv's reply comes back as {type: 'mpv-reply', id, error, data} when
 * the extension gave an id; a refused command as {type: 'mpv-refused', id, reason}.
 *
 * The heartbeat sets its property to a strictly rising number (the time) when the relay
 * connects and every everyMs after, as watchMpv's does: the mpv setup hides FastStream's
 * buttons once it stands still. onStop is written to mpv when the extension lets go (stop),
 * not when mpv goes. {type: 'relaying'} once connected; {type: 'closed', reason} last: 'no mpv',
 * 'mpv closed' or 'stopped'.
 * @param {(message: Object) => *} send - Sends a message to the extension.
 * @param {{heartbeat?: ?{property: string, everyMs: number}, onStop?: Array<Array<*>>}} [options] -
 *   checkRelayMessage's.
 * @param {{pipe?: string, connect?: (pipe: string) => import('net').Socket}} [io] - Tests.
 * @return {{receive: (message: *) => void, stop: () => void, done: Promise<string>}} done
 *   resolves with why it ended, once onStop is written.
 */
export function relayMpv(send, options = {}, io = {}) {
  const heartbeatOption = options.heartbeat || null;
  const onStop = options.onStop || [];
  const socket = (io.connect || net.connect)(io.pipe || ipcPipeFor(readConfig()));
  // Decoded as a stream: a character mpv sends in two chunks stays one character.
  socket.setEncoding('utf8');
  const newline = String.fromCharCode(10);
  let buffer = '';
  // Inside a line over MaxRelayLineBytes: what comes up to its end is dropped.
  let skipping = false;
  let connected = false;
  let finished = false;
  let requests = 0;
  // The relay's requests to mpv not answered yet: the extension's id, or null for one it
  // gave none (and for the heartbeat's and onStop's), whose answer goes nowhere.
  /** @type {Map<number, ?number>} */
  const pending = new Map();
  /** @type {?ReturnType<typeof setInterval>} */
  let heartbeat = null;
  let lastBeat = 0;
  /** @type {(reason: string) => void} */
  let resolveDone = () => {};
  /** @type {Promise<string>} */
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  /**
   * @param {Array<*>} command
   * @param {?number} id - The extension's id for the reply, or null.
   * @return {string} The line for mpv, with a request id of the relay's.
   */
  const requestLine = (command, id) => {
    requests++;
    pending.set(requests, id);
    return JSON.stringify({command, request_id: requests}) + newline;
  };
  /**
   * @param {Array<*>} command
   * @param {?number} [id]
   */
  const write = (command, id = null) => {
    if (!finished) socket.write(requestLine(command, id));
  };
  const beat = () => {
    if (!heartbeatOption) return;
    // Strictly rising, even with two beats in one millisecond.
    lastBeat = Math.max(Date.now(), lastBeat + 1);
    write(['set_property', heartbeatOption.property, lastBeat]);
  };
  /**
   * An answer to one of the relay's requests: to the extension when it gave an id.
   * @param {number} requestId
   * @param {*} error
   * @param {*} data
   */
  const answer = (requestId, error, data) => {
    const id = pending.get(requestId);
    pending.delete(requestId);
    if (id !== null && id !== undefined) {
      send({type: 'mpv-reply', id, error, data});
    }
  };
  /**
   * A line over MaxRelayLineBytes, dropped; when it answers a request of the relay's, the
   * extension still hears that it was answered (its end holds the request id).
   * @param {string} text - The line, or what is left of its end.
   */
  const overSize = (text) => {
    const match = /"request_id":(\d+)[,}]/.exec(text.slice(-RequestIdWindow));
    const requestId = match ? Number(match[1]) : NaN;
    if (pending.has(requestId)) {
      answer(requestId, 'reply too large', undefined);
    }
  };
  /** @param {string} text - One line from mpv. */
  const take = (text) => {
    if (Buffer.byteLength(text, 'utf8') > MaxRelayLineBytes) {
      overSize(text);
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!data || typeof data !== 'object') return;
    if (typeof data.request_id === 'number' && pending.has(data.request_id)) {
      answer(data.request_id, data.error, data.data);
      return;
    }
    send({type: 'mpv', data});
  };
  /**
   * Ends the relay, once.
   * @param {string} reason
   */
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    send({type: 'closed', reason});
    /** @type {?ReturnType<typeof setTimeout>} */
    let timer = null;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolveDone(reason);
    };
    if (reason === 'stopped' && onStop.length > 0 && socket.writable) {
      // The extension let go, mpv plays on: onStop tells it so. end() sends the lines before
      // it closes the pipe (destroy() could drop them), and done waits for that, briefly.
      timer = setTimeout(end, 2000);
      socket.end(onStop.map((command) => requestLine(command, null)).join(''), end);
    } else {
      end();
    }
  };

  socket.on('error', () => finish(connected ? 'mpv closed' : 'no mpv'));
  socket.on('close', () => finish(connected ? 'mpv closed' : 'no mpv'));
  socket.on('connect', () => {
    if (finished) return;
    connected = true;
    if (heartbeatOption) {
      beat();
      heartbeat = setInterval(beat, heartbeatOption.everyMs);
      // The beat alone keeps no host running: it ends when the extension or mpv does.
      heartbeat.unref?.();
    }
    send({type: 'relaying'});
  });
  socket.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(newline);
    buffer = lines.pop() || '';
    for (const text of lines) {
      if (skipping) {
        skipping = false;
        overSize(text);
      } else {
        take(text);
      }
    }
    if (skipping) {
      // Still inside the line that is too long: only its end is kept, for its request id.
      buffer = buffer.slice(-RequestIdWindow);
    } else if (buffer.length > MaxRelayLineBytes) {
      skipping = true;
      buffer = buffer.slice(-RequestIdWindow);
    }
  });

  return {
    receive(message) {
      if (finished || !message || typeof message !== 'object') return;
      const {id} = message;
      const hasId = id !== undefined && id !== null;
      /** @param {string} reason */
      const refuse = (reason) => {
        send({type: 'mpv-refused', ...(Number.isSafeInteger(id) ? {id} : {}), reason});
      };
      if (message.type !== 'mpv') {
        refuse('unknown message');
      } else if (hasId && !Number.isSafeInteger(id)) {
        refuse('the id is not an integer');
      } else {
        const reason = ipcCommandRefusal(message.command);
        if (reason) {
          refuse(reason);
        } else {
          write(message.command, hasId ? id : null);
        }
      }
    },
    stop() {
      finish('stopped');
    },
    done,
  };
}

/**
 * Answers the one message the extension sends this run (a watch: for as long as its port
 * stays open). It only returns; main() ends the process.
 */
async function handleMessage() {
  const config = readConfig();
  const message = await readMessage();
  if (message === TooLarge) {
    debugLog(config, 'too-large', {});
    await sendMessage({ok: false, error: 'the message was too large for the mpv host'});
    return;
  }
  debugLog(config, 'received', loggedMessage(message));
  if (!message || typeof message !== 'object') {
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
    return;
  }

  // Which video decoder the mpv this host started uses: the extension asks after a
  // hand-off, and "Test mpv connection" asks too. Read-only: nothing is changed in mpv.
  if (message.type === 'status') {
    const status = await queryDecoder(message.waitMs);
    debugLog(config, 'status', status);
    await sendMessage({ok: true, ...status});
    return;
  }

  // MPV autoplay: follows mpv for as long as the extension keeps the port open.
  if (message.type === 'watch') {
    const watch = watchMpv((event) => {
      debugLog(config, 'watch', event);
      sendMessage(event);
    });
    // The browser went (closed, or the extension reloaded) while mpv plays on: a write to it
    // fails, and an unhandled stdout error ended this host with a crash, leaving mpv's
    // episode buttons up with no one to hear them. It ends as when the extension lets go.
    process.stdout.on('error', () => watch.stop());
    readMessages(process.stdin, (next) => {
      if (next.type === 'notify') watch.notify(String(next.title || ''), String(next.detail || ''), next.seconds);
      else if (next.type === 'hide') watch.hide();
      else if (next.type === 'state') watch.state(next);
    }, () => watch.stop());
    await watch.done;
    // The last message ('closed') out before the host goes.
    await sendMessage({type: 'bye'});
    return;
  }

  // Host 15: one stream into mpv, with helper-fixed arguments only (playMpv). The message
  // may name the options page's mpv path; resolveMpvPath takes it only as one of the mpv
  // candidates it checks (an existing executable named mpv), so the extension never makes
  // the helper start another program.
  if (message.type === 'play') {
    const checked = checkPlayMessage(message);
    if (!checked.ok) {
      debugLog(config, 'play-refused', {error: checked.error});
      await sendMessage({ok: false, error: checked.error});
      return;
    }
    const result = await playMpv(resolveMpvPath(checked.play.mpvPath), checked.play, config);
    debugLog(config, 'played', {target: checked.play.target, result});
    await sendMessage(result);
    return;
  }

  // Host 15: allowlisted mpv commands, one answer (runIpc).
  if (message.type === 'ipc') {
    const result = await runIpc(message.commands, {pipe: ipcPipeFor(config)});
    debugLog(config, 'ipc', {ok: result.ok, error: result.error, index: result.index, reason: result.reason});
    await sendMessage(result);
    return;
  }

  // Host 15: mpv's lines to the extension and its commands to mpv, for as long as the
  // extension keeps the port open (relayMpv).
  if (message.type === 'relay') {
    const checked = checkRelayMessage(message);
    if (!checked.ok) {
      debugLog(config, 'relay-refused', {error: checked.error});
      await sendMessage({type: 'closed', reason: 'refused', error: checked.error});
      return;
    }
    /** @type {Promise<void>} */
    let last = Promise.resolve();
    const relay = relayMpv((event) => {
      // mpv's own lines (time-pos many times a second) stay out of the log.
      if (event.type !== 'mpv' && event.type !== 'mpv-reply') debugLog(config, 'relay', event);
      last = sendMessage(event);
    }, checked, {pipe: ipcPipeFor(config)});
    // The browser went while mpv plays on: as when the extension lets go (the watch's reason).
    process.stdout.on('error', () => relay.stop());
    readMessages(process.stdin, (next) => relay.receive(next), () => relay.stop());
    await relay.done;
    // The last message ('closed') out before the host goes.
    await last;
    return;
  }

  if (message.type === 'open' && typeof message.url === 'string' && message.url.length > 0) {
    if (!isStreamUrl(message.url)) {
      debugLog(config, 'refused', {url: message.url});
      await sendMessage({ok: false, error: 'mpv is only given http(s) streams'});
      return;
    }
    const mpvPath = resolveMpvPath(message.mpvPath);
    if (!mpvPath) {
      await sendMessage({ok: false, error: mpvNotFoundError(message.mpvPath)});
      return;
    }
    const result = await launchMpv(mpvPath, message, config);
    debugLog(config, 'launched', {mpvPath, url: message.url, result});
    await sendMessage(result);
    return;
  }

  await sendMessage({ok: false, error: 'unknown message'});
}

/**
 * The host: one message, then it ends - in this one place, after whatever the message
 * asked for. With an exit in each branch, CodeQL read the checks before them as input
 * deciding a sensitive action (js/user-controlled-bypass, #111 and #183): process.exit
 * is one to it, and the "check" was whether an mpv exists.
 */
async function main() {
  // A browser that went (a closed tab, an extension reload) before the answer was written:
  // the write fails, and an unhandled stdout error ended the host with a crash after its
  // work was done. The watch adds its own, which also stops the watch.
  process.stdout.on('error', () => {});
  await handleMessage();
  process.exit(0);
}

/**
 * Whether this file is the program Node runs, not a module a test suite imports.
 * Node names the program by its real path (import.meta.url) but leaves argv[1] as it was
 * given: started through a symlink (a Linux install linking the host into a folder of its
 * own) the two differed, main() never ran, and the host ended without a word.
 * @return {boolean}
 */
function isProgram() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return url.pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url;
  } catch (e) {
    return false;
  }
}

// Only run the native-messaging loop when executed directly (the .bat
// wrapper does `node faststream-mpv-host.mjs`) -- not when a test suite
// imports this module for its pure functions, which would otherwise block
// forever on main()'s stdin read.
if (isProgram()) {
  main();
}
