// Of a page's streams, the player plays the longest.
//
// A page that runs an ad or an intro first has its stream among the sources FastStream
// detects, and the player used to pick by kind and age alone: the first HLS or DASH stream,
// or else the newest MP4 - the ad, as often as not. The background now reads how long each
// stream runs (StreamLengths: the manifest, or the start of the file) with the page's own
// headers, and the player picks the longest; an ad runs for seconds, the video for minutes.
//
// A manifest served with no extension in its URL, known only by its Content-Type, was not
// detected at all (cineby's Simplify server, anikage's og.bakayaro.live/m3u8/<token>).
//
// The pieces of a stream - an init segment, media segments - named .mp4, as Shaka Packager
// names them, are detected as MP4 sources of their own. Read as unknown, they ranked as ten
// minutes, and the player opened one fragment of any shorter title (Shaka's demo HLS).
// The newest piece, its read still out when the player picks, ranked so too, now and then
// (the live test's HLS in a cross-origin iframe): it counts as a piece when an earlier one
// of the same name, but for its numbers, was read as one.
//
// The longest is a guess. What the page's own video played says more: the player plays its
// file, or the stream as long as it is (StreamPick), when a page loads the next episode or
// another longer stream beside it - unless a stream five times as long plays, or any longer
// one while the video runs under three minutes: then the video is an ad, a trailer or a
// preview as likely as not, and the longest plays, as before.
//
// A playlist of the seek bar's thumbnails (EXT-X-IMAGES-ONLY: JPEG tiles) runs as long as
// the video, and a page often asks for it first: vixeo.io's did, and the player opened on
// it alone, or picked it over the video as the older of two as long. It is never picked,
// nor opened on. One that does not say what it is fails to load in the player, and the
// next stream of those it was picked from plays in its place.
//
// Driven on the installed extension, the site on the auto-enable list: pages that load an
// ad and a longer stream, and the stream the player ends up playing.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {loopedPlaylist} from '../loopedPlaylist.mjs';

const SITE_PORT = 41980;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures');

let siteServer;
let workDir;
// The film: long-av.mp4 (160 s) as most encoders write one, its movie header after the
// media data, where a read of the file's start does not find it.
let filmFile;
let filmMoovAt;
// The same film played twice over, 320 s: long enough, over three minutes, for the page's
// video to choose it beside a longer stream.
let longFilmFile;
// Every request the server got: the reads of the film's movie header are the background's.
const requests = [];

// The player fetches from a partitioned moz-extension:// frame, so everything it plays
// needs CORS, preflight included (see embed-page-query).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

const HLS_TYPE = 'application/vnd.apple.mpegurl';
const playlist = (seconds) => loopedPlaylist(seconds, '/hls-ts/');

/**
 * A playlist of the seek bar's thumbnails, as vixeo.io's player loads one: a JPEG of 10x10
 * tiles for each 1000 s, as long as the video.
 * @param {number} seconds - Its length.
 * @param {boolean} imagesOnly - Whether it says so (EXT-X-IMAGES-ONLY).
 * @param {string} c - The case, in the tiles' URLs.
 * @return {string} The playlist.
 */
function thumbnails(seconds, imagesOnly, c) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:1000', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD'];
  if (imagesOnly) {
    lines.push('#EXT-X-IMAGES-ONLY');
  }
  for (let i = 0, left = seconds; left > 0; i++, left -= 1000) {
    lines.push(`#EXTINF:${Math.min(left, 1000).toFixed(3)},`,
        '#EXT-X-TILES:RESOLUTION=160x90,LAYOUT=10x10,DURATION=10.000', `/tiles/thumbnail${i}.jpg?c=${c}`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * Serves a file, byte ranges included, as a video server does.
 * @param {http.IncomingMessage} req - The request.
 * @param {http.ServerResponse} res - The response.
 * @param {string} file - The file.
 * @param {string} type - Its Content-Type.
 */
function serveFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
    if (start >= size) {
      res.writeHead(416, {...CORS, 'Content-Range': `bytes */${size}`});
      res.end();
      return;
    }
    res.writeHead(206, {...CORS, 'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1});
    fs.createReadStream(file, {start, end}).pipe(res);
    return;
  }
  res.writeHead(200, {...CORS, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size});
  fs.createReadStream(file).pipe(res);
}

/**
 * A page with a video for the player to replace, which loads what its script says.
 * @param {string} title - The page's title.
 * @param {string} body - More of the page.
 * @param {string} script - Its script.
 * @return {string} The page.
 */
function page(title, body, script) {
  return `<!doctype html><title>${title}</title>
    <video muted preload="auto" style="width: 640px; height: 360px"></video>${body}
    <script>${script}</script>`;
}

/**
 * Waits for FastStream's player to replace the page's video, switches into it, and reads
 * the source it plays and its list of sources.
 * @return {Promise<Object>} What the player has.
 */
async function playerSources() {
  await browser.waitUntil(async () => browser.execute(() => {
    return Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('player/index.html'));
  }), {timeout: 30000, timeoutMsg: 'the in-page player never replaced the page\'s video'});
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
  let state;
  try {
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.source),
        {timeout: 30000, timeoutMsg: 'the player never got a source'});
    // A player on its source decodes it; give it the time to, for the log.
    await browser.waitUntil(async () => {
      state = await browser.execute(() => {
        const client = window.fastStream;
        const video = client.player?.getVideo?.();
        return {
          source: client.source.url,
          sources: client.sourcesBrowser.sources.map((source) => source.url).filter(Boolean),
          readyState: video ? video.readyState : null,
        };
      });
      return state.readyState >= 2;
    }, {timeout: 15000, interval: 250}).catch(() => {});
  } finally {
    // Out of the player, for the next case, whatever became of this one.
    await browser.switchFrame(null);
  }
  console.log('      player:', JSON.stringify(state));
  return state;
}

