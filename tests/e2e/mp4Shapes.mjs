// MP4 files of particular shapes for the MP4 specs, written with ffmpeg under
// fixtures/mp4-shapes/ the first time a spec asks for one and kept between runs. Each spec
// asks for every file it plays: a file another spec wrote earlier in the same run is not
// there on a fresh checkout or on a CI shard that runs the spec alone.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const fixturesDir = path.resolve(import.meta.dirname, 'fixtures');
export const shapesDir = path.join(fixturesDir, 'mp4-shapes');

// Ten minutes of a 440 Hz tone, AAC: an audio-only file of about 9.6 MB.
export const SINE_10_MIN = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=600', '-c:a', 'aac', '-b:a', '128k'];

/**
 * Writes one file with ffmpeg under fixtures/mp4-shapes/, unless it is already there.
 * @param {string} name - The file's name.
 * @param {string[]} args - ffmpeg's arguments before the output file.
 * @return {string} The file's path.
 */
export function ensureMp4Shape(name, args) {
  const file = path.join(shapesDir, name);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(shapesDir, {recursive: true});
  // Written under another name first, so a run killed half way leaves no file to reuse.
  const partial = file + '.part.mp4';
  const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args, partial], {encoding: 'utf8'});
  if (status !== 0) {
    throw new Error(`could not write ${name} with ffmpeg${error ? ` (${error.message})` : ''}. ` +
      `CI installs ffmpeg; locally it must be on PATH.\n${stderr || ''}`);
  }
  fs.renameSync(partial, file);
  return file;
}

/**
 * Ten minutes of audio alone, its moov first.
 * @return {string} The file's path.
 */
export function ensureLongAudioOnly() {
  return ensureMp4Shape('long-audio-only.mp4', [...SINE_10_MIN, '-movflags', '+faststart']);
}
