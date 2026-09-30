// Regression coverage for saving fMP4 streams - the packaging that has an
// out-of-band initialization segment (#EXT-X-MAP in HLS) instead of MPEG
// transport streams - through HLS, and through DASH with separate tracks.
//
// Each saved file is decoded end to end with ffmpeg and its frames counted
// against the source. What the page can see is the container, and a container
// whose sample table points at the wrong bytes still loads and reports a
// duration; only decoding shows the offsets and edit lists are right.
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
// And two things around the init segments: a save of an HLS level whose init segment is
// not downloaded yet (a level just switched to), and a save that fails while getting one,
// which must leave no fragment pinned.
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
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';
import {pageState, phaseTimer} from './diagnostics.mjs';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');

/**
 * Decodes a file's audio and reports what share of its energy sits at one frequency.
 *
 * A frame count and a duration both come out of the sample table, so a track whose
 * samples point at the wrong bytes still has them; and how loud it is does not
 * separate the tone from noise either (AAC-coded white noise measures within a dB of
 * this tone). What does is that the tone is one frequency: about 1 for the 440 Hz
 * sine the fixtures carry, near 0 for noise or silence. Goertzel, one bin, over the
 * span from 1 s to 9 s so the edges do not count.
 *
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
 *
 * The page-side checks read the container and can be satisfied by a file whose
 * sample table points at the wrong bytes: it loads, reports a duration, and
 * decodes nothing. Only decoding every frame shows the offsets are right.
 *
 * @param {string} base64 - The saved file.
 * @return {Object} {decodeErrors, video, audio, audioToneShare}, video and audio
 *   being {frames, duration, start} or null when the file has no such stream, and the
 *   last the share of the audio that is the fixtures' 440 Hz tone (see toneShare).
 */
function decodeWithFfmpeg(base64) {
  const file = path.join(os.tmpdir(), `faststream-e2e-${process.pid}-${Date.now()}.mp4`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  try {
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {encoding: 'utf8'});
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,duration,start_time',
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
        frames: Number(found.nb_read_frames), duration: Number(found.duration), start: Number(found.start_time),
      } : null;
    };
    const audio = summarise('audio');
    return {
      decodeErrors: (decode.stderr || '').trim(),
      video: summarise('video'),
      audio,
      audioToneShare: audio ? toneShare(file, 440) : null,
    };
  } finally {
    fs.rmSync(file, {force: true});
  }
}

/**
 * Counts the video frames in the MP4 fixture, which is what a full save of a
 * stream cut from it should contain.
 *
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
 * @param {string} name - Directory under fixtures/, holding index.m3u8.
 * @return {Object} {frames, start} per codec type ('video', 'audio').
 */
function fixtureStreams(name) {
  const {stdout, error} = spawnSync('ffprobe', [
    '-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,start_time',
    '-of', 'json', path.join(fixturesDir, name, 'index.m3u8'),
  ], {encoding: 'utf8'});
  if (error) {
    throw new Error(`ffprobe must be on PATH to count a fixture's frames: ${error.message}`);
  }
  return Object.fromEntries(JSON.parse(stdout).streams.map((stream) =>
    [stream.codec_type, {frames: Number(stream.nb_read_frames), start: Number(stream.start_time)}]));
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

// No -shortest: where it cut the video depended on the ffmpeg build (one from 2026-04 kept
// 298 of the 300 frames), and the tests count the saved frames against sample.mp4's.
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
  // The playlist is written before the last segment is, so the index file alone says
  // nothing about a run that was killed half way. The marker is written last, and holds
  // the arguments, so that a fixture made with other arguments is made again.
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
 * Plays long enough for fragments to land, saves what has downloaded, and
 * reports what came out: whether it decodes, and what its container holds.
 *
 * decodeOk and duration both come out of the moov, so they are content with a
 * file that has a valid header and no media in it. trakCount and mdatBytes are
 * read from the boxes themselves for that reason.
 *
 * @param {Function} [prepare] - Run in the page once everything has downloaded, before
 *   the save.
 * @return {Promise<Object>} {saveError, blobSize, decodeOk, duration,
 *   trakCount, mdatBytes}
 */
async function saveAndInspect(prepare) {
  // Each phase is logged with its time, so a run that hits the test timeout shows which
  // one it spent it in (a Windows CI run once did, with nothing else in the log), and a
  // failure carries the video and OPFS state (pageState).
  try {
    return await saveAndInspectPhases(phaseTimer(), prepare);
  } catch (e) {
    throw new Error(`${e.message} ${JSON.stringify(await pageState())}`);
  }
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

  const saved = await browser.executeAsync((done) => {
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
  });
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

  // HLS2MP4 handed hls.js's demuxer its flush flag where hls.js 1.7 takes isSampleAes, so
  // the data left at the end of the last segment was never parsed: every save lost the
  // video's last two frames and the audio's last packet. As MP4Merger did, it ended the
  // edit list where the decode timeline ends. And it placed the audio by decode times in
  // the wrong timescale, then shortened its edit by that delay: the tone fixture's audio
  // began 44 ms late against the video and lost its last frame, and audio that starts after
  // the video lost more.
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
    // A stream cut in decode order, as a recording that stopped inside a group of pictures
    // is: the last two frames decoded are gone, and a frame decoded before them is shown
    // after the point where the decode timeline ends. The edit list ended at that point,
    // so players left the frame out, and the saved file had 297 frames.
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
    // The tone is ten seconds. The length comes from the sample table, so it shows the
    // track was written, not that its samples point at the right bytes; the share of
    // the audio that is the 440 Hz tone does.
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

  it('saves an fMP4 level whose init segment has not been downloaded', async function() {
    // As on a level just switched to. HLSPlayer.saveVideo read the init segment's entry
    // without downloading it, and there was none to read.
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

  // A save pins every fragment it will write, so that none is freed before it is read,
  // and unpins each once read or when the save fails. A failure while fetching the init
  // segments came before the part that unpins: every fragment stayed pinned, and was never
  // freed again for as long as the player was open.
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

      const result = await browser.executeAsync((done) => {
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
      });
      console.log('      result:', JSON.stringify(result));

      expect(result.saveError).toBe('Failed to download fragment');
      expect(result.pinned).toEqual([]);
    });
  }
});
