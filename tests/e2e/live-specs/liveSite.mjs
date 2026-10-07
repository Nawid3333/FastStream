// What the live specs share: the official releases of the libraries their test sites use,
// fetched from the npm registry once and cached, and the steps that check FastStream's
// player in a page - it replaced the page's video, it plays, a seek lands and plays on.
// (Not a spec itself: wdio.live.conf.mjs runs live-specs/**/*.e2e.mjs.)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';
import zlib from 'node:zlib';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';
import {inExtensionPage} from '../extension-page.mjs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(__dirname, '../../..');

export const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

const SHAKA = 'https://storage.googleapis.com/shaka-demo-assets';
/** Public test streams: long-lived and CORS-enabled. */
export const STREAMS = {
  // 60 s, 5 H.264 levels, 6 audio renditions in 5 languages, 4 WebVTT subtitle renditions.
  hls: `${SHAKA}/angel-one-hls/hls.m3u8`,
  // The same title as DASH (SegmentBase, on-demand profile).
  dash: `${SHAKA}/angel-one/dash.mpd`,
  // 888 s, for a seek far into a long title.
  dashLong: `${SHAKA}/sintel/dash.mpd`,
  // A live stream: type="dynamic", a SegmentTimeline that grows every 4 s.
  dashLive: 'https://storage.googleapis.com/shaka-live-assets/player-source.mpd',
  // Progressive MP4 served as application/octet-stream, as file hosts often do.
  mp4: 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4',
};

// The registry host is pinned, and a package name and version must have exactly npm's
// shape before either reaches a URL or a cache path (CodeQL js/request-forgery,
// js/file-access-to-http, js/http-to-file-access).
const REGISTRY = 'https://registry.npmjs.org';
const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
// The cache lives in the e2e suites' gitignored fixtures directory, not in the OS temp
// root whose fixed paths are world-readable and pre-createable (CodeQL
// js/insecure-temporary-file). (It was once put in a fixtures directory of live-specs'
// own, which nothing ignored: a `git add -A` after a live run took the libraries into the
// tree.)
const CACHE = path.join(__dirname, '..', 'fixtures', 'live-libs');

/**
 * Writes a cache entry unless another process just did: 'wx' fails then, and that entry
 * holds the same bytes (CodeQL js/file-system-race). Its directory is made first.
 * @param {string} file - The cache path.
 * @param {Buffer} data - What to write.
 */
function writeCache(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, data);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Reads a cache entry, or null when there is none. No existsSync first: gone-in-between
 * is the catch's case (CodeQL js/file-system-race).
 * @param {string} file - The cache path.
 * @return {?Buffer}
 */
function readCache(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return null;
  }
}

/**
 * Splits a tar archive into its files: a run of 512-byte headers, each followed by its
 * file padded to 512.
 * @param {Buffer} tar - The archive.
 * @return {Map<string, Buffer>} Path inside the package (without "package/") -> contents.
 */
