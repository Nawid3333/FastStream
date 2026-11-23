// Saving fMP4 streams (an init segment instead of MPEG-TS) through HLS, and DASH with separate
// tracks.
// Each saved file is decoded end to end with ffmpeg: a container with wrong sample offsets still
// loads.
// Shapes: fMP4 with its audio in every fragment (one traf per track), fMP4 video only, DASH, TS.
// Also: a save of a level whose init segment is not downloaded yet, and a failed one, which leaves
// nothing pinned.
// The streams are cut from the MP4 fixture by ffmpeg into the gitignored fixtures directory.
// DASH2MP4 falls back to the remuxer: each save reports which one made the file, and each case
// expects one.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';
import {pageState, phaseTimer} from './diagnostics.mjs';
import {withTempFile} from '../tempFile.mjs';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');

/**
 * Decodes a file's audio and reports what share of its energy sits at one frequency.
 * Frame count and duration come from the sample table, and loudness does not tell tone from noise:
 * one Goertzel bin over 1-9 s does.
 * @param {string} file - The file to measure.
 * @param {number} frequency - The frequency to look for, in Hz.
 * @return {number|null} The share from 0 to 1, or null if it could not be measured.
 */
function toneShare(file, frequency) {
  const rate = 8000;
  const pcm = spawnSync('ffmpeg', [
    '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-',
  ], {maxBuffer: 64 * 1024 * 1024});
  if (pcm.error || pcm.status !== 0) return null;

  const total = Math.floor(pcm.stdout.length / 2);
  const start = Math.min(rate, total);
  const end = Math.min(total, rate * 9);
  const count = end - start;
  if (count <= 0) return null;

  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / rate);
  let previous = 0;
  let beforePrevious = 0;
  let energy = 0;
  for (let i = start; i < end; i++) {
    const sample = pcm.stdout.readInt16LE(i * 2);
    const current = sample + coefficient * previous - beforePrevious;
    beforePrevious = previous;
    previous = current;
    energy += sample * sample;
  }
  const power = previous * previous + beforePrevious * beforePrevious -
    coefficient * previous * beforePrevious;
  return energy > 0 ? (2 * power / count) / energy : 0;
}

/**
 * Decodes a saved file end to end with ffmpeg and counts what is in it.
 * @param {string} base64 - The saved file.
 * @return {Object} {decodeErrors, video, audio, audioToneShare}, video and audio
 *   being {frames, duration, start} or null when the file has no such stream, and the
 *   last the share of the audio that is the fixtures' 440 Hz tone (see toneShare).
 */
function decodeWithFfmpeg(base64) {
  // A fresh mkdtemp directory per run: CodeQL js/insecure-temporary-file — see tempFile.mjs.
  const bytes = Buffer.from(base64, 'base64');
  return withTempFile('saved.mp4', bytes, (file) => {
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {encoding: 'utf8'});
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,duration,start_time',
      '-of', 'json', file,
    ], {encoding: 'utf8'});
    const missing = decode.error || probe.error;
    if (missing) {
      throw new Error(`ffmpeg and ffprobe must be on PATH to inspect a saved file: ${missing.message}`);
    }
    const streams = JSON.parse(probe.stdout || '{"streams":[]}').streams;
    const summarise = (type) => {
      const found = streams.find((stream) => stream.codec_type === type);
      return found ? {
        codec: found.codec_name, frames: Number(found.nb_read_frames), duration: Number(found.duration),
        start: Number(found.start_time),
      } : null;
    };
    const audio = summarise('audio');
    return {
      decodeErrors: (decode.stderr || '').trim(),
      video: summarise('video'),
      audio,
      audioToneShare: audio ? toneShare(file, 440) : null,
    };
  });
}

/**
 * Counts the video frames in the MP4 fixture: what a full save of a stream cut from it holds.
 * @return {number} The frame count.
 */
function sourceFrameCount() {
  const {stdout, error} = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', MP4_FIXTURE,
  ], {encoding: 'utf8'});
  if (error) {
    throw new Error(`ffprobe must be on PATH to count the source's frames: ${error.message}`);
  }
  return Number(stdout.trim());
}

