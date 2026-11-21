#!/usr/bin/env node
// @ts-check
// FastStream mpv native messaging host: reads one native message from the extension (4-byte
// little-endian length + JSON) and starts or drives mpv. Every answer carries hostVersion and
// capabilities.
//
// Messages:
//   {type: 'play', target, title?, start?, headers?, subtitles?, fullscreen?, newWindow?, paused?, window?,
//     mpvPath?} -> {ok, window, error?, reused?, closed?, focus?, foreground?} (checkPlayMessage, playMpv)
//   {type: 'ipc', commands (at most MaxIpcCommands), window?} -> {ok: true, replies: [{error, data}, ...]}
//     | {ok: false, error, busy?} | {ok: false, error: 'refused', index, reason} (runIpc)
//   {type: 'relay', heartbeat?: {property, everyMs}, onStop?: [commands], window?} on a port the extension
//     keeps open -> {type: 'relaying'}, then {type: 'mpv', data} for each line of mpv's; the
//     extension sends {type: 'mpv', command, id?} -> {type: 'mpv-reply', id, error, data} |
//     {type: 'mpv-refused', id, reason}; {type: 'closed', reason} last (relayMpv)
//   {type: 'raise', window?} -> {ok, closed?, busy?, error?, focus?, foreground?} (raiseMpv)
// window (host 30): which of the helper's mpv windows, by the id play's answer named; none or '' is the one on
//   the helper's own pipe. newWindow starts one with an id of its own (paused: it waits, paused and minimized,
//   not raised); play into a window that is gone answers closed and starts none.
// Older messages, still answered:
//   {type: 'ping', mpvPath?} -> {ok, mpv, path}
//   {type: 'open', url, headers?, mpvPath?, fullscreen?, singleInstance?, contentType?, pageUrl?,
//     title?, start?, subtitles?, qualities?} -> as play (launchMpv)
//   {type: 'status', waitMs?} -> {ok, running, decoder: {hardware, api, requested, format, width,
//     height} | null}
//   {type: 'watch'} on a kept-open port -> {type: 'watching'}, then {type: 'path', path},
//     {type: 'ended', path}, {type: 'request', action}, {type: 'closed', reason} last; the
//     extension sends {type: 'notify', title, detail, seconds?}, {type: 'hide'} and
//     {type: 'state', autoplay} (watchMpv)
//
// focus and foreground (Windows only): how raising mpv's window went at that moment (focusOutcome).
//
// config.json next to this script (optional): {"mpvPath", "debug", "ipcToken": "<32 hex>"}; the
// extension's mpvPath comes first. debug (or FASTSTREAM_MPV_DEBUG=1) logs to
// faststream-mpv-host.log.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {execFile, spawn} from 'child_process';
import net from 'net';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

// The extension compares it with RequiredHostVersion (chrome/background/MpvBackend.mjs). Raise it
// with every change to this file or install.ps1, with tests/unit/mpvHostVersion.test.mjs.
export const HostVersion = 31;

// The messages the extension may send; a host without this list gets the older ones. windows: play, ipc and
// relay take a window, play newWindow and paused, and raise is there (host 30).
export const Capabilities = Object.freeze(['play', 'ipc', 'relay', 'hls', 'windows']);

// No mpv path from the environment: an unchecked path would reach statSync (path injection).
const DefaultMpvPaths = [
  'C:\\Program Files\\mpv\\mpv.exe',
  'C:\\Program Files (x86)\\mpv\\mpv.exe',
  'mpv',
];

export const MaxLogBytes = 5 * 1024 * 1024;

/**
 * Only 1, true, yes or on: "0" must not switch on a log of every stream and page sent.
 * @param {string|undefined} value - The variable's value.
 * @return {boolean}
 */
export function debugFromEnvironment(value) {
  return typeof value === 'string' && /^\s*(1|true|yes|on)\s*$/i.test(value);
}

/**
 * Never writes to stdout: it carries the native messages.
 * @param {{debug?: boolean}} config - The parsed config.json.
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
 * The message for the debug log: subtitles as their count and size, not their text.
 * @param {*} message - The message read.
 * @return {*} The message to log.
 */
