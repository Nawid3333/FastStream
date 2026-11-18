// The fixtures the e2e suites make from the MP4 one with ffmpeg (onPrepare), kept in the gitignored
// fixtures dir.
// Each is kept with its recipe (recipeOf) and rebuilt when it changes; files and directories are
// never left half written.

import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {fixturesDir, MP4_FIXTURE, MP4_FIXTURE_PIN, writeFixture} from './mp4Fixture.mjs';

/**
 * Reads a file, or null when absent: no gap between check and read (CodeQL js/file-system-race).
 * @param {string} file - The file.
 * @return {?string} Its contents, or null when absent.
 */
export function readFileOrNothing(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * What a fixture is built by: its builder's code, whatever else decides its bytes (the
 * fixture's own arguments, the encoder this machine's ffmpeg has) and the MP4 fixture it
 * is made from.
 * @param {Function} builder - The function that builds it.
 * @param {...*} parts - The rest.
 * @return {string} A hash of it all.
 */
export function recipeOf(builder, ...parts) {
  return crypto.createHash('sha256')
      .update(JSON.stringify([builder.toString(), MP4_FIXTURE_PIN.sha256, ...parts]))
      .digest('hex');
}

/**
 * Builds a fixture that is one file, unless it is there, built by this recipe. The
 * recipe is kept beside it, in <file>.recipe.
 * @param {string} file - The fixture.
 * @param {string} recipe - Its recipe (recipeOf).
 * @param {function(string): (void|Promise<void>)} write - Writes it to the path given.
 * @return {Promise<void>}
 */
export async function ensureFileFixture(file, recipe, write) {
  const marker = file + '.recipe';
  if (readFileOrNothing(marker) === recipe) {
    try {
      if (fs.statSync(file).size > 0) return;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  fs.rmSync(marker, {force: true});
  await writeFixture(file, write);
  fs.writeFileSync(marker, recipe);
}

/**
 * Starts building a fixture that is a directory: false when it is there, built by this
 * recipe; otherwise it is emptied, and true. finishDirectoryFixture marks it built.
 * @param {string} dir - The fixture's directory.
 * @param {string} recipe - Its recipe (recipeOf).
 * @return {boolean} Whether to build it.
 */
export function startDirectoryFixture(dir, recipe) {
  if (readFileOrNothing(path.join(dir, '.recipe')) === recipe) return false;
  fs.rmSync(dir, {recursive: true, force: true});
  fs.mkdirSync(dir, {recursive: true});
  return true;
}

/**
 * Marks a directory fixture built, by this recipe. Written last: a run killed before it
 * leaves a directory the next run builds again.
 * @param {string} dir - The fixture's directory.
 * @param {string} recipe - Its recipe.
 */
export function finishDirectoryFixture(dir, recipe) {
  fs.writeFileSync(path.join(dir, '.recipe'), recipe);
}


// The WebM fixture is transcoded from the MP4 one rather than downloaded or
// committed: a VP9 file for the save of a DIRECT WebM source (save-video.e2e.mjs).
const WEBM_FIXTURE = path.join(fixturesDir, 'sample.webm');

/**
 * Transcodes the WebM fixture from the MP4 one if it is not already present.
 *
 * @return {Promise<void>}
 */
async function ensureWebmFixture() {
  await ensureFileFixture(WEBM_FIXTURE, recipeOf(ensureWebmFixture), (partial) => runFfmpeg([
    '-i', MP4_FIXTURE, '-t', '2',
    '-vf', 'scale=160:120', '-c:v', 'libvpx-vp9', '-b:v', '120k',
    '-cpu-used', '8', partial,
  ], 'WebM'));
}

/**
 * Runs ffmpeg, and fails with what it said.
 * @param {string[]} args - Its arguments.
 * @param {string} what - The fixture, for the message.
 * @param {string} [cwd] - Where to run it; a DASH manifest names its files relative to it.
 * @return {boolean} Whether it ran without error.
 */
function runFfmpeg(args, what, cwd) {
  const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], {cwd, encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(
        `could not build the ${what} fixture with ffmpeg` +
        `${error ? ` (${error.message})` : ''}. CI installs ffmpeg; ` +
        `locally it must be on PATH.
${stderr || ''}`,
    );
  }
  return true;
}

// 160 s of the MP4 fixture's picture over a steady tone: long enough for 16x to still have
// something to play (firefox.e2e.mjs) and for 60 s seeks either way (keybinds.e2e.mjs).
const LONG_AV_FIXTURE = path.join(fixturesDir, 'long-av.mp4');

async function ensureLongAvFixture() {
  await ensureFileFixture(LONG_AV_FIXTURE, recipeOf(ensureLongAvFixture), (partial) => runFfmpeg([
    '-stream_loop', '15', '-i', MP4_FIXTURE,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=160',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '64k', '-shortest',
    '-movflags', '+faststart', partial,
  ], 'long audio'));
}

/**
 * Picks the H.264 encoder this ffmpeg has: libx264 on Linux CI, libopenh264 in the Windows
 * builds.
 * @param {string} what - The fixture that needs it, for the message.
 * @return {string} The encoder's name.
 */
export function h264Encoder(what) {
  const {stdout} = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {encoding: 'utf8'});
  const encoder = ['libx264', 'libopenh264'].find((name) => (stdout || '').split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === name));
  if (!encoder) {
    throw new Error(`ffmpeg has neither libx264 nor libopenh264 for the ${what} fixture`);
  }
  return encoder;
}

