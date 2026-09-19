// Regression coverage for saving an fMP4 HLS stream - the packaging that has an
// out-of-band initialization segment (#EXT-X-MAP) instead of MPEG transport
// streams.
//
// save-video.e2e.mjs covers HLS only through a transport-stream stream and DASH
// only through one with separate audio and video tracks, so nothing there
// touches the two shapes this file does:
//
// - fMP4 whose level carries its own audio. Each fragment is one moof holding a
//   traf per track. HLSPlayer.saveVideo used to send this to HLS2MP4, a
//   transport-stream demuxer, and MP4Merger threw "Unsupported trafs count!" on
//   any fragment with more than one traf.
// - fMP4 with a video track and no audio at all. Its init segment made
//   HLSPlayer.saveVideo pass an audio-less level to a path that required both.
//
// Both streams are cut from the MP4 fixture by ffmpeg, the same way the WebM
// fixture is, so nothing large is committed. The fixtures directory is
// gitignored and rebuilt when missing.
//
// WebCodecs is switched off in the page before saving. DASH2MP4 answers a
// merger failure by silently re-encoding the whole clip, which would turn a
// broken merger into a slow pass; what is under test here is the merger.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');

/**
 * Cuts an fMP4 HLS stream out of the MP4 fixture, unless it is already there.
 *
 * @param {string} name - Directory under fixtures/ to write into.
 * @param {string[]} inputArgs - ffmpeg arguments that select what goes in.
 * @return {void}
 */
function ensureHlsFixture(name, inputArgs) {
  const dir = path.join(fixturesDir, name);
  if (fs.existsSync(path.join(dir, 'index.m3u8'))) return;

  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  const args = [
    '-y', '-v', 'error', ...inputArgs,
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', 'seg%d.m4s', 'index.m3u8',
  ];
  const {status, error, stderr} = spawnSync('ffmpeg', args, {cwd: dir, encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(
        `could not build the ${name} fixture with ffmpeg` +
        `${error ? ` (${error.message})` : ''}. CI installs ffmpeg; ` +
        `locally it must be on PATH.\n${stderr || ''}`,
    );
  }
}

/**
 * Opens the web player at a given source, same seam as save-video.e2e.mjs.
 * @param {string} source - Media URL to load, passed via the page's hash.
 * @return {Promise<void>}
 */
async function openPlayer(source) {
  await browser.url('/player/index.html?t=' + Date.now() + '#' + source);
}

/**
 * Plays long enough for fragments to land, saves what has downloaded, and
 * reports what came out: whether it decodes, and what its container holds.
 *
 * decodeOk and duration both come out of the moov, so they are content with a
 * file that has a valid header and no media in it. trakCount and mdatBytes are
 * read from the boxes themselves for that reason.
 *
 * @return {Promise<Object>} {saveError, blobSize, decodeOk, duration,
 *   trakCount, mdatBytes}
 */
async function saveAndInspect() {
  await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('video')),
      {timeout: 30000, timeoutMsg: 'no <video> element was created'});
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('video').readyState >= 2),
      {timeout: 60000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});

  await browser.execute(() => document.querySelector('video').play().catch(() => {}));
  await new Promise((r) => setTimeout(r, 4000));

  return browser.executeAsync((done) => {
    const info = {
      saveError: null, blobSize: null, decodeOk: null, duration: null,
      trakCount: null, mdatBytes: null,
    };

    // See the header comment: a merger failure must surface, not be re-encoded.
    window.VideoDecoder = undefined;

    /**
     * Reads the top-level boxes of an MP4 and counts the tracks in its moov.
     * @param {ArrayBuffer} buffer - The whole file.
     * @return {Object} {trakCount, mdatBytes}
     */
    const inspect = (buffer) => {
      const view = new DataView(buffer);
      const fourcc = (at) => String.fromCharCode(
          view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
      let trakCount = 0;
      let mdatBytes = 0;
      let at = 0;
      while (at + 8 <= buffer.byteLength) {
        let size = view.getUint32(at);
        const type = fourcc(at + 4);
        if (size === 1) {
          size = Number(view.getBigUint64(at + 8));
        } else if (size === 0) {
          size = buffer.byteLength - at;
        }
        if (type === 'mdat') {
          mdatBytes += size;
        } else if (type === 'moov') {
          for (let i = at + 8; i + 4 <= at + size; i++) {
            if (fourcc(i) === 'trak') trakCount++;
          }
        }
        if (size < 8) break;
        at += size;
      }
      return {trakCount, mdatBytes};
    };

    window.fastStream.player.saveVideo({
      onProgress: () => {},
      registerCancel: () => {},
      partialSave: true,
    }).then(async (result) => {
      info.blobSize = result.blob.size;
      Object.assign(info, inspect(await result.blob.arrayBuffer()));

      const url = URL.createObjectURL(result.blob);
      const testVideo = document.createElement('video');
      testVideo.src = url;
      const finish = () => {
        URL.revokeObjectURL(url);
        done(info);
      };
      testVideo.onloadedmetadata = () => {
        info.decodeOk = true;
        info.duration = testVideo.duration;
        finish();
      };
      testVideo.onerror = () => {
        info.decodeOk = false;
        finish();
      };
      setTimeout(() => {
        if (info.decodeOk === null) {
          info.decodeOk = false;
          finish();
        }
      }, 15000);
    }).catch((e) => {
      info.saveError = ((e && e.message) ? e.message + '\n' : '') + ((e && e.stack) || String(e));
      done(info);
    });
  });
}

describe('Save video (fMP4 HLS)', function() {
  before(function() {
    // Video-only: sample.mp4 has no audio track.
    ensureHlsFixture('hls-fmp4-video', ['-i', MP4_FIXTURE, '-c', 'copy']);
    // Muxed: the same video plus a generated tone, both in every fragment.
    ensureHlsFixture('hls-fmp4-muxed', [
      '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-shortest',
    ]);
  });

  it('saves a video-only fMP4 level into a file that decodes and holds media', async function() {
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/hls-fmp4-video/index.m3u8');
    const result = await saveAndInspect();

    console.log('      result:', JSON.stringify(result));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.trakCount).toBe(1);
    expect(result.mdatBytes).toBeGreaterThan(100000);
  });

  it('saves an fMP4 level that carries its own audio, keeping both tracks', async function() {
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/hls-fmp4-muxed/index.m3u8');
    const result = await saveAndInspect();

    console.log('      result:', JSON.stringify(result));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.trakCount).toBe(2);
    expect(result.mdatBytes).toBeGreaterThan(100000);
  });
});