export function loggedMessage(message) {
  if (message && typeof message === 'object' && message.hls && typeof message.hls === 'object') {
    // Its playlists hold the stream's key in every address.
    const files = Array.isArray(message.hls.files) ? message.hls.files : [];
    message = {...message, hls: {files: files.length}};
  }
  if (!message || typeof message !== 'object' || !Array.isArray(message.subtitles)) {
    return message;
  }
  const chars = message.subtitles.reduce((/** @type {number} */ sum, /** @type {{srt?: string}} */ s) => sum + (s && typeof s.srt === 'string' ? s.srt.length : 0), 0);
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
 * Finds mpv on the PATH, as an absolute path: WMI's provider searches its own PATH, not the
 * user's. mpv.exe on Windows, as PATHEXT order would find mpv.com, the console wrapper.
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

// UNC or device path: a mere stat signs in to a UNC host with the user's credentials.
const NetworkOrDevicePath = /^[\\/]{2}/;

/**
 * Whether a file name is an mpv the host may start (mpv, mpv.exe, mpv-x86_64.exe): the path comes
 * from the options page and must not make the host run any program. On Windows only .exe or .com:
 * a .bat or .cmd runs through cmd.exe, which reads the arguments again (& | %VAR%).
 * @param {string} name - The file name.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @return {boolean}
 */
export function isMpvExecutableName(name, platform = process.platform) {
  return platform === 'win32' ? /^mpv[\w.-]*\.(exe|com)$/i.test(name) : /^mpv[\w.-]*$/i.test(name);
}

/**
 * The GUI build beside a console wrapper (mpv.exe for mpv.com): the wrapper's process has no
 * window for the focus script, and started through WMI it opens a console.
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
 * The first usable mpv candidate, as an absolute path (WMI resolves a relative one against its
 * own working directory).
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
 * @param {Object} message - The answer.
 * @return {Object} The answer with hostVersion and capabilities.
 */
export function withHostVersion(message) {
  return {...message, hostVersion: HostVersion, capabilities: [...Capabilities]};
}

/**
 * Writes one native-messaging frame; resolves once flushed: stdout is a pipe, and an exit before
 * the flush truncates the reply.
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

// The length prefix decides the allocation, so a bigger frame is refused, not allocated.
export const MaxMessageBytes = 16 * 1024 * 1024;

// readMessage's result for a frame over MaxMessageBytes, which is answered with an error.
export const TooLarge = Symbol('message too large');

// Bytes readMessage read past its frame, by stream: the next frame's start, for readMessages.
const unread = new WeakMap();

/**
 * Reads one native-messaging frame. One over MaxMessageBytes is read to its end unkept, so the
 * browser finishes writing it before the host answers and exits.
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

    const finish = (/** @type {Object|typeof TooLarge|null} */ result) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onEnd);
      resolve(result);
    };

    const onData = (/** @type {Buffer} */ chunk) => {
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
 * Where mpv's JSON IPC server listens: a named pipe on Windows, a Unix socket elsewhere. Only mpv
 * instances this host starts have it, so an mpv the user started is never loaded into or closed.
 * Windows has one pipe namespace per machine: another account that made the pipe first would get
 * every URL and header and could fake success, so the name carries config.json's random ipcToken.
 * Elsewhere the socket goes in $XDG_RUNTIME_DIR, else the temp folder.
 * A window of the helper's other than the first (newWindow) has the same name and its id after it.
 * @param {{ipcToken?: string}} config - The parsed config.json.
 * @param {string} [platform] - process.platform, or a stand-in.
 * @param {Object<string, string|undefined>} [env] - The environment.
 * @param {string} [window] - The window's id (WindowId), or '' for the helper's own pipe.
 * @return {string} The pipe or socket.
 */
export function ipcPipeFor(config, platform = process.platform, env = process.env, window = '') {
  if (window !== '' && !WindowId.test(window)) {
    throw new Error('not a window id');
  }
  const suffix = window ? '-' + window : '';
  if (platform === 'win32') {
    const token = config && typeof config.ipcToken === 'string' && /^[0-9a-f]{32}$/.test(config.ipcToken) ?
      '-' + config.ipcToken : '';
    return '\\\\.\\pipe\\faststream-mpv' + token + suffix;
  }
  const user = typeof process.getuid === 'function' ? process.getuid() : 0;
  // The token here too: without $XDG_RUNTIME_DIR the socket is in a shared temp folder.
  const token = config && typeof config.ipcToken === 'string' && /^[0-9a-f]{32}$/.test(config.ipcToken) ?
    '-' + config.ipcToken : '';
  const name = `faststream-mpv-${user}${token}${suffix}.sock`;
  const socket = path.posix.join(env.XDG_RUNTIME_DIR || env.TMPDIR || os.tmpdir(), name);
  // In macOS's temp folder the path came to about 106 bytes, too long for a socket: /tmp then,
  // where the token keeps the name unguessable.
  return Buffer.byteLength(socket, 'utf8') > MaxSocketPathBytes ? path.posix.join('/tmp', name) : socket;
}

// The longest Unix socket path (sockaddr_un's sun_path: 104 bytes on macOS, its NUL included).
export const MaxSocketPathBytes = 103;

// A window's id: the helper makes it (newWindow), the extension only names it back. Hex only, so it is never
// more than a suffix of the helper's own pipe name.
export const WindowId = /^[0-9a-f]{16}$/;

/**
 * A message's window, checked: '' for none (the helper's own pipe), else a WindowId.
 * @param {*} value - The message's window field.
 * @return {{ok: true, window: string}|{ok: false, error: string}}
 */
export function checkWindow(value) {
  if (value === undefined || value === null || value === '') {
    return {ok: true, window: ''};
  }
  return typeof value === 'string' && WindowId.test(value) ? {ok: true, window: value} :
    {ok: false, error: 'the window is not one of the helper\'s'};
}

// How long the focus script waits for a new mpv's window: half of mpv's 60 s --network-timeout.
const WindowWaitSeconds = 30;

// Headroom for PowerShell's start, the Add-Type compile and the focus retries.
const PowerShellTimeoutMs = (WindowWaitSeconds + 15) * 1000;

// An open mpv's window exists already; one not found within seconds stays so, and a longer wait
// only delays the answer the extension pauses the page on.
export const ReusedWindowWaitSeconds = 5;

// The connect did not finish in time: on Windows a pipe whose mpv takes no connection (its one instance in use)
// keeps a connect waiting. The helper's own window then gets a fresh mpv; another window is busy, not closed.
const StalledError = 'mpv ipc timeout';

/**
 * Sends commands to the mpv instance listening on our pipe.
 * @param {Array<Object>} commands - mpv JSON IPC commands, in order.
 * @param {number} [timeoutMs] - How long to wait for the pipe.
 * @param {number} [replyTimeoutMs] - How long a connected mpv gets to answer: opening a slow
 *   stream holds it up for seconds.
 * @param {string} [pipe] - The pipe; ours by default (tests use their own).
 * @return {Promise<{ok: boolean, replies?: Array<Object>, error?: string, busy?: boolean}>}
 *   ok:false without busy: no instance of ours runs; busy: one runs and did not answer in time
 *   (a second one on the same pipe would get no IPC).
 */
export function mpvIpcRequest(commands, timeoutMs = 1500, replyTimeoutMs = 6000, pipe = ipcPipeFor(readConfig())) {
  return new Promise((resolve) => {
    let settled = false;
    const replies = /** @type {Object[]} */ ([]);
    let buffer = '';

    const socket = net.connect(pipe);
    // Decoded as a stream: a character mpv sends in two chunks stays one character.
    socket.setEncoding('utf8');

    const finish = (/** @type {{ok: boolean, replies?: Array<Object>, error?: string, busy?: boolean}} */ value) => {
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
        finish({ok: false, error: StalledError});
      }
    };
    let timer = setTimeout(giveUp, timeoutMs);

    // Any connect error, a stale pipe's too: no mpv of ours runs.
    socket.on('error', () => finish({ok: false, error: 'no mpv ipc'}));
    // An mpv that quits as the commands arrive closes the pipe: gone, not busy, even after a
    // first answer.
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

// How often watchMpv tells mpv it still follows the window.
export const HeartbeatMs = 30000;

// The longest a notice stays in mpv, and how long mpv's own text stays without notify.lua.
export const MaxNoticeSeconds = 60;
const DefaultTextSeconds = 4;
// How close to its end mpv may stop, paused or after a seek, and it is the end (watchMpv).
const EndSlackSeconds = 0.5;

/**
 * A notice's seconds: above 0, at most MaxNoticeSeconds, to a tenth; undefined otherwise.
 * @param {*} seconds - What the extension sent.
 * @return {number|undefined}
 */
export function noticeSeconds(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(Math.min(seconds, MaxNoticeSeconds) * 10) / 10 || undefined;
}

// The script messages mpv's keys, buttons and menu send (input.conf: "n script-message
// faststream-next"); mpv gives them to every IPC client.
export const EpisodeMessages = {
  'faststream-next': 'next',
  'faststream-previous': 'previous',
  'faststream-autoplay': 'autoplay',
};

/**
 * Follows the mpv on our pipe over a port the extension keeps open: file ends and the
 * next/previous/autoplay keys go to the extension as they happen (MPV autoplay).
 * An end: eof-reached going false -> true (keep-open), an end-file "eof", or mpv paused or a seek
 * landing within EndSlackSeconds of the end (an HLS stream with discontinuities stops there
 * without eof-reached). The first observed values are mpv's state at the start, not events.
 * user-data/faststream/connected shows mpv's episode buttons; the heartbeat (a rising time every
 * HeartbeatMs) lets the mpv setup hide them after 90 s still, as a host killed hard clears nothing.
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
  // endCheck's requests by id; whether the first pause value (mpv's state at the start) came.
  const endChecks = new Set();
  let pauseSeen = false;
  // Notices by request id: one notify.lua refused (not installed) is shown with show-text.
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
    // Strictly rising, even with two beats in one millisecond.
    lastBeat = Math.max(Date.now(), lastBeat + 1);
    write(['set_property', 'user-data/faststream/heartbeat', lastBeat]);
  };
  const finish = (/** @type {string} */ reason) => {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    try {
      if (reason === 'stopped' && socket.writable) {
        // The extension let go, mpv runs on: its episode buttons go. end() sends the line before
        // it closes; destroy() could drop it.
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
  // Asks mpv how much of its file is left: within EndSlackSeconds is an end.
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
          // Between two files (loadfile replace): the same file again ends again.
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
        const action = /** @type {'next'|'previous'|'autoplay'} */ (EpisodeMessages[/** @type {keyof typeof EpisodeMessages} */ (event.args[0])]);
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
      // Plain text only: without notify.lua this is show-text, which expands ${...}.
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
    state(/** @type {{autoplay?: boolean}} */ state) {
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
  const onData = (/** @type {Buffer} */ chunk) => {
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
 * Appends a key=value tag to a URL's fragment: never sent to the server, so a signed URL still
 * works, and mpv's scripts read it from the `path` property.
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
 * Drops fs-* tags the stream URL already has: a page can choose the URL, and a forged fs-id= or
 * fs-page= would move another site's resume position or "Site page" link.
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

// Checked again here, as anything that talks to the host gets this far.
const RelayHeaderNames = /^(referer|origin|user-agent)$/i;

// Printable ASCII only: no CR/LF (a second header), no NUL, none of the typographic quotes
// PowerShell takes as quote characters.
const RelayHeaderValue = /^[ -~]{1,4096}$/;

/**
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
 * Whether a URL may go to mpv: http(s) only, as mpv also opens local files and UNC paths (a UNC
 * path signs in to its host with the user's credentials). The string itself must start with the
 * scheme: the URL parser reads `https:\\host\share` as https://host/share.
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
 * @param {string} streamUrl - The stream URL headed to mpv.
 * @param {string} [contentType] - 'anime', 'movie' or 'native' (no upscaler); anything else is a
 *   no-op and streamUrl is returned unchanged.
 * @return {string} The URL, with the marker appended when contentType is set.
 */
export function withContentTypeFragment(streamUrl, contentType) {
  if (contentType !== 'anime' && contentType !== 'movie' && contentType !== 'native') {
    return streamUrl;
  }
  return withFragmentTag(streamUrl, `fs-content=${contentType}`);
}

/**
 * The resume key for a page: the first 16 hex digits of its URL's sha256.
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
 * A page URL percent-encoded as one fragment tag value (fs-page=); http(s) pages only.
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

// The most qualities taken, and the longest URL of one (MpvBackend.relayQualities).
const MaxQualities = 12;
const MaxQualityUrlChars = 2048;

/**
 * The page player's qualities as an fs-quality= value for faststream-quality.lua: percent-encoded
 * JSON [{label, height, url}], at least two. Checked again here: http(s) URLs (isStreamUrl) with
 * no fragment (the script matches mpv's path up to its first '#'), labels in whole characters.
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
 * The open message (the list at the top of this file).
 * @typedef {{url: string, headers?: Object<string, string>, title?: string,
 *   fullscreen?: boolean, singleInstance?: boolean, contentType?: string,
 *   pageUrl?: string, start?: number, subtitles?: Array<{srt: string,
 *   label?: string}>, qualities?: Array<{url: string, label?: string,
 *   height?: number}>}} OpenMessage
 */
/**
 * The URL for mpv: the stream URL as the URL parser writes it (it drops tabs and newlines
 * isStreamUrl never saw, and percent-encodes what a request line cannot carry), and fs-* fragment
 * tags for mpv's scripts, never sent to the server: fs-content= (gpu-toggles.lua), fs-id=
 * (stream-resume.lua's key: a hash of the page URL, as the stream URL's token changes), fs-page=
 * (source-info.lua) and fs-quality= (faststream-quality.lua).
 * @param {OpenMessage} message - The open message from the extension; its url passed
 *   isStreamUrl.
 * @return {string} The URL for mpv.
 */
export function mpvTargetUrl(message) {
  const target = withContentTypeFragment(withoutFsTags(new URL(message.url).href), message.contentType);
  const resumeId = resumeIdFor(message.pageUrl);
  const withId = resumeId ? withFragmentTag(target, `fs-id=${resumeId}`) : target;
  const pageFragment = pageFragmentFor(message.pageUrl);
  const withPage = pageFragment ? withFragmentTag(withId, `fs-page=${pageFragment}`) : withId;
  // fs-quality= last: it is the longest.
  const qualities = qualityFragmentFor(message.qualities);
  return qualities ? withFragmentTag(withPage, `fs-quality=${qualities}`) : withPage;
}

// What a send may carry with a stream, checked again here.
const MaxSubtitles = 8;
const MaxSubtitleChars = 1024 * 1024;
// The folders the subtitles are written into, one per send, in the user's temp folder.
export const SubtitleDirPrefix = 'faststream-mpv-subs-';
// A private window's: mpv-config's faststream-private.lua removes its files once mpv moved on from the stream.
export const PrivateSubtitleDirPrefix = SubtitleDirPrefix + 'p-';
// mpv reads a subtitle file when it loads the stream; older folders are removed.
const SubtitleDirMaxAgeMs = 24 * 60 * 60 * 1000;
// A private window's, should no mpv remove them: PrivateHlsDirMaxAgeMs's reasoning.
const PrivateSubtitleDirMaxAgeMs = 2 * 60 * 1000;

/**
 * Whether a play message's target comes from a private window (its fs-private tag).
 * @param {string} target - checkPlayMessage took it for a URL.
 * @return {boolean}
 */
function isPrivateTarget(target) {
  try {
    return new URL(target).hash.slice(1).split('&').includes('fs-private=1');
  } catch (e) {
    return false;
  }
}

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
 * Removes the subtitle folders past their age: a day, a private window's two minutes (as its playlists: mpv has
 * read them by then). One that cannot be removed (another user's) stays.
 * @param {string} [base] - The folder they are in; the temp folder by default.
 * @param {number} [now]
 */
export function removeOldSubtitleDirs(base = os.tmpdir(), now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, {withFileTypes: true});
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SubtitleDirPrefix)) continue;
    const dir = path.join(base, entry.name);
    const maxAge = entry.name.startsWith(PrivateSubtitleDirPrefix) ? PrivateSubtitleDirMaxAgeMs : SubtitleDirMaxAgeMs;
    try {
      if (now - fs.statSync(dir).mtimeMs > maxAge) fs.rmSync(dir, {recursive: true, force: true});
    } catch (e) {
      // The next one still goes.
    }
  }
}

/**
 * Writes subtitles into a fresh mkdtemp folder for mpv, after removing old such folders. The file name is what
 * mpv's track list shows.
 * @param {Array<{srt: string, label: string}>} subtitles - From subtitlesOf.
 * @param {string} [base] - The folder to write under; the temp folder by default.
 * @param {boolean} [isPrivate] - A private window's: the folder is named for mpv to remove (PrivateSubtitleDirPrefix).
 * @return {Array<string>} The files, in order.
 * @throws {Error} When a file cannot be written; nothing is left.
 */
export function writeSubtitleFiles(subtitles, base = os.tmpdir(), isPrivate = false) {
  if (subtitles.length === 0) {
    return [];
  }
  removeOldSubtitleDirs(base);
  const dir = fs.mkdtempSync(path.join(base, isPrivate ? PrivateSubtitleDirPrefix : SubtitleDirPrefix));
  try {
    return subtitles.map((s, i) => {
      const label = s.label.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      const file = path.join(dir, `${i + 1}${label ? ' ' + label : ''}.srt`);
      fs.writeFileSync(file, s.srt, 'utf8');
      return file;
    });
  } catch (e) {
    fs.rmSync(dir, {recursive: true, force: true});
    throw e;
  }
}

/**
 * Removes the folder of writeSubtitleFiles' files, when no mpv will read them.
 * @param {Array<string>} files - writeSubtitleFiles'.
 */
function removeSubtitleFiles(files) {
  if (files.length === 0) return;
  try {
    fs.rmSync(path.dirname(files[0]), {recursive: true, force: true});
  } catch (e) {
    // The next helper to end removes it by its age.
  }
}

// An HLS stream mpv cannot open from its address (docs/notes/mpv.md, "Streams mpv cannot open alone"): the
// extension sends its playlists with every address made whole, and mpv plays them from files.
export const HlsDirPrefix = 'faststream-mpv-hls-';
// ffmpeg reads a stream's playlists once, when it opens it; older folders are removed whenever the helper ends.
// A private window's (fs-private: its addresses are browsing history) once mpv moved on from it or closed
// (privatePackageWatch here, mpv-config's faststream-private.lua there), else two minutes on: longer than a play
// waits before mpv opens it (LaunchLockMs).
const HlsDirMaxAgeMs = 2 * 24 * 60 * 60 * 1000;
const PrivateHlsDirPrefix = HlsDirPrefix + 'p-';
const PrivateHlsDirMaxAgeMs = 2 * 60 * 1000;
// Formats ffmpeg may read while the stream plays: none but HLS (checkHlsPackage) opens a file it names, and srt
// for the page's subtitles (a forced hls format took them as playlists too).
const HlsFormats = '[hls,mpegts,mov,aac,mp3,ac3,eac3,webvtt,srt]';
const MaxHlsFiles = 32;
export const MaxHlsBytes = 12 * 1024 * 1024;
// The entry first: a master names the others by these names, which resolve to its own folder.
const HlsFileName = /^(?:master|\d{1,2})\.m3u8$/;
// ffmpeg reads a playlist's line into 4096 bytes and drops what is past them, up to the line's end (measured:
// docs/notes/mpv.md, host 28).
const FfmpegLineBytes = 4095;

/**
 * A playlist's line as ffmpeg reads it: its first 4095 bytes, without the spaces of ASCII at their end. Any other
 * space (a no-break space) stays part of an address. Of a character those bytes end inside, ffmpeg keeps the first
 * bytes; the line here ends in a replacement character instead, which no check takes otherwise.
 * @param {string} line
 * @return {string}
 */
function ffmpegLine(line) {
  let read = line;
  if (line.length * 3 > FfmpegLineBytes) {
    const bytes = Buffer.from(line, 'utf8');
    if (bytes.length > FfmpegLineBytes) read = bytes.subarray(0, FfmpegLineBytes).toString('utf8');
  }
  let end = read.length;
  while (end > 0 && ' \t\n\v\f\r'.includes(read[end - 1])) end--;
  return read.slice(0, end);
}

/**
 * @param {string} text
 * @return {boolean} Whether ffmpeg takes the text for a playlist: its first line is #EXTM3U and nothing more.
 */
function startsAsPlaylist(text) {
  const end = text.search(/[\r\n]/);
  return ffmpegLine(end < 0 ? text : text.slice(0, end)) === '#EXTM3U';
}

/**
 * A tag's attributes as ffmpeg reads them (ff_parse_key_value): a key after spaces or commas, up to its '=';
 * its value quoted, a backslash keeping the character after it, or up to a space or comma.
 * @param {string} text - What follows the tag's ':'.
 * @return {Array<{key: string, value: string}>}
 */
export function ffmpegAttributes(text) {
  const isSpace = (/** @type {string} */ c) => ' \t\n\v\f\r'.includes(c);
  const attributes = [];
  let at = 0;
  for (;;) {
    while (at < text.length && (isSpace(text[at]) || text[at] === ',')) at++;
    if (at >= text.length) break;
    const equals = text.indexOf('=', at);
    if (equals < 0) break;
    const key = text.slice(at, equals);
    at = equals + 1;
    let value = '';
    if (text[at] === '"') {
      at++;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\') {
          if (at + 1 >= text.length) break;
          value += text[at + 1];
          at += 2;
        } else {
          value += text[at++];
        }
      }
      if (text[at] === '"') at++;
    } else {
      while (at < text.length && !isSpace(text[at]) && text[at] !== ',') value += text[at++];
    }
    attributes.push({key, value});
  }
  return attributes;
}

/**
 * Every address a playlist names that ffmpeg could open: its lines that are no tag, and every tag's URI attribute,
 * also with the key in small letters or with spaces around it. ffmpeg reads fewer of them (docs/notes/mpv.md, host
 * 28); the check is of what it could.
 * @param {string} text
 * @return {?Array<{address: string, tag: ?string}>} tag: the tag of a URI attribute, null for a line that is no
 *   tag; null for a playlist with a backslash or a line ffmpeg and this would read differently (leading spaces).
 */
export function hlsAddresses(text) {
  const addresses = [];
  for (const written of text.split(/\r\n|\r|\n/)) {
    if (!written) continue;
    if (written !== written.trimStart() || written.includes('\\')) return null;
    const line = ffmpegLine(written);
    if (!line.startsWith('#')) {
      addresses.push({address: line, tag: null});
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    for (const {key, value} of ffmpegAttributes(line.slice(colon + 1))) {
      if (key.trim().toUpperCase() === 'URI') addresses.push({address: value, tag: line.slice(0, colon)});
    }
  }
  return addresses;
}

/**
 * @param {string} address
 * @return {boolean}
 */
function isPlainStreamUrl(address) {
  if (!/^https?:\/\//i.test(address) || !isStreamUrl(address) || !isPlainText(address, 8192)) return false;
  const url = new URL(address);
  return !url.username && !url.password;
}

/**
 * Checks the playlists of a play message's hls. ffmpeg is given http(s) addresses only, from complete media
 * playlists; a master, the first file, names only the others (its variants and renditions) and nothing else.
 * @param {*} hls - {files: [{name, text}]}, the entry first.
 * @return {{ok: true, files: Array<{name: string, text: string}>}|{ok: false, error: string}}
 */
export function checkHlsPackage(hls) {
  const refuse = (/** @type {string} */ error) => ({ok: /** @type {false} */ (false), error});
  const files = hls?.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MaxHlsFiles) {
    return refuse('the HLS playlists are not a list of 1 to 32 files');
  }
  const names = new Set();
  let bytes = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || typeof file.name !== 'string' || !HlsFileName.test(file.name) ||
        names.has(file.name) || typeof file.text !== 'string') {
      return refuse('an HLS playlist has no name of its own');
    }
    names.add(file.name);
    bytes += Buffer.byteLength(file.text, 'utf8');
    if (bytes > MaxHlsBytes) {
      return refuse('the HLS playlists are too large');
    }
    if (!startsAsPlaylist(file.text) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(file.text)) {
      return refuse('an HLS playlist is no playlist text');
    }
  }
  const master = files[0].name === 'master.m3u8';
  if (!master && files.length > 1) {
    return refuse('HLS playlists beside the first need a master to name them');
  }
  const named = new Set();
  for (const [index, file] of files.entries()) {
    const addresses = hlsAddresses(file.text);
    if (!addresses) {
      return refuse('an HLS playlist has a line ffmpeg could read otherwise');
    }
    if (index === 0 && master) {
      for (const {address, tag} of addresses) {
        if ((tag !== null && tag !== '#EXT-X-MEDIA') || address === file.name || !names.has(address)) {
          return refuse('an HLS master names something that is not one of its playlists');
        }
        named.add(address);
      }
      continue;
    }
    const lines = file.text.split(/\r\n|\r|\n/);
    if (!lines.includes('#EXT-X-ENDLIST') ||
        lines.some((/** @type {string} */ line) => /^#EXT-X-(STREAM-INF|MEDIA|I-FRAME-STREAM-INF):/.test(line))) {
      return refuse('an HLS playlist is no complete media playlist');
    }
    if (!addresses.every(({address}) => isPlainStreamUrl(address))) {
      return refuse('an HLS playlist names something that is not an http(s) address');
    }
  }
  if (master && files.slice(1).some((file) => !named.has(file.name))) {
    return refuse('an HLS playlist is not named by its master');
  }
  return {ok: true, files: files.map((file) => ({name: file.name, text: file.text}))};
}

/**
 * Per file for the playlists' entry: read by ffmpeg, never as mpv's own playlist, which opens each line as a file.
 * Files only for a master's playlists, beside it.
 * @param {string} entry
 * @return {Object<string, string>}
 */
export function hlsPlayOptions(entry) {
  const protocols = path.basename(entry) === 'master.m3u8' ? '[file,http,https,tcp,tls,crypto]' : '[http,https,tcp,tls,crypto]';
  return {'demuxer': 'lavf', 'demuxer-lavf-o': `protocol_whitelist=${protocols},format_whitelist=${HlsFormats}`};
}

/**
 * Removes the playlist folders past their age; one that cannot be removed (another user's) stays.
 * @param {string} [base] - The folder they are in; the temp folder by default.
 * @param {number} [now]
 */
export function removeOldHlsPackages(base = os.tmpdir(), now = Date.now()) {
  let entries = [];
  try {
    entries = fs.readdirSync(base, {withFileTypes: true});
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(HlsDirPrefix)) continue;
    const dir = path.join(base, entry.name);
    const maxAge = entry.name.startsWith(PrivateHlsDirPrefix) ? PrivateHlsDirMaxAgeMs : HlsDirMaxAgeMs;
    try {
      if (now - fs.statSync(dir).mtimeMs > maxAge) fs.rmSync(dir, {recursive: true, force: true});
    } catch (e) {
      // The next one still goes.
    }
  }
}

