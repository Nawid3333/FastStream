#!/usr/bin/env node
// FastStream mpv native messaging host.
//
// Receives messages from the FastStream extension over the Chrome/Firefox
// native messaging protocol (4-byte little-endian length prefix + JSON) and
// launches mpv on the user's machine.
//
// Messages:
//   {type: 'ping'}                -> {ok, mpv, path}
//   {type: 'open', url, headers?, mpvPath?} -> {ok, error?}
//
// Configuration (optional): config.json next to this script:
//   {"mpvPath": "C:\\Program Files\\mpv\\mpv.exe"}
// A path sent by the extension (options page "mpv path") takes precedence.

import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';
import * as url from 'url';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));

const DefaultMpvPaths = [
  process.env.FASTSTREAM_MPV_PATH,
  'C:\\Program Files\\mpv\\mpv.exe',
  'C:\\Program Files (x86)\\mpv\\mpv.exe',
  'mpv',
].filter(Boolean);

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

function sendMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(header);
  process.stdout.write(payload);
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
        if (header === null) {
          const toCopy = Math.min(chunk.length - offset, 4 - headerRead);
          chunk.copy(header === null ? (header = Buffer.alloc(4)) : header, headerRead, offset, offset + toCopy);
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

function launchMpv(mpvPath, message) {
  const args = [];

  if (message.headers && Array.isArray(message.headers)) {
    const headerFields = message.headers
        .filter((header) => header && header.name && header.value)
        .map((header) => `${header.name}: ${header.value}`)
        .join(',');
    if (headerFields) {
      args.push(`--http-header-fields=${headerFields}`);
    }
  }

  let title = 'FastStream';
  try {
    title = new URL(message.url).hostname || title;
  } catch (e) {
    // Keep the default title for non-URLs.
  }
  args.push(`--force-media-title=${title}`);
  args.push('--no-terminal');
  args.push('--');
  args.push(message.url);

  return new Promise((resolve) => {
    try {
      const child = spawn(mpvPath, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
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
  const message = await readMessage();
  if (!message || typeof message !== 'object') {
    process.exit(0);
    return;
  }

  if (message.type === 'ping') {
    const mpvPath = resolveMpvPath(message.mpvPath);
    if (mpvPath) {
      sendMessage({ok: true, mpv: true, path: mpvPath});
    } else {
      sendMessage({ok: true, mpv: false});
    }
    process.exit(0);
    return;
  }

  if (message.type === 'open' && typeof message.url === 'string' && message.url.length > 0) {
    const mpvPath = resolveMpvPath(message.mpvPath);
    if (!mpvPath) {
      sendMessage({ok: false, error: 'mpv executable not found'});
      process.exit(0);
      return;
    }
    const result = await launchMpv(mpvPath, message);
    sendMessage(result);
    process.exit(0);
    return;
  }

  sendMessage({ok: false, error: 'unknown message'});
  process.exit(0);
}

main();
