// The background audio analyzer, which the silence skipper and the voice-activity features
// start. It plays a second copy of the video at high speed to measure the sound ahead of
// the playhead, and had two calls to browser tests (EnvUtils.isSafari and isChrome) that
// were removed when the project became Firefox only. Nothing ran that code, so the first
// release without them shipped an analyzer that threw "isSafari is not a function" the
// moment it started. tests/unit/EnvUtils.test.mjs now checks every call statically; this
// starts it for real.

import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {browser, expect} from '@wdio/globals';

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const AV_FIXTURE = path.join(fixturesDir, 'sample-av.mp4');

describe('Background audio analyzer', function() {
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
          `could not build the audio fixture with ffmpeg${error ? ` (${error.message})` : ''}. ` +
          `CI installs ffmpeg; locally it must be on PATH.\n${stderr || ''}`,
      );
    }
  });

  it('starts, and plays its copy at the fastest rate Firefox still gives sound at', async function() {
    await browser.setTimeout({script: 60000});
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample-av.mp4');
    await browser.waitUntil(
        async () => browser.execute(() => {
          const video = document.querySelector('video');
          return !!(window.fastStream && video && video.readyState >= 2);
        }),
        {timeout: 60000, timeoutMsg: 'the player never became ready'});

    const outcome = await browser.executeAsync((done) => {
      const errors = [];
      window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.message || e.reason)));
      window.addEventListener('error', (e) => errors.push(e.message));

      const analyzer = window.fastStream.audioAnalyzer;
      analyzer.startBackgroundAnalyzer().then(() => {
        // The analyzer's player runs on its own; give it a moment to be set going.
        setTimeout(() => {
          done({
            errors,
            status: analyzer.backgroundAnalyzerStatus,
            rate: analyzer.backgroundAnalyzerPlayer ? analyzer.backgroundAnalyzerPlayer.playbackRate : null,
          });
          analyzer.stopBackgroundAnalyzer();
        }, 500);
      }, (e) => done({failed: String((e && e.message) || e), errors}));
    });

    expect(outcome.failed).toBeUndefined();
    expect(outcome.errors).toEqual([]);
    expect(outcome.status).toBe('running');
    expect(outcome.rate).toBe(8);
  });
});
