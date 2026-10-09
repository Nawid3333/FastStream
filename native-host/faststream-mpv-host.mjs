#!/usr/bin/env node
// @ts-check
// FastStream mpv native messaging host.
//
// Receives messages from the FastStream extension over the Firefox
// native messaging protocol (4-byte little-endian length prefix + JSON) and
// launches mpv on the user's machine.
//
// Messages:
//   {type: 'ping', mpvPath?}      -> {ok, mpv, path}
//   {type: 'open', url, headers?, mpvPath?, fullscreen?, singleInstance?, contentType?,
//    pageUrl?, title?, start?, subtitles?} -> {ok, error?, reused?, focus?, foreground?}
//   {type: 'status', waitMs?}    -> {ok, running, decoder: {hardware, api, requested,
//                                    format, width, height} | null}
// Every answer also carries hostVersion (HostVersion below).
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
export const HostVersion = 5;

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
  if (!config.debug && !process.env.FASTSTREAM_MPV_DEBUG) {
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
 * An answer as it goes to the extension: with this host's version.
 * @param {Object} message - The answer.
 * @return {Object} The answer with hostVersion.
 */
export function withHostVersion(message) {
  return {...message, hostVersion: HostVersion};
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
  return path.posix.join(env.XDG_RUNTIME_DIR || os.tmpdir(), `faststream-mpv-${user}.sock`);
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
  return pageFragment ? withFragmentTag(withId, `fs-page=${pageFragment}`) : withId;
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
 * @param {{start?: number, subFiles?: Array<string>}} [extras] - Where to start, and
 *   subtitle files to load with the stream.
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
  /** @type {Array<{command: *}>} */
  const commands = [];
  if (message.fullscreen) {
    commands.push({command: ['set_property', 'fullscreen', true]});
  }
  // The file with its own headers and title: one command (perFileOptions). Named
  // arguments, since loadfile's options come after its index from mpv 0.38 on. No index:
  // -1 is its default there (player/command.c), and mpv before 0.38 has none and refused
  // the whole command, so the open window of a distro's mpv (Ubuntu 24.04: 0.37) took no
  // second video.
  commands.push({command: {
    name: 'loadfile',
    url: mpvTargetUrl(message),
    flags: 'replace',
    options: perFileOptions(headerFields, title, extras),
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
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
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
    // SW_SHOW (5) leaves a minimised window in the taskbar; SW_RESTORE (9) brings it back.
    '        if ([FSFg]::IsIconic($h)) { $null = [FSFg]::ShowWindow($h, 9) } else { $null = [FSFg]::ShowWindow($h, 5) }',
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
  const commandLine = [mpvPath, ...args].map(quoteWindowsArg).join(' ');
  if (commandLine.length >= MaxCommandLineChars) {
    return Promise.resolve({ok: false, error: 'the stream URL is too long for mpv\'s command line'});
  }

  return runPowerShell(wmiLaunchLines(), PowerShellTimeoutMs, {[CommandLineEnv]: commandLine}).then(wmiLaunchResult);
}

/**
 * The title mpv shows for a stream (window, taskbar, uosc's top bar): the browser tab's
 * title when the extension sent one, else the stream's host name.
 * @param {{url: string, title?: *}} message - The open message.
 * @return {string} The title.
 */
export function streamTitle(message) {
  if (typeof message.title === 'string') {
    // Control characters out (a title is one line), length bounded.
    const clean = Array.from(message.title, (c) => c.charCodeAt(0) < 32 || c === '\u007f' ? ' ' : c)
        .join('').replace(/\s+/g, ' ').trim().slice(0, 200);
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
  if (message.singleInstance) {
    const existing = await loadIntoExisting(message, headerFields, title,
        (commands) => ipcRequest(commands, undefined, undefined, pipe), extras);
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
  args.push(mpvTargetUrl(message));
  args.push('--}');

  debugLog(config, 'spawn', {mpvPath, args});

  // On Windows mpv has to be started by someone outside this process's job
  // object, or the browser kills it the moment this host exits. See
  // launchViaWmi.
  if (platform === 'win32') {
    const result = await (io.start || launchViaWmi)(mpvPath, args);
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

  return (io.start || launchDirect)(mpvPath, args);
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
 * @return {Promise<{ok: boolean, error?: string}>} Result.
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
      const timer = setTimeout(() => resolve({ok: true}), 500);
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

async function main() {
  const config = readConfig();
  const message = await readMessage();
  if (message === TooLarge) {
    debugLog(config, 'too-large', {});
    await sendMessage({ok: false, error: 'the message was too large for the mpv host'});
    process.exit(0);
    return;
  }
  debugLog(config, 'received', loggedMessage(message));
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

  // Which video decoder the mpv this host started uses: the extension asks after a
  // hand-off, and "Test mpv connection" asks too. Read-only: nothing is changed in mpv.
  if (message.type === 'status') {
    const status = await queryDecoder(message.waitMs);
    debugLog(config, 'status', status);
    await sendMessage({ok: true, ...status});
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
      await sendMessage({ok: false, error: mpvNotFoundError(message.mpvPath)});
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
