// The MP4 fixture every e2e suite serves, and the other fixtures are made from.
//
// Served locally: public test files send no CORS, which the accelerated MP4 mode needs; downloaded
// once, gitignored.
//
// Both the web and the extension configs make sure it is there: `pnpm run test:ext` alone never
// runs the web config.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MP4_FIXTURE_URL =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
export const fixturesDir = path.join(import.meta.dirname, 'fixtures');
export const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');

// The pinned file: H.264 High, 640x360, 300 frames at 30 fps, 250 B-frames, no audio. Another file
// is refused by name.
export const MP4_FIXTURE_PIN = {
  size: 991017,
  sha256: '77145c94c11f3754207499158df22406e1fe7635553c1c86dc5e881dfeb32016',
};

/**
 * Checks that bytes are the pinned MP4 fixture.
 * @param {Buffer} data - The bytes.
 * @param {{size: number, sha256: string}} [pin] - What they must be.
 * @return {?string} Why they are not, or null when they are.
 */
export function mp4FixtureMismatch(data, pin = MP4_FIXTURE_PIN) {
  if (data.length !== pin.size) {
    return `${data.length} bytes, expected ${pin.size}`;
  }
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  return sha256 === pin.sha256 ? null : `SHA-256 ${sha256}, expected ${pin.sha256}`;
}

/**
 * Moves a finished file into place: written under another name and renamed, so no half-written
 * fixture is trusted.
 * @param {string} file - The fixture's path.
 * @param {function(string): (void|Promise<void>)} write - Writes the fixture to the path
 *   it is given.
 * @return {Promise<void>}
 */
export async function writeFixture(file, write) {
  const partial = file.replace(/(\.[^./\\]+)?$/, '.partial$1');
  try {
    await write(partial);
    fs.renameSync(partial, file);
  } catch (e) {
    fs.rmSync(partial, {force: true});
    throw e;
  }
}

/**
 * Downloads the MP4 fixture unless the pinned one is there; another file is fetched again and its
 * derived fixtures removed.
 * @return {Promise<{action: string, reason?: string}>} 'kept' (the pinned file was there),
 *   'fetched' (none was), or 'replaced' (another file was, and reason says how it differed).
 */
export async function ensureMp4Fixture() {
  // Read without a preceding existsSync: no gap between the two calls (CodeQL
  // js/file-system-race).
  let stale = null;
  try {
    stale = mp4FixtureMismatch(fs.readFileSync(MP4_FIXTURE));
    if (stale === null) return {action: 'kept'};
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  fs.mkdirSync(fixturesDir, {recursive: true});
  // The fixture host is a pinned constant, not an interpolated URL; the
  // destination is this suite's own fixtures dir (CodeQL js/http-to-file-access).
  const res = await fetch(MP4_FIXTURE_URL);
  if (!res.ok) {
    throw new Error(
        `could not fetch the MP4 fixture (${res.status}). It is needed once; ` +
        `after that the suite runs offline.`,
    );
  }
  // only an MP4 (an ftyp box) becomes the fixture: checked before it is written (CodeQL
  // js/http-to-file-access)
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length < 12 || data.toString('latin1', 4, 8) !== 'ftyp') {
    throw new Error('the fetched MP4 fixture is not an MP4 (no ftyp box)');
  }
  const mismatch = mp4FixtureMismatch(data);
  if (mismatch) {
    throw new Error(
        `the MP4 fixture changed upstream (${MP4_FIXTURE_URL}): ${mismatch}. The e2e suites ` +
        'count its frames; check the new file (ffprobe) against them before moving ' +
        'MP4_FIXTURE_PIN in tests/e2e/mp4Fixture.mjs.',
    );
  }
  if (stale) {
    // Made from the other file.
    for (const name of fs.readdirSync(fixturesDir)) {
      if (name !== path.basename(MP4_FIXTURE)) {
        fs.rmSync(path.join(fixturesDir, name), {recursive: true, force: true});
      }
    }
  }
  await writeFixture(MP4_FIXTURE, (partial) => fs.writeFileSync(partial, data));
  return stale ? {action: 'replaced', reason: stale} : {action: 'fetched'};
}