// 200 s of one still picture at 1 fps, a few KB: an episode for MPV autoplay
// (mpv-episodes.e2e.mjs), which holds a next stream under StreamPick's SHORT_S as an ad.
const EPISODE_FIXTURE = path.join(fixturesDir, 'episode.mp4');

async function ensureEpisodeFixture() {
  const recipe = recipeOf(ensureEpisodeFixture, h264Encoder('episode'));
  await ensureFileFixture(EPISODE_FIXTURE, recipe, (partial) => runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=darkslateblue:size=320x180:rate=1:duration=200',
    '-c:v', h264Encoder('episode'), '-pix_fmt', 'yuv420p', '-g', '1', '-movflags', '+faststart', partial,
  ], 'episode'));
}

// 96 frames at exactly 24 fps, every picture different, for the frame step (keybinds.e2e.mjs).
const FRAMES_24_FIXTURE = path.join(fixturesDir, 'frames-24fps.mp4');

async function ensureFrames24Fixture() {
  const recipe = recipeOf(ensureFrames24Fixture, h264Encoder('24 fps'));
  await ensureFileFixture(FRAMES_24_FIXTURE, recipe, (partial) => runFfmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=4',
    '-c:v', h264Encoder('24 fps'), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', partial,
  ], '24 fps'));
}

// One local DASH stream per way a manifest lists its segments (dash.js's getters, patched with
// getAllSegments()).
// A fixed @duration defines segment times by arithmetic: a keyframe every 2 s, 9 s long, 5 segments
// per track.
// Each directory gets expected.json, read from ffmpeg's files, for playback.e2e.mjs.
const DASH_FIXTURES = {
  'dash-template': ['-use_template', '1', '-use_timeline', '0'],
  'dash-list': ['-use_template', '0', '-use_timeline', '0'],
  'dash-timeline': ['-use_template', '1', '-use_timeline', '1'],
  // ffmpeg writes this one as a SegmentList of byte ranges; ensureDashFixtures rewrites it
  // to the SegmentBase + sidx form, since ffmpeg cannot.
  'dash-base': ['-single_file', '1', '-global_sidx', '1', '-use_template', '0', '-use_timeline', '0'],
};

/**
 * Lists the top-level boxes of an MP4 file.
 * @param {Buffer} buf - The file.
 * @return {Array<{type: string, start: number, size: number}>}
 */
function topLevelBoxes(buf) {
  const boxes = [];
  for (let pos = 0; pos + 8 <= buf.length;) {
    let size = buf.readUInt32BE(pos);
    if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
    if (size < 8) throw new Error(`bad box size ${size} at ${pos}`);
    boxes.push({type: buf.toString('latin1', pos + 4, pos + 8), start: pos, size});
    pos += size;
  }
  return boxes;
}

/**
 * Reads the media byte ranges a single-file representation's sidx lists.
 * @param {string} file - The representation's file.
 * @return {{init: string, index: string, ranges: string[]}} Its SegmentBase ranges.
 */