function untar(tar) {
  const files = new Map();
  const field = (start, length) => tar.toString('utf8', start, start + length).replace(/\0[\s\S]*$/, '');
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = field(offset, 100);
    if (!name) {
      break;
    }
    const size = parseInt(field(offset + 124, 12).trim() || '0', 8);
    const prefix = field(offset + 345, 155);
    const full = (prefix ? prefix + '/' : '') + name;
    // Packed by npm, everything is under package/ (a few old tarballs use another top
    // folder: the first segment is dropped either way).
    files.set(full.replace(/^[^/]+\//, ''), tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const packages = new Map();

/**
 * Returns every file of one npm package version, downloading its tarball from the
 * registry the first time (checked against the integrity the registry gives for it) and
 * caching the tarball in tests/e2e/fixtures/live-libs (gitignored).
 * @param {string} pkg - The package name, scoped or not.
 * @param {string} version - An exact version.
 * @return {Promise<Map<string, Buffer>>} Path inside the package -> contents.
 */
export async function npmPackage(pkg, version) {
  if (!PACKAGE_NAME.test(pkg) || !SEMVER.test(version)) {
    throw new Error(`not an npm package name and version: ${pkg}@${version}`);
  }
  const key = `${pkg}@${version}`;
  if (packages.has(key)) {
    return packages.get(key);
  }
  const cached = path.join(CACHE, `${key}.tgz`);
  let tgz = readCache(cached);
  if (!tgz) {
    const metaRes = await fetch(`${REGISTRY}/${pkg}/${version}`);
    if (!metaRes.ok) {
      throw new Error(`could not look up ${key}: HTTP ${metaRes.status}`);
    }
    const {dist} = await metaRes.json();
    const tarball = new URL(dist.tarball);
    if (tarball.origin !== REGISTRY) {
      throw new Error(`${key}: the registry named a tarball on another host: ${tarball.origin}`);
    }
    const res = await fetch(tarball);
    if (!res.ok) {
      throw new Error(`could not download ${key}: HTTP ${res.status}`);
    }
    tgz = Buffer.from(await res.arrayBuffer());
    const [algorithm, expected] = String(dist.integrity).split('-');
    if (algorithm !== 'sha512' || crypto.createHash('sha512').update(tgz).digest('base64') !== expected) {
      throw new Error(`${key}: the tarball does not match the registry's integrity ${dist.integrity}`);
    }
    writeCache(cached, tgz);
  }
  const files = untar(zlib.gunzipSync(tgz));
  packages.set(key, files);
  return files;
}

/**
 * The version of a package this repo's package.json pins: the hls.js and dash.js a test
 * site uses are the releases FastStream's own copies come from.
 * @param {string} pkg - The package name.
 * @return {string}
 */
export function pinnedVersion(pkg) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  return String(pkgJson.devDependencies[pkg]).replace(/^[\^~]/, '');
}

/**
 * Returns one file of an npm package at the version package.json pins.
 * @param {string} pkg - The package name.
 * @param {string} file - The file's path inside the package.
 * @return {Promise<Buffer>} The file.
 */
export async function npmFile(pkg, file) {
  const version = pinnedVersion(pkg);
  const data = (await npmPackage(pkg, version)).get(file);
  if (!data) {
    throw new Error(`${pkg}@${version} has no ${file}`);
  }
  return data;
}

/**
 * Saves options the way the options page does, and has the background reload them.
 * @param {Object} options - The options to save; everything else takes its default.
 */
export async function setOptions(options) {
  await inExtensionPage((options, done) => {
    chrome.storage.local.set({options: JSON.stringify(options)}, () => {
      chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
        void chrome.runtime.lastError;
        setTimeout(() => done(true), 500);
      });
    });
  }, options);
}

/**
 * What the page's own videos are doing, for a failure message: open shadow roots and
 * same-origin frames included.
 * @return {Promise<Array<Object>>}
 */
export const pageVideos = () => browser.execute(() => {
  const out = [];
  const walk = (node, where) => {
    for (const video of node.querySelectorAll('video')) {
      out.push({where, src: (video.currentSrc || video.src || '').slice(0, 80), readyState: video.readyState,
        paused: video.paused, width: video.videoWidth, size: `${video.clientWidth}x${video.clientHeight}`});
    }
    for (const element of node.querySelectorAll('*')) {
      if (element.shadowRoot) walk(element.shadowRoot, `${where} > ${element.localName}::shadow`);
    }
  };
  walk(document, 'page');
  return out;
});

/**
 * Waits for FastStream's player to replace the page's video, then switches into it,
 * through the site's own iframe when the video is in one.
 * @param {number} timeout - How long to wait, in ms.
 */
