// The MP4 fixture every e2e suite serves, and the other fixtures are made from.
//
// Served locally rather than fetched from a public host: the obvious public test files send
// no CORS headers, and FastStream's accelerated MP4 mode fetches the file itself to do its
// own range-based buffering - which an extension may do via host permissions but a web
// page may not. Serving it same-origin removes both the CORS problem and a network
// dependency in CI. It is downloaded once and gitignored rather than committed, to keep a
// binary out of the repository.
//
// A module of its own because both the web suite's config and the extension suite's make
// sure it is there: `pnpm run test:ext` alone never runs the web config, and on a fresh
// clone the extension specs' /fixtures/sample.mp4 was a 404.

import fs from 'node:fs';
import path from 'node:path';

const MP4_FIXTURE_URL =
  'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4';
export const fixturesDir = path.join(import.meta.dirname, 'fixtures');
export const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');

/**
 * Moves a finished file into place. A fixture is trusted once its file exists, so it is
 * written under another name and renamed: a run killed half way leaves no half-written
 * fixture for the next run to trust, only a leftover the next run writes over.
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
 * Downloads the MP4 fixture if it is not already there.
 * @return {Promise<void>}
 */
export async function ensureMp4Fixture() {
  // Read (size included) without a preceding existsSync: no gap between the two
  // calls (CodeQL js/file-system-race).
  try {
    if (fs.statSync(MP4_FIXTURE).size > 0) return;
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
  const data = Buffer.from(await res.arrayBuffer());
  await writeFixture(MP4_FIXTURE, (partial) => fs.writeFileSync(partial, data));
}