/**
 * Counts the frames of each kind in a fixture, as ffmpeg decodes it from its playlist,
 * and finds when each kind starts.
 * @param {string} name - Directory under fixtures/.
 * @param {string} [index] - Its playlist or manifest.
 * @return {Object} {frames, start} per codec type ('video', 'audio').
 */
function fixtureStreams(name, index = 'index.m3u8') {
  const probe = (entries, format) => {
    const {stdout, error} = spawnSync('ffprobe', [
      '-v', 'error', ...entries, '-of', format, path.join(fixturesDir, name, index),
    ], {encoding: 'utf8'});
    if (error) {
      throw new Error(`ffprobe must be on PATH to count a fixture's frames: ${error.message}`);
    }
    return stdout;
  };
  // Each kind starts at its earliest packet: since ffmpeg 9.1, ffprobe gives every stream of an
  // HLS playlist the same start_time, the earliest of them.
  const starts = {};
  for (const line of probe(['-show_entries', 'packet=codec_type,pts_time'], 'csv=p=0').split('\n')) {
    const [type, time] = line.trim().split(',');
    const pts = Number(time);
    if (type && Number.isFinite(pts)) starts[type] = Math.min(starts[type] ?? Infinity, pts);
  }
  const streams = JSON.parse(probe(['-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames'], 'json')).streams;
  return Object.fromEntries(streams.map((stream) =>
    [stream.codec_type, {frames: Number(stream.nb_read_frames), start: starts[stream.codec_type]}]));
}

const HLS_OUTPUT = [
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
  '-hls_segment_filename', 'seg%d.m4s', 'index.m3u8',
];

// Transport-stream segments, which HLS2MP4 remuxes, where MP4Merger takes fMP4 ones.
const HLS_TS_OUTPUT = [
  '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', 'seg%d.ts', 'index.m3u8',
];

// Separate adaptation sets, so the video and the audio arrive as two tracks with
// two initialization segments and two timescales, unlike the muxed HLS above.
const DASH_OUTPUT = [
  '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1',
  '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'manifest.mpd',
];

// No -shortest: where it cut depends on the ffmpeg build, and the tests count frames against
// sample.mp4.
const TONE_INPUT = [
  '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
];

/**
 * Cuts a stream out of the MP4 fixture, unless it is already there.
 *
 * @param {string} name - Directory under fixtures/ to write into.
 * @param {string} indexFile - The playlist or manifest the output ends in.
 * @param {string[]} inputArgs - ffmpeg arguments that select what goes in.
 * @param {string[]} outputArgs - ffmpeg arguments that say how it is packaged.
 * @return {void}
 */