export async function enterPlayer(timeout = 60000) {
  const selector = 'iframe[src*="player/index.html"]';
  await browser.switchFrame(null);
  let nested = false;
  try {
    await browser.waitUntil(async () => {
      await browser.switchFrame(null);
      if (await browser.$(selector).isExisting()) {
        nested = false;
        return true;
      }
      for (const frame of await browser.$$('iframe')) {
        await browser.switchFrame(null);
        await browser.switchFrame(frame);
        if (await browser.$(selector).isExisting()) {
          nested = true;
          return true;
        }
      }
      return false;
    }, {timeout, interval: 500});
  } catch (e) {
    await browser.switchFrame(null);
    throw new Error(`FastStream never replaced the page's player; the page's videos: ${JSON.stringify(await pageVideos())}`);
  }
  if (!nested) {
    await browser.switchFrame(null);
  }
  await browser.switchFrame(await browser.$(selector));
}

/**
 * Reads the player's state.
 * @return {Promise<Object>} The state.
 */
export const playerState = () => browser.execute(() => {
  const client = window.fastStream;
  const video = client?.player?.getVideo?.();
  // What the player was given and what it shows, for a failure message.
  const context = {
    sources: (client?.sourcesBrowser?.sources || []).filter((source) => source.url)
        .map((source) => `${source.mode} ${source.url}`),
    status: Array.from(document.querySelectorAll('.mainplayer .status_message'))
        .map((element) => element.textContent.trim()).filter(Boolean),
  };
  if (!video) {
    return {loaded: false, source: client?.source ? `${client.source.mode} ${client.source.url}` : null, ...context};
  }
  const toRanges = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push([+list.start(i).toFixed(2), +list.end(i).toFixed(2)]);
    }
    return out;
  };
  const ranges = toRanges(video.buffered);
  const levels = client.getVideoLevels();
  const playing = levels.get(client.getCurrentVideoLevelID());
  return {
    loaded: true,
    mode: client.source?.mode,
    url: client.source?.url,
    time: client.currentTime,
    // The element's own position and window: a live stream left at 0, outside its window,
    // while its buffer filled at the live edge (#348).
    videoTime: +video.currentTime.toFixed(2),
    seekable: toRanges(video.seekable),
    duration: client.duration,
    paused: video.paused,
    seeking: video.seeking,
    readyState: video.readyState,
    width: video.videoWidth,
    ranges,
    playingLevel: playing ? `${playing.width}x${playing.height} ${playing.videoCodec}` : null,
    videoLevels: Array.from(levels.values()).map((level) => `${level.width}x${level.height} ${level.videoCodec}`),
    audioLanguages: Array.from(client.getAudioLevels().values()).map((level) => level.language),
    error: video.error ? video.error.message || String(video.error.code) : null,
    ...context,
  };
});

/**
 * Waits until the player has data to play at its position, and returns its state.
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state.
 */
export async function waitPlayable(what) {
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await playerState();
      return last.loaded && !last.seeking && last.readyState >= 3 && last.width > 0;
    }, {timeout: 60000, interval: 500});
  } catch (e) {
    throw new Error(`${what} never became playable: ${JSON.stringify(last)}`);
  }
  return last;
}

/**
 * Plays until the position has advanced by `seconds`, and pauses.
 * @param {number} seconds - How far.
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state at the end.
 */
export async function playFor(seconds, what) {
  const start = (await playerState()).time;
  await browser.execute(() => {
    window.fastStream.play().catch((e) => {
      window.__playError = String(e);
    });
  });
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await playerState();
      return last.time >= start + seconds;
    }, {timeout: 30000 + seconds * 3000, interval: 500});
  } catch (e) {
    const playError = await browser.execute(() => window.__playError || null);
    throw new Error(`${what}: playback did not advance ${seconds} s from ${start}: ` +
      JSON.stringify({...last, playError}));
  } finally {
    await browser.execute(() => {
      window.fastStream.pause();
    });
  }
  return last;
}

/**
 * Seeks, waits for the new position to play, and plays on from it.
 * @param {number} target - Where to, in seconds.
 * @param {string} what - For the error message.
 */
export async function seekAndPlay(target, what) {
  await browser.execute((target) => {
    window.fastStream.currentTime = target;
  }, target);
  const state = await waitPlayable(`${what} after a seek to ${target} s`);
  expect(Math.abs(state.time - target)).toBeLessThan(2);
  await playFor(2, `${what} after a seek to ${target} s`);
}