function sidxRanges(file) {
  const buf = fs.readFileSync(file);
  const boxes = topLevelBoxes(buf);
  const sidx = boxes.find((box) => box.type === 'sidx');
  if (!sidx || boxes[boxes.indexOf(sidx) - 1]?.type !== 'moov') {
    throw new Error(`${file}: expected a sidx right after the moov`);
  }
  let p = sidx.start + 8;
  const version = buf[p];
  p += 4 + 4 + 4;
  let firstOffset;
  if (version === 0) {
    p += 4;
    firstOffset = buf.readUInt32BE(p);
    p += 4;
  } else {
    p += 8;
    firstOffset = Number(buf.readBigUInt64BE(p));
    p += 8;
  }
  p += 2;
  const count = buf.readUInt16BE(p);
  p += 2;
  const ranges = [];
  let offset = sidx.start + sidx.size + firstOffset;
  for (let i = 0; i < count; i++, p += 12) {
    const size = buf.readUInt32BE(p) & 0x7fffffff;
    ranges.push(`${offset}-${offset + size - 1}`);
    offset += size;
  }
  return {init: `0-${sidx.start - 1}`, index: `${sidx.start}-${sidx.start + sidx.size - 1}`, ranges};
}

// Local HLS streams, one per packaging (TS, fMP4 with init, separate audio rendition); 2 s segments
// everywhere.
// Each directory gets expected.json; HLSPlayer names levels "<track>:<index>" (1: the audio
// rendition).
const HLS_FIXTURES = {
  'hls-ts': {segmentType: 'mpegts', ext: 'ts'},
  'hls-fmp4': {segmentType: 'fmp4', ext: 'm4s'},
  'hls-audio': {segmentType: 'fmp4', ext: 'm4s', separateAudio: true},
};

function ensureHlsFixtures() {
  for (const [name, {segmentType, ext, separateAudio}] of Object.entries(HLS_FIXTURES)) {
    const dir = path.join(fixturesDir, name);
    const expectedFile = path.join(dir, 'expected.json');
    const recipe = recipeOf(ensureHlsFixtures, name, HLS_FIXTURES[name], h264Encoder(name));
    if (!startDirectoryFixture(dir, recipe)) continue;

    const packaging = ['-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_type', segmentType];
    if (segmentType === 'fmp4') {
      packaging.push('-hls_fmp4_init_filename', 'init.mp4');
    }
    const output = separateAudio ?
      ['-var_stream_map', 'v:0,agroup:aud a:0,agroup:aud,default:yes', '-master_pl_name', 'master.m3u8',
        '-hls_segment_filename', `stream_%v/seg-%03d.${ext}`, 'stream_%v/index.m3u8'] :
      ['-hls_segment_filename', `seg-%03d.${ext}`, 'index.m3u8'];
    runFfmpeg([
      '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-map', '0:v', '-map', '1:a', '-t', '9',
      '-c:v', h264Encoder(name), '-pix_fmt', 'yuv420p', '-bf', '0', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '64k',
      ...packaging, ...output,
    ], name, dir);

    const segments = (playlist) => fs.readFileSync(path.join(dir, playlist), 'utf8')
        .split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    const levels = separateAudio ?
      {'0:0': {media: segments('stream_0/index.m3u8')}, '1:0': {media: segments('stream_1/index.m3u8')}} :
      {'0:0': {media: segments('index.m3u8')}};
    fs.writeFileSync(expectedFile, JSON.stringify({
      playlist: separateAudio ? 'master.m3u8' : 'index.m3u8',
      levels,
    }, null, 2));
    finishDirectoryFixture(dir, recipe);
  }
  ensureHlsTwoAudioTracks();
}

/**
 * hls-audio/tracks.m3u8: the audio rendition listed twice, so the player shows its audio-track
 * button.
 */
function ensureHlsTwoAudioTracks() {
  const dir = path.join(fixturesDir, 'hls-audio');
  const master = fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8');
  const lines = master.split(/\r?\n/);
  const audio = lines.findIndex((line) => line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));
  if (audio < 0) throw new Error('hls-audio/master.m3u8 lists no audio rendition');
  const second = lines[audio].replace(/NAME="[^"]*"/, 'NAME="audio_2"').replace('DEFAULT=YES', 'DEFAULT=NO');
  if (second === lines[audio]) throw new Error('hls-audio/master.m3u8: its audio rendition has no NAME');
  lines.splice(audio + 1, 0, second);
  fs.writeFileSync(path.join(dir, 'tracks.m3u8'), lines.join('\n'));
}

// sample.mp4's own H.264 with B-frames, cut without re-encoding (libopenh264 makes no B-frames).
// For modules.e2e.mjs.
const FMP4_BFRAMES_DIR = path.join(fixturesDir, 'fmp4-bframes');

function ensureBframesFixture() {
  const recipe = recipeOf(ensureBframesFixture);
  if (!startDirectoryFixture(FMP4_BFRAMES_DIR, recipe)) return;
  runFfmpeg([
    '-i', MP4_FIXTURE, '-map', '0:v', '-c:v', 'copy',
    '-f', 'dash', '-seg_duration', '2', '-use_template', '1', '-use_timeline', '1', 'manifest.mpd',
  ], 'B-frame fMP4', FMP4_BFRAMES_DIR);
  finishDirectoryFixture(FMP4_BFRAMES_DIR, recipe);
}

