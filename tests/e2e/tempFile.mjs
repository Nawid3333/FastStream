/**
 * Shared temp-file helpers for specs that hand a byte buffer to ffmpeg/ffprobe.
 *
 * The file goes into a fresh mkdtemp directory on every call: a predictable name in
 * the shared %TEMP% root (pid and timestamp only) is one another local process could
 * create first or replace. A directory made by mkdtempSync carries a random suffix and
 * mode 0700 on POSIX, and on Windows lands under the user's own %TEMP% anyway -- the
 * race window CodeQL's js/insecure-temporary-file names is gone.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Writes bytes to a fresh, unpredictable temp directory and returns the file's path.
 * The temp files e2e specs hand to ffmpeg are per-run; the directory is removed with
 * the file afterwards by withTempFile.
 * @param {string} name - File name inside the fresh directory (e.g. 'probe.mp4').
 * @param {Buffer} bytes - What to write.
 * @return {{dir: string, file: string}}
 */
export function tempFileInFreshDir(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faststream-spec-'));
  const file = path.join(dir, path.basename(name));
  fs.writeFileSync(file, bytes);
  return {dir, file};
}

/**
 * Runs fn with a fresh temp file, then removes the directory it lives in, best effort.
 * @param {string} name - The file's name inside the fresh directory.
 * @param {Buffer} bytes - What to write.
 * @param {(file: string) => T} fn - What to do with the file's path.
 * @return {T} What fn returned.
 * @template T
 */
export function withTempFile(name, bytes, fn) {
  const {dir, file} = tempFileInFreshDir(name, bytes);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