function ensureFixture(name, indexFile, inputArgs, outputArgs) {
  const dir = path.join(fixturesDir, name);
  // The marker is written last and holds the arguments: a killed run or other arguments rebuild the
  // fixture.
  const done = path.join(dir, '.complete');
  const args = ['-y', '-v', 'error', ...inputArgs, ...outputArgs];
  const recipe = JSON.stringify(args);
  if (fs.existsSync(path.join(dir, indexFile)) && fs.existsSync(done) &&
      fs.readFileSync(done, 'utf8') === recipe) {
    return;
  }

  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  const {status, error, stderr} = spawnSync('ffmpeg', args, {cwd: dir, encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(
        `could not build the ${name} fixture with ffmpeg` +
        `${error ? ` (${error.message})` : ''}. CI installs ffmpeg; ` +
        `locally it must be on PATH.\n${stderr || ''}`,
    );
  }
  fs.writeFileSync(done, recipe);
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
 * Plays until fragments land, saves what has downloaded, and reports what came out.
 * decodeOk and duration come from the moov, so trakCount and mdatBytes are read from the boxes.
 * @param {Function} [prepare] - Run in the page once everything has downloaded, before
 *   the save.
 * @param {boolean} [remux] - Whether the remuxer, not MP4Merger, should make the file.
 * @return {Promise<Object>} {saveError, blobSize, decodeOk, duration,
 *   trakCount, mdatBytes, moofs}; saveError also says when the other one made the file
 */
async function saveAndInspect(prepare, remux = false) {
  // Each phase is logged with its time, so a test timeout shows which one it spent; failures carry
  // pageState.
  let result;
  try {
    result = await saveAndInspectPhases(phaseTimer(), prepare);
  } catch (e) {
    throw new Error(`${e.message} ${JSON.stringify(await pageState())}`);
  }
  if (result.saveError === null && (result.moofs > 0) !== remux) {
    result.saveError = remux ? 'MP4Merger made the file, not the remuxer' :
      'MP4Merger did not take this stream: the remuxer made the file';
  }
  return result;
}

async function saveAndInspectPhases(phase, prepare) {
  await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('video')),
      {timeout: 30000, timeoutMsg: 'no <video> element was created'});
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelector('video').readyState >= 2),
      {timeout: 30000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});
  phase('ready');

  await browser.execute(() => document.querySelector('video').play().catch(() => {}));
  // The frame counts below compare against the whole source, so everything the stream
  // has must be in before saving; a fixed pause only holds while the machine is fast.
  try {
    await browser.waitUntil(
        async () => browser.execute(() => window.fastStream.player.canSave().isComplete),
        {timeout: 45000, interval: 250});
  } catch (e) {
    const state = await browser.execute(() => {
      const video = document.querySelector('video');
      return {
        canSave: window.fastStream.player.canSave(),
        currentTime: video.currentTime, duration: video.duration, ended: video.ended,
        buffered: Array.from({length: video.buffered.length},
            (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
      };
    });
    throw new Error(`the stream never finished downloading: ${JSON.stringify(state)}`);
  }
  phase('downloaded');
  if (prepare) await browser.execute(prepare);

  const saved = await browser.execute(() => new Promise((done) => {
    const info = {
      saveError: null, blobSize: null, decodeOk: null, duration: null,
      trakCount: null, mdatBytes: null, moofs: null,
    };

    /**
     * Reads the top-level boxes of an MP4 and counts the tracks in its moov.
     * @param {ArrayBuffer} buffer - The whole file.
     * @return {Object} {trakCount, mdatBytes, moofs}
     */
    const inspect = (buffer) => {
      const view = new DataView(buffer);
      const fourcc = (at) => String.fromCharCode(
          view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
      let trakCount = 0;
      let mdatBytes = 0;
      let moofs = 0;
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
        } else if (type === 'moof') {
          moofs++;
        } else if (type === 'moov') {
          for (let i = at + 8; i + 4 <= at + size; i++) {
            if (fourcc(i) === 'trak') trakCount++;
          }
        }
        if (size < 8) break;
        at += size;
      }
      return {trakCount, mdatBytes, moofs};
    };

    window.fastStream.player.saveVideo({
      onProgress: () => {},
      registerCancel: () => {},
      partialSave: true,
    }).then(async (result) => {
      info.blobSize = result.blob.size;
      Object.assign(info, inspect(await result.blob.arrayBuffer()));
      info.base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(result.blob);
      });

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
  }));
  phase('saved');
  return saved;
}

