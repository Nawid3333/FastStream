// What this project relies on Firefox to do, pinned so that a Firefox that changes shows
// up as a failing test instead of as nothing at all.
//
// - The options page carries no review or feedback prompt (upstream's, for its own listing).
// - Scrollbars. Firefox ignores ::-webkit-scrollbar, so the player and the options page
//   style theirs with the standard scrollbar-width and scrollbar-color.
// - The fastest playback rate with sound. The player caps the rate at 8
//   (FastStreamClient's maxPlaybackRate) because Firefox mutes the audio of anything
//   faster: measured on Firefox 156 the 440 Hz test tone is at full level at 8x and
//   silent at 10x, while the picture keeps its pace (16x really plays 16 seconds a
//   second). If this test starts to fail at 10x, Firefox now plays faster audio and the
//   cap, and the 16x speed key, can move up.

import {browser, expect} from '@wdio/globals';

// Loud enough to be sure of, quiet enough to leave room: the tone measures about 0.087.
const AUDIBLE = 0.03;
const SILENT = 0.001;

describe('Firefox scrollbars', function() {
  const thin = () => browser.execute(() => {
    const style = getComputedStyle(document.documentElement);
    return {width: style.scrollbarWidth, color: style.scrollbarColor};
  });

  it('are thin and themed on the options page', async function() {
    await browser.url('/player/options/index.html?t=' + Date.now());
    const style = await thin();
    expect(style.width).toBe('thin');
    expect(style.color).toContain('128, 128, 128');
  });

  it('are thin and themed in the player', async function() {
    await browser.url('/player/index.html?t=' + Date.now());
    const style = await thin();
    expect(style.width).toBe('thin');
    expect(style.color).toContain('186, 186, 192');
  });
});

describe('Options page', function() {
  it('does not ask for a review of a store listing this fork does not have', async function() {
    await browser.url('/player/options/index.html?t=' + Date.now());
    const found = await browser.execute(() => ({
      rateBox: !!document.getElementById('ratebox'),
      feedbackBox: !!document.getElementById('feedbackbox'),
      reviewText: document.body.innerHTML.includes('addons.mozilla.org'),
    }));
    expect(found).toEqual({rateBox: false, feedbackBox: false, reviewText: false});
  });
});

describe('Firefox audio at speed', function() {
  // Plays the fixture at one rate for two seconds and reports the level the audio reaches,
  // through an analyser that is not connected to the speakers, and how far the media moved.
  const measure = (rate) => browser.executeAsync((source, rate, done) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.src = source;
    document.body.appendChild(video);
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaElementSource(video).connect(analyser);
    video.load();

    const giveUp = setTimeout(() => done({failed: 'the video never loaded', state: context.state}), 30000);
    video.addEventListener('canplay', async () => {
      await context.resume().catch(() => {});
      video.playbackRate = rate;
      await video.play().catch((e) => done({failed: String(e)}));
      const buffer = new Float32Array(analyser.fftSize);
      const levels = [];
      const from = video.currentTime;
      const sampler = setInterval(() => {
        analyser.getFloatTimeDomainData(buffer);
        levels.push(Math.sqrt(buffer.reduce((sum, x) => sum + x * x, 0) / buffer.length));
      }, 100);
      setTimeout(() => {
        clearInterval(sampler);
        clearTimeout(giveUp);
        const moved = video.currentTime - from;
        video.pause();
        video.remove();
        context.close();
        levels.sort((a, b) => a - b);
        done({level: levels[Math.floor(levels.length / 2)], moved});
      }, 2000);
    }, {once: true});
  }, globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/long-av.mp4', rate);

  it('is heard up to 8x, which is where the player stops, and not beyond', async function() {
    await browser.setTimeout({script: 60000});
    await browser.url('/player/index.html?t=' + Date.now());

    const baseline = await measure(1);
    // A machine that cannot decode the clip, or has no audio output and leaves every level
    // at zero, says nothing about Firefox. Only a baseline that is heard makes the
    // comparison below mean anything.
    if (baseline.failed || !(baseline.level >= AUDIBLE)) {
      console.log('      cannot hear the tone at 1x on this machine, skipping:', JSON.stringify(baseline));
      // eslint-disable-next-line no-invalid-this
      this.skip();
    }

    const fast = await measure(8);
    expect(fast.level).toBeGreaterThan(AUDIBLE);
    // The picture, on the other hand, runs at the requested pace.
    expect(fast.moved).toBeGreaterThan(14);

    const faster = await measure(10);
    expect(faster.level).toBeLessThan(SILENT);
    expect(faster.moved).toBeGreaterThan(17);

    const fastest = await measure(16);
    expect(fastest.level).toBeLessThan(SILENT);
    expect(fastest.moved).toBeGreaterThan(28);
  });

  it('is what the player is set to stop at', async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(
        async () => browser.execute(() => !!window.fastStream?.options),
        {timeout: 60000, timeoutMsg: 'the player never started'});
    expect(await browser.execute(() => window.fastStream.options.maxPlaybackRate)).toBe(8);
  });
});