// VP9 and Opus in WebM segments, as YouTube-style DASH: saved through the remuxer. For save-fmp4
// and modules.
const DASH_WEBM_DIR = path.join(fixturesDir, 'dash-webm');

function ensureDashWebmFixture() {
  const recipe = recipeOf(ensureDashWebmFixture);
  if (!startDirectoryFixture(DASH_WEBM_DIR, recipe)) return;
  runFfmpeg([
    '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-map', '0:v', '-map', '1:a', '-t', '9',
    '-vf', 'scale=320:180', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-cpu-used', '8', '-row-mt', '1',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'libopus', '-b:a', '64k',
    '-f', 'dash', '-dash_segment_type', 'webm', '-seg_duration', '2',
    '-use_template', '1', '-use_timeline', '1',
    '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'manifest.mpd',
  ], 'VP9 + Opus DASH', DASH_WEBM_DIR);
  finishDirectoryFixture(DASH_WEBM_DIR, recipe);
}

function ensureDashFixtures() {
  for (const [name, packaging] of Object.entries(DASH_FIXTURES)) {
    const dir = path.join(fixturesDir, name);
    const expectedFile = path.join(dir, 'expected.json');
    const recipe = recipeOf(ensureDashFixtures, name, packaging, h264Encoder(name));
    if (!startDirectoryFixture(dir, recipe)) continue;

    const mpd = path.join(dir, 'manifest.mpd');
    runFfmpeg([
      '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
      '-map', '0:v', '-map', '1:a', '-t', '9',
      // No B-frames and no scene-cut keyframes: every machine builds the same frame structure as
      // CI.
      '-c:v', h264Encoder(name), '-pix_fmt', 'yuv420p', '-bf', '0', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '64k',
      '-f', 'dash', '-seg_duration', '2', ...packaging,
      '-adaptation_sets', 'id=0,streams=v id=1,streams=a', 'manifest.mpd',
    ], name, dir);

    // ffmpeg names the representations 0 (video) and 1 (audio); DashTrackUtils makes the
    // level IDs "<type>-<representation id>" out of them.
    const expected = {};
    for (const [level, id] of [['video-0', 0], ['audio-1', 1]]) {
      if (name === 'dash-base') {
        const {init, index, ranges} = sidxRanges(path.join(dir, `manifest-stream${id}.mp4`));
        expected[level] = {ranges};
        const text = fs.readFileSync(mpd, 'utf8');
        const list = new RegExp(`(<BaseURL>manifest-stream${id}\\.mp4</BaseURL>\\s*)<SegmentList[\\s\\S]*?</SegmentList>`);
        if (!list.test(text)) throw new Error(`${name}: no SegmentList for representation ${id}`);
        fs.writeFileSync(mpd, text.replace(list,
            `$1<SegmentBase indexRange="${index}"><Initialization range="${init}" /></SegmentBase>`));
      } else {
        expected[level] = {
          media: fs.readdirSync(dir).filter((f) => f.startsWith(`chunk-stream${id}-`)).sort(),
        };
      }
    }
    fs.writeFileSync(expectedFile, JSON.stringify(expected, null, 2));
    finishDirectoryFixture(dir, recipe);
  }
}

// The MP4 fixture's picture over a 10 s tone, for analyzer.e2e.mjs and video-delay.e2e.mjs.
const SAMPLE_AV_FIXTURE = path.join(fixturesDir, 'sample-av.mp4');

async function ensureSampleAvFixture() {
  await ensureFileFixture(SAMPLE_AV_FIXTURE, recipeOf(ensureSampleAvFixture), (partial) => runFfmpeg([
    '-i', MP4_FIXTURE, '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest',
    '-movflags', '+faststart', partial,
  ], 'audio'));
}

/**
 * Builds every fixture made from the MP4 one that is missing or was built by another
 * recipe. The MP4 fixture must be there (ensureMp4Fixture).
 * @return {Promise<void>}
 */
export async function ensureFixtures() {
  await ensureWebmFixture();
  await ensureLongAvFixture();
  await ensureFrames24Fixture();
  await ensureEpisodeFixture();
  await ensureSampleAvFixture();
  ensureDashFixtures();
  ensureHlsFixtures();
  ensureBframesFixture();
  ensureDashWebmFixture();
}