/**
 * A private window's playlist folder goes once mpv no longer plays it: when its path, as the relay passes it on,
 * moves to another file (none between two files counts for nothing), or mpv closes. Not when the extension lets go: a new hand-off's package may not be open yet.
 * @param {string} [base] - The folder the packages are in; the temp folder by default.
 * @return {{see: (event: *) => void, end: (reason: string) => void}} see: each event the relay sends; end: its
 *   reason for closing.
 */
export function privatePackageWatch(base = os.tmpdir()) {
  /** @type {?string} */
  let playing = null;
  /** @param {string} entry */
  const remove = (entry) => {
    const dir = path.dirname(entry);
    if (path.dirname(dir) !== path.resolve(base) || !path.basename(dir).startsWith(PrivateHlsDirPrefix)) return;
    try {
      fs.rmSync(dir, {recursive: true, force: true});
    } catch (e) {
      // Removed by age later.
    }
  };
  return {
    see(event) {
      const data = event && event.type === 'mpv' ? event.data : null;
      if (!data || data.event !== 'property-change' || data.name !== 'path') return;
      // None between two files (mpv clears it), the same file loaded again included.
      if (typeof data.data !== 'string') return;
      if (playing && playing !== data.data) remove(playing);
      playing = data.data;
    },
    end(reason) {
      if (reason === 'mpv closed' && playing) remove(playing);
    },
  };
}