describe('Save video (locally generated fMP4)', function() {
  before(function() {
    // Video-only: sample.mp4 has no audio track.
    ensureFixture('hls-fmp4-video', 'index.m3u8', ['-i', MP4_FIXTURE, '-c', 'copy'], HLS_OUTPUT);
    // Muxed: the same video plus a generated tone, both in every fragment.
    ensureFixture('hls-fmp4-muxed', 'index.m3u8', TONE_INPUT, HLS_OUTPUT);
    // The same content as two separately delivered tracks.
    ensureFixture('dash-separate', 'manifest.mpd', TONE_INPUT, DASH_OUTPUT);
    // Video-only, cut after 298 of its 300 frames in decode order. The cut depends on no
    // encoder or muxer choice, as the video is copied.
    ensureFixture('hls-fmp4-cut', 'index.m3u8', ['-i', MP4_FIXTURE, '-c', 'copy', '-frames:v', '298'], HLS_OUTPUT);
    // The same in transport streams, which HLS2MP4 remuxes: the whole video with the tone,
    // and the cut video.
    ensureFixture('hls-ts-muxed', 'index.m3u8', TONE_INPUT, HLS_TS_OUTPUT);
    ensureFixture('hls-ts-cut', 'index.m3u8', ['-i', MP4_FIXTURE, '-c', 'copy', '-frames:v', '298'], HLS_TS_OUTPUT);
    // The tone starting half a second after the video, so that the audio is the track held back.
    ensureFixture('hls-ts-late-audio', 'index.m3u8', [
      '-i', MP4_FIXTURE, '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9.5',
      '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k',
    ], HLS_TS_OUTPUT);
  });

  // The saved file keeps the last segment's frames, the edit list's full length and the audio's
  // start against the video.
  for (const [fixture, what] of [
    ['hls-ts-muxed', 'every frame of a transport stream, video and audio, in sync'],
    ['hls-ts-cut', 'a frame shown after the last one decoded, from a transport stream'],
    ['hls-ts-late-audio', 'the audio of a transport stream that starts after its video, in sync'],
  ]) {
    it(`keeps ${what}`, async function() {
      const source = fixtureStreams(fixture);
      await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/${fixture}/index.m3u8`);
      const result = await saveAndInspect();
      const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
      delete result.base64;

      console.log('      source:', JSON.stringify(source), 'result:', JSON.stringify(result),
          'ffmpeg:', JSON.stringify(decoded));
      expect(result.saveError).toBe(null);
      expect(decoded.decodeErrors).toBe('');
      expect(decoded.video.frames).toBe(source.video.frames);
      expect(decoded.audio?.frames ?? null).toBe(source.audio?.frames ?? null);
      if (source.audio) {
        // To 5 ms: the audio's start against the video's, as in the stream.
        expect(decoded.audio.start - decoded.video.start).toBeCloseTo(source.audio.start - source.video.start, 2);
      }
    });
  }

  it('saves a video-only fMP4 level into a file that decodes and holds media', async function() {
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/hls-fmp4-video/index.m3u8');
    const result = await saveAndInspect();
    const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
    delete result.base64;

    console.log('      result:', JSON.stringify(result), 'ffmpeg:', JSON.stringify(decoded));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.trakCount).toBe(1);
    expect(result.mdatBytes).toBeGreaterThan(100000);
    expect(decoded.decodeErrors).toBe('');
    expect(decoded.video.frames).toBe(sourceFrameCount());
    expect(decoded.audio).toBe(null);
  });

  it('keeps a frame that is shown after the last one decoded', async function() {
    // A stream cut in decode order (as a recording stopped inside a GOP): the save keeps all 298
    // frames.
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/hls-fmp4-cut/index.m3u8');
    const result = await saveAndInspect();
    const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
    delete result.base64;

    console.log('      result:', JSON.stringify(result), 'ffmpeg:', JSON.stringify(decoded));
    expect(result.saveError).toBe(null);
    expect(decoded.decodeErrors).toBe('');
    expect(decoded.video.frames).toBe(298);
  });

  it('saves an fMP4 level that carries its own audio, keeping both tracks', async function() {
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/hls-fmp4-muxed/index.m3u8');
    const result = await saveAndInspect();
    const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
    delete result.base64;

    console.log('      result:', JSON.stringify(result), 'ffmpeg:', JSON.stringify(decoded));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.duration).toBeGreaterThan(0);
    expect(result.trakCount).toBe(2);
    expect(result.mdatBytes).toBeGreaterThan(100000);
    expect(decoded.decodeErrors).toBe('');
    expect(decoded.video.frames).toBe(sourceFrameCount());
    // The audio's length comes from the sample table; the 440 Hz share shows its samples point at
    // the right bytes.
    expect(decoded.audio.frames).toBeGreaterThan(0);
    expect(decoded.audio.duration).toBeGreaterThan(9.5);
    expect(decoded.audio.duration).toBeLessThan(10.6);
    expect(decoded.audioToneShare).toBeGreaterThan(0.8);
  });

  it('saves a DASH stream with separate audio and video tracks, decoding both', async function() {
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/dash-separate/manifest.mpd');
    const result = await saveAndInspect();
    const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
    delete result.base64;

    console.log('      result:', JSON.stringify(result), 'ffmpeg:', JSON.stringify(decoded));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.trakCount).toBe(2);
    expect(result.mdatBytes).toBeGreaterThan(100000);
    expect(decoded.decodeErrors).toBe('');
    expect(decoded.video.frames).toBe(sourceFrameCount());
    // The two tracks keep different timescales, so their edit lists are computed
    // separately and a mistake there shows up as a length or start that is off.
    expect(decoded.audio.frames).toBeGreaterThan(0);
    expect(decoded.audio.duration).toBeGreaterThan(9.5);
    expect(decoded.audio.duration).toBeLessThan(10.6);
    expect(decoded.audioToneShare).toBeGreaterThan(0.8);
  });

  it('saves a DASH stream in WebM (VP9 and Opus) by copying both into an MP4', async function() {
    // MP4Merger cannot join WebM: the remuxer copies the packets (no WebCodecs encoders, absent on
    // Windows).
    const source = fixtureStreams('dash-webm', 'manifest.mpd');
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/dash-webm/manifest.mpd');
    const result = await saveAndInspect(undefined, true);
    const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
    delete result.base64;

    console.log('      source:', JSON.stringify(source), 'result:', JSON.stringify(result),
        'ffmpeg:', JSON.stringify(decoded));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.trakCount).toBe(2);
    expect(decoded.decodeErrors).toBe('');
    expect(decoded.video.codec).toBe('vp9');
    expect(decoded.audio.codec).toBe('opus');
    expect(decoded.video.frames).toBe(source.video.frames);
    expect(decoded.audio.duration).toBeGreaterThan(8.5);
    expect(decoded.audio.duration).toBeLessThan(9.6);
    expect(decoded.audioToneShare).toBeGreaterThan(0.8);
  });

  it('saves an fMP4 level whose init segment has not been downloaded', async function() {
    // as on a level just switched to: the init segment is downloaded first
    await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/hls-fmp4-video/index.m3u8');
    const result = await saveAndInspect(() => {
      const client = window.fastStream;
      client.freeFragment(client.getFragments(client.player.getCurrentVideoLevelID())[-1]);
    });
    const decoded = result.base64 ? decodeWithFfmpeg(result.base64) : null;
    delete result.base64;

    console.log('      result:', JSON.stringify(result), 'ffmpeg:', JSON.stringify(decoded));
    expect(result.saveError).toBe(null);
    expect(result.decodeOk).toBe(true);
    expect(result.trakCount).toBe(1);
    expect(decoded.decodeErrors).toBe('');
    expect(decoded.video.frames).toBe(sourceFrameCount());
  });

  // A save pins each fragment it will write and unpins it once read or when the save fails.
  const PINNED = [
    ['HLS', '/fixtures/hls-fmp4-video/index.m3u8'],
    ['DASH', '/fixtures/dash-separate/manifest.mpd'],
  ];
  for (const [name, source] of PINNED) {
    it(`leaves no fragment pinned after a ${name} save whose init segment failed`, async function() {
      await openPlayer(globalThis.__E2E_FIXTURES_ORIGIN__ + source);
      await browser.waitUntil(
          async () => browser.execute(() => document.querySelector('video')?.readyState >= 2),
          {timeout: 30000, timeoutMsg: 'video never reached HAVE_CURRENT_DATA'});

      const result = await browser.execute(() => new Promise((done) => {
        import('/player/enums/ReferenceTypes.mjs').then(async ({ReferenceTypes}) => {
          const client = window.fastStream;
          const player = client.player;
          const levels = [player.getCurrentVideoLevelID(), player.getCurrentAudioLevelID()].filter(Boolean);
          // The init segment is not there, and downloading it fails.
          client.freeFragment(client.getFragments(levels[0])[-1]);
          player.downloadFragment = () => Promise.reject(new Error('Failed to download fragment'));

          // saveError, not error: over WebDriver classic (see tests/e2e/bidi.mjs) a result
          // with an `error` field reads as a failed command, and this one has it on success.
          let saveError = null;
          try {
            await player.saveVideo({onProgress: () => {}, registerCancel: () => {}, partialSave: false});
          } catch (e) {
            saveError = e.message;
          }
          const pinned = levels.flatMap((level) => (client.getFragments(level) || [])
              .filter((frag) => frag && frag.references.includes(ReferenceTypes.SAVER))
              .map((frag) => `${level}/${frag.sn}`));
          done({saveError, pinned});
        }).catch((e) => done({saveError: 'test setup: ' + e.message, pinned: null}));
      }));
      console.log('      result:', JSON.stringify(result));

      expect(result.saveError).toBe('Failed to download fragment');
      expect(result.pinned).toEqual([]);
    });
  }
});
