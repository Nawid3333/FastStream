// A fragmented MP4 whose download range ends between two fragments plays to its end.
//
// MP4Player ends the MediaSource stream (endOfStream) once every sample mp4box knows of has
// been appended, so that playback reaching the end fires 'ended'. But a fragmented file's
// samples become known one moof at a time: when a 1 MB range ended after one fragment's
// data and before the next moof was complete, "every sample appended" held in the middle
// of the file. The stream was ended there, the MediaSource cut the duration to what was
// buffered, and the video stopped early. Whether a range ends there is chance - about one
// range in two hundred for 2 s fragments - so this builds the case: the fixture's second
// fragment is moved, with a `free` box in front of it, to start 8 bytes before the end of
// MP4Player's first range. The server holds that second range back for a while, the moment
// in which the stream was wrongly ended.
//
// Knowing where the file ends needs its length, and MP4Player took that from the samples
// mp4box knew once the first range was parsed, not from the server's Content-Range. For a
// fragmented file those end with the first range: the file looked complete, the stream
// was ended there, and the second range was never asked for.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const MP4_FIXTURE = path.join(fixturesDir, 'sample.mp4');
// MP4Player.mjs's FRAGMENT_SIZE: the first range is bytes [0, RANGE).
const RANGE = 1000000;
const HOLD_MS = 6000;

const PORT = 41887;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let server;

/**
 * The MP4 fixture as a fragmented file (a moof per keyframe, sample offsets relative to
 * each moof, no trailer), with a `free` box in front of its last fragment that makes that
 * fragment's moof start 8 bytes before RANGE.
 * @return {Buffer}
 */
function gapFixture() {
  const dir = path.join(fixturesDir, 'mp4-shapes');
  const fragmented = path.join(dir, 'fragmented-moof-relative.mp4');
  if (!fs.existsSync(fragmented)) {
    fs.mkdirSync(dir, {recursive: true});
    const partial = fragmented + '.part.mp4';
    const {status, error, stderr} = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', MP4_FIXTURE, '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof+skip_trailer', partial], {encoding: 'utf8'});
    if (status !== 0) {
      throw new Error(`could not write the fragmented file with ffmpeg${error ? ` (${error.message})` : ''}. ` +
        `CI installs ffmpeg; locally it must be on PATH.\n${stderr || ''}`);
    }
    fs.renameSync(partial, fragmented);
  }

  const bytes = fs.readFileSync(fragmented);
  const moofs = [];
  for (let pos = 0; pos + 8 <= bytes.length;) {
    const size = bytes.readUInt32BE(pos);
    if (bytes.toString('latin1', pos + 4, pos + 8) === 'moof') moofs.push(pos);
    if (size < 8) break;
    pos += size;
  }
  const moof = moofs.filter((offset) => offset > 0 && offset <= RANGE - 16).pop();
  if (moofs.length < 2 || moof === moofs[0]) {
    throw new Error(`the fragmented fixture needs two fragments, has moofs at ${moofs.join(', ')}`);
  }
  const padding = RANGE - 8 - moof;
  const free = Buffer.alloc(padding);
  free.writeUInt32BE(padding, 0);
  free.write('free', 4, 'latin1');
  return Buffer.concat([bytes.subarray(0, moof), free, bytes.subarray(moof)]);
}

/**
 * The player's MediaSource and what its video reports, with a nudge to play.
 * @return {Promise<Object>}
 */
async function playerState() {
  return browser.execute(() => {
    const client = window.fastStream;
    const video = client?.currentVideo;
    if (!video) return {};
    if (video.paused) video.play().catch(() => {});
    const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    return {
      currentTime: video.currentTime, duration: video.duration, buffered,
      mediaSource: client.player?.mediaSource?.readyState || null,
      failed: !!client.interfaceController?.failed,
    };
  });
}

describe('A fragmented MP4 whose first range ends between two fragments', function() {
  let secondRangeAnswered = 0;

  before(async function() {
    const bytes = gapFixture();
    server = http.createServer((req, res) => {
      const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
      };
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      const answer = () => {
        res.writeHead(206, {...cors, 'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1});
        res.end(bytes.subarray(start, end + 1));
      };
      if (start >= RANGE) {
        setTimeout(() => {
          secondRangeAnswered = Date.now();
          answer();
        }, HOLD_MS);
      } else {
        answer();
      }
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('keeps the stream open until the last range is in, and plays to the end', async function() {
    await browser.url(`/player/index.html?t=${Date.now()}#${ORIGIN}/fragmented-gap.mp4`);

    // The first range is in: everything before the second fragment is buffered.
    let state = {};
    await browser.waitUntil(async () => {
      state = await playerState();
      return state.buffered > 7;
    }, {timeout: 30000, interval: 200, timeoutMsg: 'the first range never played'});

    // While the second range is held back, the stream is not over. (The duration is what
    // has been parsed so far: an empty_moov file, as ffmpeg writes it, has no mehd box to
    // give it up front. It grows as the rest comes in - unless the stream was ended.)
    const seen = [];
    const until = Date.now() + 2500;
    while (Date.now() < until && !secondRangeAnswered) {
      state = await playerState();
      seen.push(`${state.mediaSource} ${Number(state.duration).toFixed(2)}`);
      expect(state.mediaSource).toBe('open');
      await browser.pause(250);
    }
    console.log('      while the second range was held:', [...new Set(seen)].join(', '));
    expect(seen.length).toBeGreaterThan(3);

    // And the video plays on through the second fragment to its end.
    await browser.waitUntil(async () => {
      state = await playerState();
      return state.currentTime > 9.2 || state.failed;
    }, {timeout: 45000, interval: 500}).catch(() => {});
    console.log('      at the end:', JSON.stringify(state));
    expect(state.failed).toBe(false);
    expect(state.currentTime).toBeGreaterThan(9.2);
    expect(state.duration).toBeCloseTo(10, 0);
  });
});