/**
 * A master for the folder it is written into. ffmpeg resolves a playlist's name against the master's own address
 * up to a '#' or '?', so with one in the folder's path (a Windows account's name) the names led beside the folder
 * the path was cut at: there they become whole paths, which ffmpeg opens as written.
 * @param {string} text - The master, naming its playlists by their file names (checkHlsPackage).
 * @param {string} dir - The folder.
 * @param {{join: (...parts: Array<string>) => string, sep: string, isAbsolute: (dir: string) => boolean}} [paths] -
 *   A stand-in for tests; this system's by default.
 * @return {?string} null when the result would not read, to ffmpeg, as exactly those paths: an unquoted URI, a
 *   line longer than ffmpeg reads, a path that cannot stand in a quoted value, a folder that is no whole path.
 */
export function hlsMasterIn(text, dir, paths = path) {
  if (!/[#?]/.test(dir)) return text;
  if (!paths.isAbsolute(dir)) return null;
  const whole = (/** @type {string} */ name) => paths.join(dir, name).split(paths.sep).join('/');
  const named = hlsAddresses(text);
  const written = text.split(/(\r\n|\r|\n)/).map((line, index) => {
    if (index % 2 === 1 || !line) return line;
    if (!line.startsWith('#')) return HlsFileName.test(ffmpegLine(line)) ? whole(ffmpegLine(line)) : line;
    return line.replace(/(URI=")(\d{1,2}\.m3u8)(")/g, (_, open, name, close) => open + whole(name) + close);
  }).join('');
  const read = hlsAddresses(written);
  return named && read && read.length === named.length &&
    read.every(({address}, index) => address === whole(named[index].address)) ? written : null;
}

/**
 * Writes the playlists into a fresh mkdtemp folder, after removing old ones, with target.txt: the stream as sent,
 * for mpv's scripts (its fs-* tags).
 * @param {Array<{name: string, text: string}>} files - From checkHlsPackage, the entry first.
 * @param {string} target - The play message's target.
 * @param {string} [base] - The folder to write under; the temp folder by default.
 * @return {string} The entry's file.
 * @throws {Error} When a file cannot be written, or the master not for this folder (hlsMasterIn); nothing is left.
 */
export function writeHlsPackage(files, target, base = os.tmpdir()) {
  removeOldHlsPackages(base);
  const dir = fs.mkdtempSync(path.join(base, isPrivateTarget(target) ? PrivateHlsDirPrefix : HlsDirPrefix));
  try {
    for (const file of files) {
      const text = file.name === 'master.m3u8' ? hlsMasterIn(file.text, dir) : file.text;
      if (text === null) {
        throw new Error('the temp folder\'s path has a \'#\' or \'?\', and this master playlist cannot be written for such a path');
      }
      fs.writeFileSync(path.join(dir, file.name), text, 'utf8');
    }
    fs.writeFileSync(path.join(dir, 'target.txt'), target, 'utf8');
  } catch (e) {
    try {
      fs.rmSync(dir, {recursive: true, force: true});
    } catch (e2) {
      // It goes by its age.
    }
    throw e;
  }
  return path.join(dir, files[0].name);
}

/**
 * Escapes one item of an mpv string list: a '\' before a ',' makes the comma part of the item,
 * and mpv removes no other backslash. split/join, as CodeQL reads a replace() that inserts '\'
 * as incomplete escaping.
 * @param {string} item - The item.
 * @return {string} The escaped item.
 */
function listItem(item) {
  return item.split(',').join('\\,');
}

/**
 * mpv's per-file options for one stream: loadfile's options (or a --{ ... --} group) go with that
 * file only, so the next file in the window gets neither this site's headers nor its title, and
 * two sends at once cannot mix them (mpv 0.41, measured).
 * A header ending in a backslash is left out: mpv reads it and the separator after it as an
 * escaped comma and joins the next header to it.
 * sub-files is a path list: the system's delimiter, backslashes kept; a path holding the
 * delimiter is left out.
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
 * @param {OpenMessage} message - The open message from the extension.
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
 * Loads a URL with its per-file options into the mpv on a pipe (loadIntoExisting, playMpv).
 * @param {string} target - The URL for mpv.
 * @param {Object<string, string>} options - loadfile's options (perFileOptions).
 * @param {boolean} fullscreen - Whether to make the window fullscreen first.
 * @param {(commands: Array<Object>) => ReturnType<typeof mpvIpcRequest>} ipcRequest - The
 *   transport, bound to its pipe.
 * @return {Promise<{ok: boolean, pid?: number, busy?: boolean, stalled?: boolean, refused?: boolean,
 *   error?: string}>} As loadIntoExisting.
 */
export async function loadInto(target, options, fullscreen, ipcRequest) {
  /** @type {Array<{command: *}>} */
  const commands = [];
  if (fullscreen) {
    commands.push({command: ['set_property', 'fullscreen', true]});
  }
  // Named arguments and no index: loadfile's options follow its index from mpv 0.38 on, and an
  // mpv before 0.38 (Ubuntu 24.04: 0.37) refuses a command with one.
  commands.push({command: {
    name: 'loadfile',
    url: target,
    flags: 'replace',
    options,
  }});
  commands.push({command: ['get_property', 'pid']});

  const result = await ipcRequest(commands);
  if (!result.ok) {
    // stalled: nothing was written (StalledError).
    return result.busy ? {ok: false, busy: true} : {ok: false, ...(result.error === StalledError ? {stalled: true} : {})};
  }

  // The loadfile reply decides: mpvIpcRequest's timeout resolves ok with any reply in. Without it
  // the load is unconfirmed, and ours runs (it answered): busy, not "start another".
  const replies = /** @type {Array<{request_id: number, error?: string, data?: *}>} */ (result.replies || []);
  const loadReply = replies.find((r) => r.request_id === commands.length - 1);
  if (!loadReply) {
    return {ok: false, busy: true};
  }
  if (loadReply.error && loadReply.error !== 'success') {
    // Ours runs, so a fresh start would be a second mpv without the pipe. mpv 0.41 answers success
    // even to a bad option value, so an error is about the command itself.
    return {ok: false, refused: true, error: String(loadReply.error)};
  }

  const pidReply = replies.find((r) => r.request_id === commands.length);
  return {
    ok: true,
    pid: pidReply && typeof pidReply.data === 'number' ? pidReply.data : undefined,
  };
}

// How long a status message may wait: until a slow stream opens, mpv names no decoder.
export const MaxStatusWaitMs = 30000;
const StatusPollMs = 1000;

// What mpv is asked about its video decoder, in this order (decoderFromReplies).
const DecoderProperties = ['hwdec-current', 'hwdec', 'video-format', 'width', 'height'];

/**
 * Reads mpv's answers about its video decoder. hwdec-current is the API in use ("d3d11va",
 * "nvdec", "-copy" forms), "no" in software, unavailable while no video decoder is loaded.
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
    const reply = /** @type {Array<{request_id: number, error?: string, data?: *}>} */ (replies || []).find((r) => r && r.request_id === index + 1);
    return reply && (reply.error === undefined || reply.error === 'success') ? reply.data : undefined;
  };
  const api = value(0);
  if (typeof api !== 'string' || !api) {
    return null;
  }
  const text = (/** @type {*} */ v) => (typeof v === 'string' && v ? v : null);
  const size = (/** @type {*} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
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
 * Asks the mpv on our pipe which video decoder it uses, waiting up to waitMs for one. An mpv
 * the user started has no pipe: "not running".
 * @param {number} [waitMs] - How long to keep asking while mpv has no decoder yet (none: 0).
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
 * PowerShell that shows a window, restoring a minimised one (SW_RESTORE 9; SW_SHOW 5 leaves it in
 * the taskbar). ShowWindowAsync, not ShowWindow: windowsHide puts SW_HIDE in PowerShell's
 * STARTUPINFO, and Windows applies it to the process's first ShowWindow call, hiding mpv.
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
 * PowerShell that waits for a process's window and pulls it to the front. A process the WMI
 * service creates may not take the foreground (mpv's --focus-on=open is refused); attaching to
 * the foreground thread's input queue makes SetForegroundWindow work.
 * @param {string} pidExpr - PowerShell expression holding the process id.
 * @param {number} waitSeconds - How long to wait for the window: WindowWaitSeconds for an
 *   mpv just started, ReusedWindowWaitSeconds for one already open.
 * @param {boolean} [raise] - false: only waits for the window (a quit still shows), and leaves it where mpv put
 *   it: FOCUS=kept (a paused new window, which waits minimized).
 * @return {Array<string>} Script lines.
 */
function focusWindowLines(pidExpr, waitSeconds, raise = true) {
  const pull = raise ? [
    '      $null = [FSFg]::AllowSetForegroundWindow([int]' + pidExpr + ')',
    // Retried: the foreground owner can change between AttachThreadInput and SetForegroundWindow.
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
  ] : [
    '      Write-Output "FOCUS=kept"',
  ];
  return [
    '  try {',
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
    // Seen, then gone before it had a window: mpv quit at once. The first look almost always
    // finds it still starting, so "never seen" alone misses such quits.
    '      if ($seen -and -not $p) { $quit = $true; break }',
    // Never seen: it quit before the first look. Stop after about 2 s.
    '      if (-not $seen -and $misses -ge 20) { break }',
    '      Start-Sleep -Milliseconds 100',
    '    }',
    '    if ($h -ne [IntPtr]::Zero) {',
    ...pull,
    '    } elseif (-not $seen) { Write-Output "FOCUS=gone" }',
    '    elseif ($quit) { Write-Output "FOCUS=quit" }',
    '    else { Write-Output "FOCUS=nowindow" }',
    '  } catch { Write-Output "FOCUS=error" }',
  ];
}

/**
 * Runs a PowerShell script and returns its stdout. The script must be fixed text, data passed in
 * `env` and read as $env:NAME: a single-quoted string also ends at the typographic quotes
 * U+2018-U+201B, so escaping `'` alone let a header value run code.
 * @param {Array<string>} lines - Script lines.
 * @param {number} timeoutMs - Kill the shell after this long.
 * @param {Object<string, string>} [env] - Extra environment variables for the script.
 * @return {Promise<string>} Captured stdout; after a failure (a timeout, PowerShell or WMI
 *   refusing), an ERROR= line with the reason.
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
 * The PowerShell that starts mpv through WMI and focuses its window (or, raise false, only waits for it). Fixed
 * text: the command line is read from the environment (CommandLineEnv).
 * @param {boolean} [raise] - focusWindowLines'.
 * @return {Array<string>} Script lines.
 */
export function wmiLaunchLines(raise = true) {
  return [
    ...focusApiLines(),
    ...(raise ? ['try { $null = [FSFg]::AllowSetForegroundWindow(-1) } catch {}'] : []),
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ' +
      '-Arguments @{CommandLine=$env:' + CommandLineEnv + '}',
    'Write-Output ("RC=" + $r.ReturnValue + " PID=" + $r.ProcessId)',
    'if ($r.ReturnValue -eq 0) {',
    ...focusWindowLines('$r.ProcessId', WindowWaitSeconds, raise),
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

/**
 * The answer when an open mpv was asked to take the stream (launchMpv, playMpv): it took it
 * (its window raised), refused it, or was too busy to answer; null when there was none.
 * @param {{ok: boolean, pid?: number, refused?: boolean, busy?: boolean, error?: string}} existing
 * @param {(pid: number) => Promise<string>} focus
 * @param {*} config
 * @param {string} platform
 * @return {Promise<{ok: boolean, error?: string, reused?: boolean, focus?: string, foreground?: string}|null>}
 */
async function answerOfOpenMpv(existing, focus, config, platform) {
  if (existing.ok) {
    let focused;
    // The window is raised through PowerShell, which only Windows has.
    if (existing.pid && platform === 'win32') {
      focused = await focus(existing.pid);
    }
    debugLog(config, 'reused', {pid: existing.pid, focus: focused});
    return {ok: true, reused: true, ...focusOutcome(focused || '')};
  }
  // Running, but silent or refusing: a second mpv on the same pipe would get no IPC.
  if (existing.refused) {
    debugLog(config, 'refused', {error: existing.error});
    return {ok: false, error: `the open mpv refused the stream (${existing.error}): close it and send again`};
  }
  if (existing.busy) {
    debugLog(config, 'busy', {});
    return {ok: false, error: 'mpv is busy and did not answer: try again in a moment'};
  }
  return null;
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
 * What the WMI launch script's output means. FOCUS=gone or quit: mpv ended before it had a
 * window, a failed launch.
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
 * Launches mpv through the WMI process provider. Firefox runs a native messaging host in a job
 * object and terminates the job when the host exits; every process the host starts joins it
 * (detached and unref() too). An mpv the WMI service creates is WmiPrvSE's child and survives.
 * @param {string} mpvPath - Path to the mpv executable.
 * @param {Array<string>} args - Arguments to pass to mpv.
 * @param {boolean} [raise] - false: its window is not brought to the front (wmiLaunchLines).
 * @return {Promise<{ok: boolean, pid?: number, error?: string, focus?: string, foreground?: string,
 *   tries?: number}>} wmiLaunchResult's reading of the script's output.
 */
function launchViaWmi(mpvPath, args, raise = true) {
  const commandLine = windowsCommandLine(mpvPath, args);
  if (commandLine.length >= MaxCommandLineChars) {
    return Promise.resolve({ok: false, error: 'the stream URL is too long for mpv\'s command line'});
  }

  return runPowerShell(wmiLaunchLines(raise), PowerShellTimeoutMs, {[CommandLineEnv]: commandLine})
      .then(wmiLaunchResult);
}


/**
 * The first `max` characters as a reader counts them (graphemes): a cut inside a flag or an
 * emoji leaves a broken character in mpv.
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
 * The title mpv shows: the tab's title when the extension sent one, else the stream's host name.
 * @param {{url: string, title?: *}} message - The open message.
 * @return {string} The title.
 */
export function streamTitle(message) {
  if (typeof message.title === 'string') {
    // One line, cut in whole characters.
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
 * @param {OpenMessage} message - The open message; its url passed isStreamUrl.
 * @param {Object} config - The parsed config.json.
 * @param {{ipcRequest?: typeof mpvIpcRequest, focus?: typeof focusPid,
 *   start?: (mpvPath: string, args: Array<string>) => Promise<{ok: boolean, error?: string,
 *     pid?: number, focus?: string, foreground?: string}>,
 *   platform?: string, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   lockFile?: string, lock?: {now?: () => number, alive?: (pid: number) => boolean}}} [io] -
 *   Stand-ins for tests; the real ones by default.
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

  // Reuse the window we own: only an mpv started with our pipe answers, never the user's own.
  /** @type {?ReturnType<typeof takeLaunchLock>} */
  let lock = null;
  if (message.singleInstance) {
    const tryExisting = () => loadIntoExisting(message, headerFields, title,
        (commands) => ipcRequest(commands, undefined, undefined, pipe), extras);
    let existing = await tryExisting();
    // Another helper is starting an mpv on this pipe: this stream goes to that mpv once its pipe
    // answers, and replaces its stream, as the later send should.
    if (!existing.ok && !existing.refused && !existing.busy) {
      const lockFile = io.lockFile || launchLockFile(config);
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
    const answer = await answerOfOpenMpv(existing, focus, config, platform);
    if (answer) return answer;
    args.push(`--input-ipc-server=${pipe}`);
  }

  if (message.fullscreen) {
    args.push('--fullscreen');
  }
  // A window at once, not after the stream opened, so the focus script finds it in time.
  args.push('--force-window=immediate');
  args.push('--no-terminal');
  // Headers, title, start and subtitles as a per-file group (perFileOptions). One
  // --http-header-fields-append per header: a Referer may hold a comma. No "--" before the URL (it
  // would end the group too): only http(s) URLs get here, which cannot read as an option.
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
  // Windows caps the command line: past it, mpv starts without the quality list, and only its
  // quality menu misses it. An open window gets the list over the pipe.
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

  // On Windows mpv must start outside the host's job object (launchViaWmi). From here the launch
  // lock waits on the mpv started.
  const settleLock = (/** @type {{ok: boolean, error?: string, pid?: number, focus?: string, foreground?: string}} */ result) => {
    if (result.ok && Number.isInteger(result.pid)) lock?.hand(/** @type {number} */ (result.pid));
    else lock?.release();
    return result;
  };
  if (platform === 'win32') {
    const result = settleLock(await (io.start || launchViaWmi)(mpvPath, args));
    if (result.ok) {
      debugLog(config, 'wmi-created',
          {pid: result.pid, focus: result.focus,
            foreground: result.foreground});
      return {ok: true, ...focusFields(result)};
    }
    debugLog(config, 'wmi-failed', result);
    // No direct spawn as a fallback: Firefox kills it when this host exits (launchViaWmi).
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
      // No windowsHide: it puts SW_HIDE in the STARTUPINFO mpv's window is created from.
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
      resolve({ok: false, error: String(/** @type {Error} */ (e).message || e)});
    }
  });
}

// The extension holds the policy; play, ipc and relay are primitives. Even a compromised extension
// gets no more than mpv on an http(s) URL with Referer, Origin, User-Agent, a title, a start and
// subtitle files: nothing it sends may run a program, load a script, read or write a file of its
// choosing, or open anything but http(s). Default deny: checkPlayMessage for play, one allowlist
// of mpv commands (ipcCommandRefusal) for ipc, relay and onStop.

// The properties a command may read. Never options/*, working-directory, input-bindings,
// property-list, mpv-configuration and the like: they tell local paths and configuration.
export const ReadableProperties = new Set([
  'path', 'eof-reached', 'pause', 'time-remaining', 'time-pos', 'playback-time', 'percent-pos',
  'duration', 'media-title', 'fullscreen', 'idle-active', 'core-idle', 'paused-for-cache',
  'demuxer-cache-duration', 'hwdec-current', 'hwdec', 'video-format', 'width', 'height', 'pid',
  'volume', 'mute', 'speed', 'keep-open',
]);

// The properties set_property may change, besides FastStream's user-data. keep-open for the
// playing file only: mpv puts the user's value back when it goes.
export const SettableProperties = new Set(['fullscreen', 'pause', 'volume', 'mute', 'speed',
  'file-local-options/keep-open']);

// FastStream's part of mpv's user-data (connected, autoplay, heartbeat): readable and settable.
const FastStreamUserData = /^user-data\/faststream(\/[a-z0-9_-]+)+$/;

// Script messages to every script: only FastStream's, which mpv's built-in scripts ignore.
const FastStreamScriptMessage = /^faststream-[a-z0-9-]{1,40}$/;

// A frame admits about 50,000 commands; FastStream's uses stay far below these.
export const MaxIpcCommands = 32;
export const MaxOnStopCommands = 8;

const MaxPropertyText = 4096;
const MaxNoticeText = 2048;
const MaxScriptMessageArgs = 8;
const MaxShowTextMs = MaxNoticeSeconds * 1000;

/**
 * Whether a value is a string of at most max characters without control characters and, with
 * noExpansion, without '${': mpv expands properties in show-text, and ${path} would put local
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
 * Whole seconds from 1 to MaxNoticeSeconds, as text: notify.lua reads 0 as "until hidden".
 * @param {*} seconds - The 7th argument of a notify show.
 * @return {boolean}
 */
function isNoticeSeconds(seconds) {
  return typeof seconds === 'string' && /^[0-9]{1,2}$/.test(seconds) &&
    Number(seconds) >= 1 && Number(seconds) <= MaxNoticeSeconds;
}

/**
 * Why a script-message-to is refused, or null: only notify.lua's show and hide of faststream.
 * The sub-command is pinned too, so what passes does not depend on notify.lua's handlers.
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
 * Why an mpv command from the extension is refused, or null when the allowlist lets it through
 * (ipc, relay, onStop): array form only, every argument checked. Never run, subprocess,
 * load-script, loadfile, loadlist, script-binding, keypress, keybind, expand-path, the object
 * form, or a property not listed.
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
      // Named when it looks like a command, so the extension's own mistakes show.
      return typeof name === 'string' && /^[a-z_-]{1,40}$/.test(name) ?
        `command not allowed: ${name}` : 'command not allowed';
  }
}

// The longest target, in UTF-8 as JSON writes it (mpv's path line carries it so to the
// extension); the quality list (fs-quality=) is its longest part.
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
 * @property {boolean} paused - newWindow's waits, paused and minimized, not raised.
 * @property {string} window - The window to play in (WindowId), '' for the one on the helper's pipe.
 * @property {string|undefined} mpvPath - The options page's mpv path: resolveMpvPath accepts
 *   only an mpv executable or its folder, so it names no program but mpv.
 * @property {Array<{name: string, text: string}>|undefined} hls - The stream's playlists, played from files
 *   (checkHlsPackage).
 */

/**
 * Checks a play message and takes what play uses; any failure refuses the whole message, and
 * fields it does not know are ignored. A header ending in a backslash is refused (perFileOptions).
 * @param {*} message - The message.
 * @return {{ok: true, play: PlaySpec}|{ok: false, error: string}}
 */
export function checkPlayMessage(message) {
  const refuse = (/** @type {string} */ error) => ({ok: /** @type {false} */ (false), error});
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
  const paused = message.paused ?? false;
  if (typeof fullscreen !== 'boolean' || typeof newWindow !== 'boolean' || typeof paused !== 'boolean') {
    return refuse('fullscreen, newWindow and paused are a yes or no');
  }
  if (paused && (!newWindow || fullscreen)) {
    return refuse('only a new window that is not fullscreen starts paused');
  }
  const window = checkWindow(message.window);
  if (!window.ok) {
    return refuse(window.error);
  }
  if (window.window && newWindow) {
    return refuse('a new window is not one that is open');
  }

  const mpvPath = isPlainText(message.mpvPath, 4096) ? message.mpvPath : undefined;

  let hls;
  if (message.hls !== undefined && message.hls !== null) {
    const checked = checkHlsPackage(message.hls);
    if (!checked.ok) {
      return refuse(checked.error);
    }
    hls = checked.files;
  }

  return {
    ok: true,
    play: {target, title, start, headerFields: [...headers], subtitles: subtitlesOf({subtitles}), fullscreen, newWindow,
      paused, window: window.window, mpvPath, hls},
  };
}


// How long a new mpv gets to open its pipe (play), and how often the helper looks.
export const PipeWaitMs = 15000;
const PipeWaitPollMs = 200;

// One helper at a time starts an mpv on the helper's pipe: two sends within one start each found
// no mpv, and the second mpv played without the pipe, out of reach. The lock is a file only one
// process can create, naming the process it waits on (the helper, then its mpv); it lapses once
// that process is gone, or after LaunchLockMs.
export const LaunchLockMs = PipeWaitMs + 5000;

/**
 * The launch lock's file, in the helper's own folder: in a shared temp folder another account
 * could make it first and keep every mpv from starting. One per ipcToken, as the pipe.
 * @param {Object} config - The parsed config.json.
 * @param {string} [dir] - Its folder (tests).
 * @return {string}
 */
export function launchLockFile(config, dir = __dirname) {
  const token = config && typeof (/** @type {{ipcToken?: string}} */ (config)).ipcToken === 'string' && /^[0-9a-f]{32}$/.test((/** @type {{ipcToken: string}} */ (config)).ipcToken) ? (/** @type {{ipcToken: string}} */ (config)).ipcToken : '';
  const id = crypto.createHash('sha256').update('faststream-mpv-launch:' + token).digest('hex').slice(0, 16);
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
    return !!e && /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Whether the launch lock holds: its file is there, younger than LaunchLockMs, and the
 * process it names still runs.
 * @param {string} file - launchLockFile.
 * @param {{now?: () => number, alive?: (pid: number) => boolean}} [io] - Stand-ins.
 * @return {boolean}
 */
export function launchLockHeld(file, io = {}) {
  /** @type {?number} */
  let fd = null;
  try {
    // Its age and its contents from one open file: the file can be replaced in between.
    fd = fs.openSync(file, 'r');
    if ((io.now || Date.now)() - fs.fstatSync(fd).mtimeMs >= LaunchLockMs) return false;
    const pid = Number(JSON.parse(fs.readFileSync(fd, 'utf8')).pid);
    return !Number.isInteger(pid) || (io.alive || processAlive)(pid);
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Takes the launch lock, unless another helper holds it.
 * @param {string} file - launchLockFile.
 * @param {{now?: () => number, alive?: (pid: number) => boolean}} [io] - Stand-ins.
 * @return {{taken: boolean, hand: (pid: number) => void, release: () => void}} hand
 *   names the process to wait on from then on (the mpv started); release lets the lock go.
 */
export function takeLaunchLock(file, io = {}) {
  const none = {hand: () => {}, release: () => {}};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({pid: process.pid}), {flag: 'wx', mode: 0o600});
      let released = false;
      return {
        taken: true,
        hand: (pid) => {
          if (released) return;
          try {
            fs.writeFileSync(file, JSON.stringify({pid}), {mode: 0o600});
          } catch (e) {
            // Without the lock the next send starts an mpv of its own.
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
      // A folder that takes no file: start unlocked.
      if (!e || /** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') return {taken: true, ...none};
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
 * A new mpv's arguments: fixed, nothing from the message. The stream goes over the pipe once mpv
 * is up, so no value of the extension's meets Windows' command-line quoting or its length cap.
 * --idle=once keeps mpv open until its first file has come and gone.
 * @param {string} pipe - The pipe mpv listens on.
 * @param {boolean} fullscreen - Whether mpv starts fullscreen.
 * @param {boolean} [paused] - A window that waits: paused and minimized; the mpv setup's auto-start.lua keeps
 *   its first file paused (start_paused), as for a local file's new window.
 * @return {Array<string>}
 */
export function freshMpvArgs(pipe, fullscreen, paused = false) {
  const args = [`--input-ipc-server=${pipe}`, '--idle=once', '--force-window=immediate', '--no-terminal'];
  if (fullscreen) {
    args.push('--fullscreen');
  }
  if (paused) {
    args.push('--pause', '--window-minimized=yes', '--script-opts-append=auto_start-start_paused=yes');
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
 * The program a process id belongs to now, on Windows (tasklist's image name), or null: gone,
 * not readable, or another platform.
 * @param {number} pid
 * @param {string} [platform] - process.platform, or a stand-in.
 * @return {Promise<?string>}
 */
export function processImageName(pid, platform = process.platform) {
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {timeout: 5000, windowsHide: true},
        (error, stdout) => {
          // "mpv.exe","1234","Console","1","45.000 K" - or a line saying no task matches.
          const row = /^"([^"]+)","(\d+)"/m.exec(String(stdout || ''));
          resolve(!error && row && Number(row[2]) === pid ? row[1] : null);
        });
  });
}

/**
 * Ends an mpv this helper started. On Windows only while its process id is still an mpv's: an
 * mpv that quit leaves its id to be handed out again, and the kill would end another program.
 * @param {number} pid - Its process id.
 * @param {{platform?: string, name?: (pid: number) => Promise<?string>, kill?: (pid: number) => void}} [io]
 * @return {Promise<boolean>} Whether it was ended.
 */
export async function stopMpv(pid, io = {}) {
  const platform = io.platform || process.platform;
  if (platform === 'win32') {
    const name = await (io.name || processImageName)(pid, platform);
    if (!name || !isMpvExecutableName(name, platform)) return false;
  }
  try {
    (io.kill || process.kill)(pid);
    return true;
  } catch {
    // It has gone already.
    return false;
  }
}

/**
 * Plays a checked play message: into the mpv on the helper's pipe when one runs (busy or refusing
 * is an error, never a second mpv on that pipe); otherwise, and for newWindow, a new mpv with
 * freshMpvArgs, then the stream over its pipe. newWindow gets a pipe of its own, named by the window id
 * the answer carries: play, ipc, relay and raise reach it by that id. window plays only in that open window.
 * @param {?string} mpvPath - The mpv executable (resolveMpvPath), or null when none was found:
 *   then only an mpv already open can play.
 * @param {PlaySpec} play - checkPlayMessage's.
 * @param {Object} config - The parsed config.json.
 * @param {{ipcRequest?: typeof mpvIpcRequest, focus?: typeof focusPid,
 *   start?: (mpvPath: string, args: Array<string>, raise: boolean) => Promise<{ok: boolean, error?: string,
 *     pid?: number, focus?: string, foreground?: string}>,
 *   platform?: string, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   randomHex?: () => string, subtitleBase?: string, hlsBase?: string, stop?: (pid: number) => void,
 *   lockFile?: string, lock?: {now?: () => number, alive?: (pid: number) => boolean}}} [io] -
 *   Stand-ins for tests; the real ones by default.
 * @return {Promise<{ok: boolean, window?: string, error?: string, reused?: boolean, closed?: boolean,
 *   focus?: string, foreground?: string, local?: string}>} The answer for the extension, as the legacy open's;
 *   window: the one it played in or tried to (none when the playlists could not be written); closed: play.window
 *   is gone; local: the playlist file mpv plays for hls, its path in mpv's watch.
 */
export async function playMpv(mpvPath, play, config, io = {}) {
  let entry = play.target;
  if (play.hls) {
    try {
      entry = writeHlsPackage(play.hls, play.target, io.hlsBase);
    } catch (e) {
      debugLog(config, 'hls-failed', {error: String(e)});
      return {ok: false, error: 'Could not write the playlists of the stream for mpv: ' + String(e)};
    }
  }
  /** @type {Array<string>} */
  let subFiles = [];
  try {
    subFiles = writeSubtitleFiles(play.subtitles, io.subtitleBase, isPrivateTarget(play.target));
  } catch (e) {
    // The stream still plays without them.
    debugLog(config, 'subtitles-failed', {error: String(e)});
  }
  const {busy, ...answer} = await playEntry(mpvPath, play, config, io, entry, subFiles);
  if (answer.ok) return play.hls ? {...answer, local: entry} : answer;
  // Busy: the load is in mpv's pipe, and mpv may still run it. Its folders stay: mpv removes a private window's once
  // it moved on from them (faststream-private.lua), and the next helper to end any by their age.
  if (!busy) {
    removeSubtitleFiles(subFiles);
    if (play.hls) {
      try {
        fs.rmSync(path.dirname(entry), {recursive: true, force: true});
      } catch (e) {
        // The next helper to end removes it.
      }
    }
  }
  return answer;
}

/**
 * playMpv's work, for the file or URL mpv loads; every answer names the window it is about.
 * @param {?string} mpvPath
 * @param {PlaySpec} play
 * @param {Object} config
 * @param {NonNullable<Parameters<typeof playMpv>[3]>} io
 * @param {string} entry - play.target, or the entry of its playlists' folder.
 * @param {Array<string>} subFiles - The subtitle files mpv loads with it.
 * @return {Promise<Awaited<ReturnType<typeof playMpv>> & {busy?: boolean}>} busy: the mpv on the pipe did not
 *   answer in time, with the load already written to it.
 */
async function playEntry(mpvPath, play, config, io, entry, subFiles) {
  const window = play.newWindow ? (io.randomHex ? io.randomHex() : crypto.randomBytes(8).toString('hex')) :
    play.window;
  return {...await playWindow(mpvPath, play, config, io, entry, subFiles, window), window};
}

/**
 * playEntry's, for one window: the one on the helper's pipe (''), an open one by its id (never a start: closed when
 * it is gone), or newWindow's.
 * @param {?string} mpvPath
 * @param {PlaySpec} play
 * @param {Object} config
 * @param {NonNullable<Parameters<typeof playMpv>[3]>} io
 * @param {string} entry
 * @param {Array<string>} subFiles
 * @param {string} window - Its id (WindowId), or ''.
 * @return {Promise<Awaited<ReturnType<typeof playMpv>> & {busy?: boolean, closed?: boolean}>}
 */
async function playWindow(mpvPath, play, config, io, entry, subFiles, window) {
  const platform = io.platform || process.platform;
  const ipcRequest = io.ipcRequest || mpvIpcRequest;
  const focus = io.focus || focusPid;
  const basePipe = ipcPipeFor(config, platform);
  const options = perFileOptions(play.headerFields, play.title, {start: play.start, subFiles});
  if (entry !== play.target) {
    Object.assign(options, hlsPlayOptions(entry));
  }
  /**
   * @param {string} pipe
   * @param {boolean} fullscreen
   * @return {ReturnType<typeof loadInto>}
   */
  const load = (pipe, fullscreen) => loadInto(entry, options, fullscreen,
      (commands) => ipcRequest(commands, undefined, undefined, pipe));

  if (!play.newWindow) {
    const loaded = await load(window ? ipcPipeFor(config, platform, undefined, window) : basePipe, play.fullscreen);
    const answer = await answerOfOpenMpv(loaded, focus, config, platform);
    if (answer) return loaded.busy ? {...answer, busy: true} : answer;
    if (window) {
      // Nothing was written to that window: playMpv removes the subtitles and playlists no mpv will read.
      if (loaded.stalled) {
        return {ok: false, error: 'mpv is busy and did not answer: try again in a moment'};
      }
      debugLog(config, 'window-closed', {window});
      return {ok: false, closed: true, error: 'that mpv window was closed'};
    }
  }

  // Another helper is starting an mpv on this pipe: wait, then load into that mpv (loaded before
  // it, its own stream would replace this one).
  const lockFile = play.newWindow ? null : (io.lockFile || launchLockFile(config));
  let lock = lockFile ? takeLaunchLock(lockFile, io.lock) : null;
  if (lockFile && lock && !lock.taken) {
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
    // Busy (opening the other helper's stream): a second mpv on its pipe would get no IPC.
    if (loaded.busy) {
      debugLog(config, 'busy', {});
      return {ok: false, busy: true, error: 'mpv is busy and did not answer: try again in a moment'};
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
   * @return {Promise<{ok: boolean, busy?: boolean, error?: string, focus?: string, foreground?: string}>}
   */
  async function startAndLoad() {
    if (!mpvPath) {
      return {ok: false, error: mpvNotFoundError(play.mpvPath)};
    }
    const pipe = ipcPipeFor(config, platform, undefined, window);
    const args = freshMpvArgs(pipe, play.fullscreen, play.paused);
    debugLog(config, 'spawn', {mpvPath, args});
    // Windows: outside the host's job object (launchViaWmi), no direct spawn as a fallback.
    /** @type {{ok: boolean, error?: string, pid?: number, focus?: string, foreground?: string}} */
    const started = await (io.start || (platform === 'win32' ? launchViaWmi : launchDirect))(mpvPath, args,
        !play.paused);
    if (!started.ok) {
      debugLog(config, 'start-failed', started);
      return {ok: false, error: platform === 'win32' ? 'Could not start mpv: ' + started.error : String(started.error)};
    }
    debugLog(config, 'started', {pid: started.pid, focus: started.focus, foreground: started.foreground});

    const answered = await waitForPipe((commands) => ipcRequest(commands, 1000, 3000, pipe), PipeWaitMs, io.sleep, io.now);
    // --idle=once keeps an mpv that never loaded a file open for good: one that stays silent or
    // refuses the stream is ended (only this one, by its pid; a late answer may still have it).
    // Awaited: the helper exits once it has answered.
    const end = async () => {
      if (started.pid) {
        await (io.stop || stopMpv)(started.pid);
      }
    };
    if (!answered) {
      debugLog(config, 'pipe-silent', {pipe});
      await end();
      return {ok: false, error: `mpv started, but did not answer on its pipe within ${PipeWaitMs / 1000} s`};
    }
    // --fullscreen is on the command line already.
    const loaded = await load(pipe, false);
    if (!loaded.ok) {
      debugLog(config, 'load-failed', loaded);
      if (loaded.refused) {
        await end();
      }
      return {ok: false, ...(loaded.busy ? {busy: true} : {}), error: loaded.refused ?
        `the new mpv refused the stream (${loaded.error})` :
        'the new mpv did not take the stream: try again in a moment'};
    }
    return {ok: true, ...(platform === 'win32' ? focusFields(started) : {})};
  }
}

/**
 * Runs an ipc message's commands on the mpv on the helper's pipe: all allowlisted
 * (ipcCommandRefusal), or none is sent. The helper numbers the requests itself.
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
  const replies = /** @type {Array<{request_id: number, error: *, data: *}>} */ (result.replies || []);
  // One answer is one message, and Firefox takes at most 1 MB from a host: a reply past the room
  // left is "reply too large", and the others still arrive.
  let room = MaxRelayLineBytes;
  return {
    ok: true,
    replies: commands.map((command, index) => {
      const reply = replies.find((r) => r && r.request_id === index + 1);
      // mpvIpcRequest gives up with the answers it has after its reply time.
      if (!reply) return {error: 'no reply', data: undefined};
      const size = Buffer.byteLength(JSON.stringify({error: reply.error, data: reply.data}) || '', 'utf8');
      if (size > room) return {error: 'reply too large', data: undefined};
      room -= size;
      return {error: reply.error, data: reply.data};
    }),
  };
}

/**
 * Brings one of the helper's mpv windows to the front (Windows; elsewhere it only answers whether it is open).
 * @param {string} window - Its id (WindowId), or '' for the one on the helper's pipe.
 * @param {Object} config - The parsed config.json.
 * @param {{ipcRequest?: typeof mpvIpcRequest, focus?: typeof focusPid, platform?: string}} [io] - Stand-ins.
 * @return {Promise<{ok: boolean, closed?: boolean, busy?: boolean, error?: string, focus?: string,
 *   foreground?: string}>}
 */
export async function raiseMpv(window, config, io = {}) {
  const platform = io.platform || process.platform;
  const result = await (io.ipcRequest || mpvIpcRequest)([{command: ['get_property', 'pid']}], undefined, undefined,
      ipcPipeFor(config, platform, undefined, window));
  if (!result.ok) {
    return result.busy || result.error === StalledError ?
      {ok: false, busy: true, error: 'mpv is busy and did not answer: try again in a moment'} :
      {ok: false, closed: true, error: 'that mpv window was closed'};
  }
  const reply = /** @type {Array<{request_id: number, data?: *}>} */ (result.replies || [])
      .find((r) => r.request_id === 1);
  const pid = reply && typeof reply.data === 'number' ? reply.data : undefined;
  if (!pid || platform !== 'win32') {
    return {ok: true};
  }
  return {ok: true, ...focusOutcome(await (io.focus || focusPid)(pid))};
}

// A relay's heartbeat: at least this often apart, and no further than setInterval can wait
// (past it, Node runs the interval every millisecond).
export const MinHeartbeatMs = 5000;
const MaxTimerMs = 2147483647;

/**
 * A relay message's options, checked: heartbeat a FastStream user-data property and an
 * interval of MinHeartbeatMs or more; onStop at most MaxOnStopCommands allowlisted commands; window checkWindow's.
 * @param {*} message - The first message on the port.
 * @return {{ok: true, heartbeat: ?{property: string, everyMs: number}, onStop: Array<Array<*>>, window: string}|
 *   {ok: false, error: string}}
 */
export function checkRelayMessage(message) {
  const window = checkWindow(message.window);
  if (!window.ok) {
    return window;
  }
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
  return {ok: true, heartbeat, onStop, window: window.window};
}

// A native message to the extension may be 1 MB, with room for the message around the line.
// Over MaxTargetBytes, so the path event of every stream play took arrives.
export const MaxRelayLineBytes = 1000 * 1024;
// How much of the end of a line over MaxRelayLineBytes is kept to find its request_id in.
const RequestIdWindow = 256;

/**
 * Relays between the extension and the mpv on the helper's pipe over a kept-open port: mpv's
 * lines go out as {type: 'mpv', data} (one over MaxRelayLineBytes is dropped), except replies to
 * the relay's own requests; allowlisted commands go to mpv under a request id of the helper's.
 * The heartbeat sets its property to a rising time every everyMs (the mpv setup hides
 * FastStream's buttons once it stands still). onStop is written when the extension lets go, not
 * when mpv goes.
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
      // The extension let go, mpv plays on: onStop tells it so. end() sends the lines before it
      // closes (destroy() could drop them); done waits for that, briefly.
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

  if ((/** @type {{type: string}} */ (message)).type === 'ping') {
    const mpvPath = resolveMpvPath((/** @type {{mpvPath?: string}} */ (message)).mpvPath);
    debugLog(config, 'ping', {mpvPath});
    if (mpvPath) {
      await sendMessage({ok: true, mpv: true, path: mpvPath});
    } else {
      await sendMessage({ok: true, mpv: false});
    }
    return;
  }

  if ((/** @type {{type: string}} */ (message)).type === 'status') {
    const status = await queryDecoder((/** @type {{waitMs?: number}} */ (message)).waitMs);
    debugLog(config, 'status', status);
    await sendMessage({ok: true, ...status});
    return;
  }

  if ((/** @type {{type: string}} */ (message)).type === 'watch') {
    const watch = watchMpv((event) => {
      debugLog(config, 'watch', event);
      sendMessage(event);
    });
    // The browser went: a write fails, and the watch ends as when the extension lets go.
    process.stdout.on('error', () => watch.stop());
    readMessages(process.stdin, (next) => {
      if ((/** @type {{type: string}} */ (next)).type === 'notify') watch.notify(String((/** @type {{title?: *}} */ (next)).title || ''), String((/** @type {{detail?: *}} */ (next)).detail || ''), (/** @type {{seconds?: *}} */ (next)).seconds);
      else if ((/** @type {{type: string}} */ (next)).type === 'hide') watch.hide();
      else if ((/** @type {{type: string}} */ (next)).type === 'state') watch.state(next);
    }, () => watch.stop());
    await watch.done;
    // The last message ('closed') out before the host goes.
    await sendMessage({type: 'bye'});
    return;
  }

  // The message's mpv path is only an mpv candidate to resolveMpvPath, never another program.
  if ((/** @type {{type: string}} */ (message)).type === 'play') {
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

  if ((/** @type {{type: string}} */ (message)).type === 'ipc') {
    const window = checkWindow((/** @type {{window?: *}} */ (message)).window);
    const result = window.ok ?
      await runIpc((/** @type {{commands?: *}} */ (message)).commands,
          {pipe: ipcPipeFor(config, undefined, undefined, window.window)}) :
      {ok: false, error: 'refused', reason: window.error};
    debugLog(config, 'ipc', {ok: result.ok, error: result.error, index: result.index, reason: result.reason});
    await sendMessage(result);
    return;
  }

  if ((/** @type {{type: string}} */ (message)).type === 'raise') {
    const window = checkWindow((/** @type {{window?: *}} */ (message)).window);
    const result = window.ok ? await raiseMpv(window.window, config) : {ok: false, error: window.error};
    debugLog(config, 'raise', result);
    await sendMessage(result);
    return;
  }

  if ((/** @type {{type: string}} */ (message)).type === 'relay') {
    const checked = checkRelayMessage(message);
    if (!checked.ok) {
      debugLog(config, 'relay-refused', {error: checked.error});
      await sendMessage({type: 'closed', reason: 'refused', error: checked.error});
      return;
    }
    /** @type {Promise<void>} */
    let last = Promise.resolve();
    const played = privatePackageWatch();
    const relay = relayMpv((event) => {
      played.see(event);
      // mpv's own lines (time-pos many times a second) stay out of the log.
      if ((/** @type {{type: string}} */ (event)).type !== 'mpv' && (/** @type {{type: string}} */ (event)).type !== 'mpv-reply') debugLog(config, 'relay', event);
      last = sendMessage(event);
    }, checked, {pipe: ipcPipeFor(config, undefined, undefined, checked.window)});
    // The browser went while mpv plays on: as when the extension lets go (the watch's reason).
    process.stdout.on('error', () => relay.stop());
    readMessages(process.stdin, (next) => relay.receive(next), () => relay.stop());
    const reason = await relay.done;
    // The last message ('closed') out before the host goes.
    await last;
    played.end(reason);
    return;
  }

  if ((/** @type {{type: string}} */ (message)).type === 'open' && typeof (/** @type {{url?: string}} */ (message)).url === 'string' && (/** @type {{url: string}} */ (message)).url.length > 0) {
    if (!isStreamUrl((/** @type {{url: string}} */ (message)).url)) {
      debugLog(config, 'refused', {url: (/** @type {{url: string}} */ (message)).url});
      await sendMessage({ok: false, error: 'mpv is only given http(s) streams'});
      return;
    }
    const mpvPath = resolveMpvPath((/** @type {{mpvPath?: string}} */ (message)).mpvPath);
    if (!mpvPath) {
      await sendMessage({ok: false, error: mpvNotFoundError((/** @type {{mpvPath?: string}} */ (message)).mpvPath)});
      return;
    }
    const result = await launchMpv(mpvPath, /** @type {OpenMessage} */ (message), config);
    debugLog(config, 'launched', {mpvPath, url: (/** @type {{url: string}} */ (message)).url, result});
    await sendMessage(result);
    return;
  }

  await sendMessage({ok: false, error: 'unknown message'});
}

/**
 * The host: one message, then one exit here (an exit in each branch reads to CodeQL as input
 * deciding a sensitive action, js/user-controlled-bypass).
 */
async function main() {
  // A browser gone before the answer makes the write fail: no crash for it.
  process.stdout.on('error', () => {});
  await handleMessage();
  removeOldHlsPackages();
  removeOldSubtitleDirs();
  process.exit(0);
}

/**
 * Whether Node runs this file as the program: argv[1] keeps a symlink's path, import.meta.url is
 * the real one.
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

// Not when a test imports this module: main() would wait on stdin for ever.
if (isProgram()) {
  main();
}
