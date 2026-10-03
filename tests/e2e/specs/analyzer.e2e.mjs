// The background audio analyzer, which the silence skipper and the voice-activity features
// start. It plays a second copy of the video at high speed to measure the sound ahead of
// the playhead, and had two calls to browser tests (EnvUtils.isSafari and isChrome) that
// were removed when the project became Firefox only. Nothing ran that code, so the first
// release without them shipped an analyzer that threw "isSafari is not a function" the
// moment it started. tests/unit/EnvUtils.test.mjs now checks every call statically; this
// starts it for real.

import {browser, expect} from '@wdio/globals';

// fixtures/sample-av.mp4, the MP4 fixture with a tone: buildFixtures.mjs.

describe('Background audio analyzer', function() {
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