describe('Of a page\'s streams, the player', function() {
  before(async function() {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faststream-length-'));
    filmFile = path.join(workDir, 'film.mp4');
    // Without +faststart, ffmpeg writes the movie header last.
    const {status, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', path.join(FIXTURES, 'long-av.mp4'),
      '-c', 'copy', filmFile], {encoding: 'utf8'});
    if (status !== 0) {
      throw new Error(`could not remux the film fixture with ffmpeg: ${stderr}`);
    }
    // Where the movie header starts: the premise of the case that plays the film.
    const bytes = fs.readFileSync(filmFile);
    for (let pos = 0; pos + 8 <= bytes.length;) {
      const size = bytes.readUInt32BE(pos);
      const type = bytes.toString('latin1', pos + 4, pos + 8);
      if (type === 'moov') {
        filmMoovAt = pos;
        break;
      }
      pos += size === 1 ? Number(bytes.readBigUInt64BE(pos + 8)) : size;
    }
    if (!(filmMoovAt > 64 * 1024)) {
      throw new Error(`the film's movie header is at ${filmMoovAt}, not after its media data`);
    }
    longFilmFile = path.join(workDir, 'film-long.mp4');
    const looped = spawnSync('ffmpeg', ['-y', '-v', 'error', '-stream_loop', '1', '-i', path.join(FIXTURES, 'long-av.mp4'),
      '-c', 'copy', longFilmFile], {encoding: 'utf8'});
    if (looped.status !== 0) {
      throw new Error(`could not loop the film fixture with ffmpeg: ${looped.stderr}`);
    }

    // The playlists' segments, by the path they are served at.
    const segmentDir = path.join(FIXTURES, 'hls-ts');
    const segments = new Map(fs.readdirSync(segmentDir).filter((name) => name.endsWith('.ts'))
        .map((name) => [`/hls-ts/${name}`, path.join(segmentDir, name)]));

    // The 9-second fMP4 fixture, its media segments served as .mp4 like its init segment.
    const fmp4Dir = path.join(FIXTURES, 'hls-fmp4');
    const fmp4Playlist = fs.readFileSync(path.join(fmp4Dir, 'index.m3u8'), 'utf8').replace(/\.m4s$/gm, '.mp4');
    const pieces = new Map(fs.readdirSync(fmp4Dir).filter((name) => /\.(m4s|mp4)$/.test(name))
        .map((name) => [`/fmp4/${name.replace(/\.m4s$/, '.mp4')}`, path.join(fmp4Dir, name)]));

    // The pages are the same whatever they are asked with: each builds its URLs from its
    // own location, so the server echoes nothing it is sent.
    siteServer = http.createServer((req, res) => {
      const {pathname, search} = new URL(req.url, SITE);
      requests.push({path: pathname, search, range: req.headers.range || '', referer: req.headers.referer || ''});
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
      }
      const text = (type, body, status = 200) => {
        res.writeHead(status, {...CORS, 'Content-Type': type});
        res.end(body);
      };

      if (pathname === '/media/ad.mp4') {
        serveFile(req, res, path.join(FIXTURES, 'sample.mp4'), 'video/mp4');
      } else if (pathname === '/media/film.mp4') {
        serveFile(req, res, filmFile, 'video/mp4');
      } else if (pathname === '/media/film-long.mp4') {
        serveFile(req, res, longFilmFile, 'video/mp4');
      } else if (segments.has(pathname)) {
        serveFile(req, res, segments.get(pathname), 'video/mp2t');
      } else if (pieces.has(pathname)) {
        serveFile(req, res, pieces.get(pathname), 'video/mp4');
      } else if (pathname === '/fmp4/index.m3u8' || pathname === '/fmp4-slow/index.m3u8') {
        text(HLS_TYPE, fmp4Playlist);
      } else if (pathname.startsWith('/fmp4-slow/') && pieces.has(pathname.replace('/fmp4-slow/', '/fmp4/'))) {
        // The same pieces, but the length of the third is read slowly: a read asks for a
        // range, and that answer comes after the player picked. The page's own fetch has
        // none, and its answer comes at once.
        const file = pieces.get(pathname.replace('/fmp4-slow/', '/fmp4/'));
        const delay = pathname === '/fmp4-slow/seg-002.mp4' && req.headers.range ? 5000 : 0;
        setTimeout(() => serveFile(req, res, file, 'video/mp4'), delay);
      } else if (pathname === '/mse/init.m4s') {
        // The init segment a page's MSE player appends: .m4s, which is not detected.
        serveFile(req, res, path.join(fmp4Dir, 'init.mp4'), 'video/mp4');
      } else if (pathname === '/hls/clip.m3u8') {
        text(HLS_TYPE, playlist(270));
      } else if (pathname === '/hls/intro.m3u8') {
        text(HLS_TYPE, playlist(9));
      } else if (pathname === '/hls/extra.m3u8') {
        text(HLS_TYPE, playlist(720));
      } else if (pathname === '/hls/thumbnails.m3u8' || pathname === '/hls/tiles.m3u8') {
        // As long as the clip; the tiles do not say they are images.
        const c = new URLSearchParams(search).get('c');
        text(HLS_TYPE, thumbnails(270, pathname === '/hls/thumbnails.m3u8', c));
      } else if (pathname.startsWith('/tiles/')) {
        // No video: a player that fetches one finds nothing it can play.
        text('image/jpeg', 'thumbnails, not video');
      } else if (pathname.startsWith('/hls/private')) {
        // A CDN that serves the site's pages only.
        if (!(req.headers.referer || '').startsWith(SITE + '/')) {
          text('text/plain', 'forbidden', 403);
        } else if (pathname === '/hls/private.m3u8') {
          text(HLS_TYPE, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nprivate-720p.m3u8\n');
        } else if (pathname === '/hls/private-720p.m3u8') {
          // Slowly. Only the length's read and the player's own playback ask for this; the
          // page asked for the master alone, which is when the stream was detected. The
          // player asks for the page's streams before the length is known, and its pick
          // waits for it.
          setTimeout(() => text(HLS_TYPE, playlist(1800)), 2000);
        } else {
          text('text/plain', 'not found', 404);
        }
      } else if (pathname === '/watch') {
        // A playlist known by its Content-Type alone.
        text(`${HLS_TYPE}; charset=utf-8`, playlist(1800));
      } else if (pathname === '/manifest') {
        text('application/dash+xml', fs.readFileSync(path.join(FIXTURES, 'dash-template/manifest.mpd'), 'utf8'));
      } else if (pathname === '/page/mp4') {
        // The film at once, the ad after it: the newest MP4, which the player used to pick.
        text('text/html; charset=utf-8', page('film and ad',
            '<video muted preload="auto" id="ad" style="width: 160px; height: 90px"></video>', `
              document.querySelector('video').src = '/media/film.mp4' + location.search;
              setTimeout(() => {
                document.getElementById('ad').src = '/media/ad.mp4' + location.search;
              }, 200);`));
      } else if (pathname === '/page/manifests') {
        // A 9-second intro with an extension, then the episode and a DASH manifest without.
        text('text/html; charset=utf-8', page('manifests', '', `
              const c = new URLSearchParams(location.search).get('c');
              fetch('/hls/intro.m3u8?c=' + c)
                  .then(() => fetch('/watch?v=' + c))
                  .then(() => fetch('/manifest?id=' + c));`));
      } else if (pathname === '/page/pieces') {
        // A short title, and the pieces of it its player fetched: the init segment, then
        // media segments.
        text('text/html; charset=utf-8', page('pieces', '', `
              fetch('/fmp4/index.m3u8' + location.search)
                  .then(() => fetch('/fmp4/init.mp4' + location.search))
                  .then(() => fetch('/fmp4/seg-000.mp4' + location.search))
                  .then(() => fetch('/fmp4/seg-001.mp4' + location.search));`));
      } else if (pathname === '/page/slow-piece') {
        // The same, the last piece's length still being read when the player picks.
        text('text/html; charset=utf-8', page('slow-piece', '', `
              fetch('/fmp4-slow/index.m3u8' + location.search)
                  .then(() => fetch('/fmp4-slow/init.mp4' + location.search))
                  .then(() => fetch('/fmp4-slow/seg-000.mp4' + location.search))
                  .then(() => fetch('/fmp4-slow/seg-001.mp4' + location.search))
                  .then(() => fetch('/fmp4-slow/seg-002.mp4' + location.search));`));
      } else if (pathname === '/page/film-and-stream') {
        // The 320-second film in the page's video, then a longer stream the page loads beside it.
        text('text/html; charset=utf-8', page('film and stream', '', `
              document.querySelector('video').src = '/media/film-long.mp4' + location.search;
              setTimeout(() => fetch('/hls/extra.m3u8' + location.search), 200);`));
      } else if (pathname === '/page/ad-in-video') {
        // A 10-second ad in the page's video, and the 12-minute stream.
        text('text/html; charset=utf-8', page('ad in video', '', `
              document.querySelector('video').src = '/media/ad.mp4' + location.search;
              setTimeout(() => fetch('/hls/extra.m3u8' + location.search), 200);`));
      } else if (pathname === '/page/mse') {
        // An MSE player, as hls.js is: the video's length is the manifest's, set on the
        // MediaSource. The 4.5-minute clip it plays, then a 12-minute stream the page loads
        // beside it.
        text('text/html; charset=utf-8', page('mse', '', `
              const video = document.querySelector('video');
              const media = new MediaSource();
              video.src = URL.createObjectURL(media);
              media.addEventListener('sourceopen', async () => {
                const buffer = media.addSourceBuffer('video/mp4; codecs="avc1.42c01e,mp4a.40.2"');
                buffer.appendBuffer(await (await fetch('/mse/init.m4s')).arrayBuffer());
                await new Promise((resolve) => buffer.addEventListener('updateend', resolve, {once: true}));
                media.duration = 270;
                fetch('/hls/clip.m3u8' + location.search).then(() => fetch('/hls/extra.m3u8' + location.search));
              });`));
      } else if (pathname === '/page/thumbnails') {
        // The seek bar's thumbnails first, then the clip: as long, and newer.
        text('text/html; charset=utf-8', page('thumbnails', '', `
              fetch('/hls/thumbnails.m3u8' + location.search)
                  .then(() => fetch('/hls/clip.m3u8' + location.search));`));
      } else if (pathname === '/page/thumbnails-alone') {
        // The thumbnails, and the clip only once the player would long have opened.
        text('text/html; charset=utf-8', page('thumbnails alone', '', `
              fetch('/hls/thumbnails.m3u8' + location.search)
                  .then(() => setTimeout(() => fetch('/hls/clip.m3u8' + location.search), 4000));`));
      } else if (pathname === '/page/tiles') {
        // Thumbnails that do not say so, then the clip.
        text('text/html; charset=utf-8', page('tiles', '', `
              fetch('/hls/tiles.m3u8' + location.search)
                  .then(() => fetch('/hls/clip.m3u8' + location.search));`));
      } else if (pathname === '/page/private') {
        // A 12-minute stream first, then the half-hour one only the site's pages may read.
        text('text/html; charset=utf-8', page('private', '', `
              fetch('/hls/extra.m3u8' + location.search)
                  .then(() => fetch('/hls/private.m3u8' + location.search));`));
      } else {
        text('text/plain', 'not found', 404);
      }
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });

    // The site on the auto-enable list: the player opens by itself once a source is
    // detected, and the background reads the lengths of what it detects.
    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site + '/']})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, SITE);
  });

  after(async function() {
    await browser.switchFrame(null);
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
    if (workDir) fs.rmSync(workDir, {recursive: true, force: true});
  });

  it('plays the film, not the ad the page loaded after it', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/mp4?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/media/film.mp4?c=${c}`, `${SITE}/media/ad.mp4?c=${c}`]));
    expect(state.source).toBe(`${SITE}/media/film.mp4?c=${c}`);
    // Its length came from its movie header, read where the media data ends.
    const header = requests.filter((r) => r.path === '/media/film.mp4' && r.range === `bytes=${filmMoovAt}-${filmMoovAt + 65535}`);
    expect(header.length).toBeGreaterThanOrEqual(1);
  });

  it('finds manifests by their Content-Type, and plays the longest stream', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/manifests?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([
      `${SITE}/hls/intro.m3u8?c=${c}`, `${SITE}/watch?v=${c}`, `${SITE}/manifest?id=${c}`,
    ]));
    expect(state.source).toBe(`${SITE}/watch?v=${c}`);
  });

  it('plays a short stream, not the pieces of it the page fetched', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/pieces?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([
      `${SITE}/fmp4/index.m3u8?c=${c}`, `${SITE}/fmp4/init.mp4?c=${c}`, `${SITE}/fmp4/seg-001.mp4?c=${c}`,
    ]));
    expect(state.source).toBe(`${SITE}/fmp4/index.m3u8?c=${c}`);
  });

  it('plays a short stream, not a piece of it whose length is still being read', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/slow-piece?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([
      `${SITE}/fmp4-slow/index.m3u8?c=${c}`, `${SITE}/fmp4-slow/seg-000.mp4?c=${c}`, `${SITE}/fmp4-slow/seg-002.mp4?c=${c}`,
    ]));
    expect(state.source).toBe(`${SITE}/fmp4-slow/index.m3u8?c=${c}`);
    // Its length was asked for: the piece was among the sources while the player waited.
    expect(requests.some((r) => r.path === '/fmp4-slow/seg-002.mp4' && r.search === `?c=${c}` && r.range)).toBe(true);
  });

  it('plays the film in the page\'s video, not a longer stream the page loads beside it', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/film-and-stream?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/media/film-long.mp4?c=${c}`, `${SITE}/hls/extra.m3u8?c=${c}`]));
    // The longest is the 12-minute stream; the page's video plays the 320-second film.
    expect(state.source).toBe(`${SITE}/media/film-long.mp4?c=${c}`);
  });

  it('plays the stream as long as the page\'s MSE video, not a longer one', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/mse?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/hls/clip.m3u8?c=${c}`, `${SITE}/hls/extra.m3u8?c=${c}`]));
    expect(state.source).toBe(`${SITE}/hls/clip.m3u8?c=${c}`);
  });

  it('plays the longest over a short video in the page: an ad', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/ad-in-video?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/media/ad.mp4?c=${c}`, `${SITE}/hls/extra.m3u8?c=${c}`]));
    expect(state.source).toBe(`${SITE}/hls/extra.m3u8?c=${c}`);
  });

  it('plays the video, not the seek bar\'s thumbnails the page asked for first', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/thumbnails?c=${c}`);
    const state = await playerSources();
    // Listed, to choose by hand.
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/hls/thumbnails.m3u8?c=${c}`, `${SITE}/hls/clip.m3u8?c=${c}`]));
    expect(state.source).toBe(`${SITE}/hls/clip.m3u8?c=${c}`);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });

  it('does not open on the thumbnails alone, and opens on the video when it comes', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/thumbnails-alone?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/hls/thumbnails.m3u8?c=${c}`, `${SITE}/hls/clip.m3u8?c=${c}`]));
    expect(state.source).toBe(`${SITE}/hls/clip.m3u8?c=${c}`);
  });

  it('plays the next stream when the one it picked fails to load: thumbnails that do not say so', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/tiles?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/hls/tiles.m3u8?c=${c}`, `${SITE}/hls/clip.m3u8?c=${c}`]));
    // It tried the tiles first: the older of two as long.
    expect(requests.some((r) => r.path.startsWith('/tiles/') && r.search === `?c=${c}`)).toBe(true);
    expect(state.source).toBe(`${SITE}/hls/clip.m3u8?c=${c}`);
    expect(state.readyState).toBeGreaterThanOrEqual(2);
  });

  it('reads a length with the page\'s own headers, and waits for a slow one', async function() {
    const c = Date.now();
    await browser.url(`${SITE}/page/private?c=${c}`);
    const state = await playerSources();
    expect(state.sources).toEqual(expect.arrayContaining([`${SITE}/hls/extra.m3u8?c=${c}`, `${SITE}/hls/private.m3u8?c=${c}`]));
    // Read without the page's Referer, or not waited for, the half-hour stream's length is
    // unknown: it ranks as ten minutes, under the twelve of the other.
    expect(state.source).toBe(`${SITE}/hls/private.m3u8?c=${c}`);
    const privateReads = requests.filter((r) => r.path.startsWith('/hls/private'));
    expect(privateReads.map((r) => r.path)).toContain('/hls/private-720p.m3u8');
    expect(privateReads.filter((r) => !r.referer)).toEqual([]);
  });
});
