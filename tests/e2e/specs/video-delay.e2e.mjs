// Regression coverage for the video delay option.
//
// A positive delay has SyncedAudioPlayer build two extra, audio-only players so the
// audio can run ahead of the picture. Building them called
// client.attachProcessorsToPlayer(), which the YouTube removal deleted from
// FastStreamClient without deleting its callers. The call threw "is not a
// function" inside setVideoDelay() - which setOptions() does not await - so the
// failure surfaced only as an unhandled rejection, no audio player was built, and
// madePlayers was already set so it was never retried. The option silently did
// nothing, and nothing else in the suite sets a delay, so nothing noticed.
//
// The source has to carry audio. sample.mp4 does not, and an audio-only player
// fed a source with no audio track fails in SourceBufferWrapper on every frame,
// which would bury what this checks. That is a separate matter, so the video
// gets a generated tone, the way save-hls-fmp4.e2e.mjs does.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const AV_FIXTURE = path.join(fixturesDir, 'sample-av.mp4');

describe('Video delay', function() {
  before(function() {
    if (fs.existsSync(AV_FIXTURE)) return;
    const args = [
      '-y', '-v', 'error', '-i', path.join(fixturesDir, 'sample.mp4'),
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', AV_FIXTURE,
    ];
    const {status, error, stderr} = spawnSync('ffmpeg', args, {encoding: 'utf8'});
    if (status !== 0) {
      throw new Error(
          `could not build the audio fixture with ffmpeg` +
          `${error ? ` (${error.message})` : ''}. CI installs ffmpeg; ` +
          `locally it must be on PATH.\n${stderr || ''}`,
      );
    }
  });

  it('builds the separate audio players a positive delay needs, without an error', async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample-av.mp4');
    await browser.waitUntil(
        async () => browser.execute(() => {
          const video = document.querySelector('video');
          return !!(video && video.readyState >= 2);
        }),
        {timeout: 60000, timeoutMsg: 'video never became ready'});

    const result = await browser.executeAsync((done) => {
      const out = {uncaught: [], audioPlayers: null};
      window.addEventListener('unhandledrejection', (e) => {
        out.uncaught.push(String((e.reason && e.reason.message) || e.reason));
      });
      window.addEventListener('error', (e) => {
        out.uncaught.push(e.message);
      });

      const client = window.fastStream;
      client.setOptions({...client.options, videoDelay: 500});

      // setVideoDelay is not awaited by setOptions, so give it time to finish.
      setTimeout(() => {
        out.audioPlayers = client.syncedAudioPlayer ? client.syncedAudioPlayer.audioPlayers.length : null;
        done(out);
      }, 4000);
    });

    console.log('      result:', JSON.stringify(result));
    expect(result.uncaught).toEqual([]);
    expect(result.audioPlayers).toBe(2);
  });
});
