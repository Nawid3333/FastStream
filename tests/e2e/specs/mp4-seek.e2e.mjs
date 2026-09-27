// Seeking an accelerated MP4 far back must load the new position.
//
// MP4Player keeps a window of the file in the MediaSource. A seek outside it calls
// resetHLS(): everything appended is removed, mp4box is told to extract from the new
// position again, and runLoad() fetches the fragments there. Jumping from the end of a
// video back to its start sometimes left the player at 0 with nothing loading at all -
// buffered held only the old tail, nothing was queued, the element was not seeking - so
// the video could not play again without another seek.

import {browser, expect} from '@wdio/globals';

const videoPath = (fixture) => '/player/index.html?t=' + Date.now() + '#' +
  globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/' + fixture;

/**
 * Reads the player's buffering state, and enough of MP4Player's own to tell where a stall
 * comes from.
 * @return {Promise<Object>} The state.
 */
const state = () => browser.execute(() => {
  const player = window.fastStream.player;
  const video = player.getVideo();
  const ranges = [];
  for (let i = 0; i < video.buffered.length; i++) {
    ranges.push([video.buffered.start(i), video.buffered.end(i)]);
  }
  const queue = (wrapper) => wrapper ?
    {updating: wrapper.updating || wrapper.sourceBuffer.updating, queued: wrapper.toDo.length} : null;
  const mp4box = player.mp4box;
  return {
    time: video.currentTime,
    readyState: video.readyState,
    seeking: video.seeking,
    ranges,
    video: queue(player.videoSourceBuffer),
    audio: queue(player.audioSourceBuffer),
    running: player.running,
    loader: !!player.loader,
    currentFragment: player.currentFragment?.sn,
    currentFragments: player.currentFragments.map((frag) => frag.sn),
    fragmentStatus: (window.fastStream.fragments || []).slice(0, 4).map((frag) => frag && frag.status),
    nextSample: mp4box.fragmentedTracks.map((track) => track.trak.nextSample),
    samples: mp4box.fragmentedTracks.map((track) => track.trak.samples.length),
    mediaSource: player.mediaSource.readyState,
    mediaSourceDuration: player.mediaSource.duration,
    streamBuffers: mp4box.stream.buffers.map((b) => [b.fileStart, b.byteLength, b.usedBytes]),
    bufferIndex: mp4box.stream.bufferIndex,
  };
});

describe('MP4 seeks far back', function() {
  it('loads the start again after jumping back to it from the end, every time', async function() {
    await browser.url(videoPath('long-av.mp4'));
    await browser.waitUntil(async () => browser.execute(() => {
      const video = document.querySelector('video');
      return !!(window.fastStream?.player && video && video.readyState >= 2);
    }), {timeout: 60000, timeoutMsg: 'video never became ready'});

    const duration = await browser.execute(() => window.fastStream.duration);
    for (let round = 1; round <= 8; round++) {
      const end = round % 2 ? duration - 2 : duration;
      for (const [target, what] of [[end, `${end} s`], [0, 'the start']]) {
        await browser.execute((target) => {
          window.fastStream.currentTime = target;
        }, target);
        let last;
        try {
          await browser.waitUntil(async () => {
            last = await state();
            // At the very end there is nothing left to play, so HAVE_CURRENT_DATA is enough.
            return !last.seeking && last.readyState >= (target >= duration ? 2 : 3) &&
              last.ranges.some(([start, end]) => start <= Math.min(target + 0.1, duration) &&
                end >= Math.min(target + 1, duration));
          }, {timeout: 20000, interval: 250});
        } catch (e) {
          throw new Error(`round ${round}: ${what} never loaded: ${JSON.stringify(last)}`);
        }
      }
    }
    expect(true).toBe(true);
  });
});

describe('MP4 end of stream', function() {
  beforeEach(async function() {
    await browser.url(videoPath('long-av.mp4'));
    await browser.waitUntil(async () => browser.execute(() => {
      const video = document.querySelector('video');
      return !!(window.fastStream?.player && video && video.readyState >= 2);
    }), {timeout: 60000, timeoutMsg: 'video never became ready'});
  });

  it('completes a seek to exactly the end', async function() {
    const duration = await browser.execute(() => window.fastStream.duration);
    await browser.execute((duration) => {
      window.fastStream.currentTime = duration;
    }, duration);
    let last;
    try {
      await browser.waitUntil(async () => {
        last = await state();
        return !last.seeking;
      }, {timeout: 20000, interval: 250});
    } catch (e) {
      throw new Error('the seek to the end never completed: ' + JSON.stringify(last));
    }
  });

  it('ends when playback reaches the end', async function() {
    const duration = await browser.execute(() => window.fastStream.duration);
    await browser.execute((duration) => {
      window.__ended = false;
      window.fastStream.player.getVideo().addEventListener('ended', () => {
        window.__ended = true;
      });
      window.fastStream.currentTime = duration - 1.5;
    }, duration);
    await browser.waitUntil(async () => (await state()).readyState >= 3,
        {timeout: 20000, timeoutMsg: 'the last seconds never loaded'});
    await browser.execute(() => {
      window.fastStream.play().catch((e) => {
        window.__playError = String(e);
      });
    });
    let last;
    try {
      await browser.waitUntil(async () => {
        last = {
          ...(await state()),
          ended: await browser.execute(() => window.__ended),
          paused: await browser.execute(() => window.fastStream.player.getVideo().paused),
          playError: await browser.execute(() => window.__playError || null),
        };
        return last.ended;
      }, {timeout: 20000, interval: 250});
    } catch (e) {
      throw new Error('playback never ended: ' + JSON.stringify(last));
    }

    // Ended means the MediaSource was told so. SourceBuffer.abort() throws in that state,
    // and destroy() called it unconditionally: the player was left half destroyed, and the
    // background analyzer, which destroys its player when it is done, threw on every frame.
    const destroyed = await browser.execute(() => {
      const player = window.fastStream.player;
      const mediaSource = player.mediaSource.readyState;
      let emitted = false;
      player.on('destroyed', () => {
        emitted = true;
      });
      try {
        player.destroy();
      } catch (e) {
        return {mediaSource, error: String(e)};
      }
      return {mediaSource, emitted};
    });
    expect(destroyed).toEqual({mediaSource: 'ended', emitted: true});
  });
});

describe('MP4 back buffer', function() {
  it('trims the back buffer about once a second while playing, not on every loop', async function() {
    await browser.url(videoPath('long-av.mp4'));
    await browser.waitUntil(async () => browser.execute(() => {
      const video = document.querySelector('video');
      return !!(window.fastStream?.player && video && video.readyState >= 2);
    }), {timeout: 60000, timeoutMsg: 'video never became ready'});
    // 20 s is inside what the player loads from the start, so the seek keeps the 20 s
    // behind it, twice the back buffer: there is something to trim.
    await browser.waitUntil(async () => (await state()).ranges.some(([start, end]) => start <= 0.1 && end >= 25),
        {timeout: 20000, timeoutMsg: 'the first 25 s never loaded'});
    await browser.execute(() => {
      window.fastStream.currentTime = 20;
    });
    await browser.waitUntil(async () => (await state()).readyState >= 3,
        {timeout: 20000, timeoutMsg: '20 s never loaded'});

    const counts = await browser.execute(() => {
      window.__removes = 0;
      window.__appends = 0;
      const remove = SourceBuffer.prototype.remove;
      SourceBuffer.prototype.remove = function(...args) {
        window.__removes++;
        return remove.apply(this, args);
      };
      const append = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function(...args) {
        window.__appends++;
        return append.apply(this, args);
      };
      window.fastStream.play().catch(() => {});
      return new Promise((resolve) => setTimeout(() => {
        const video = window.fastStream.player.getVideo();
        resolve({removes: window.__removes, appends: window.__appends, played: video.currentTime - 20,
          behind: video.currentTime - video.buffered.start(0)});
      }, 5000));
    });
    console.log('      5 s of playback:', JSON.stringify(counts));

    expect(counts.played).toBeGreaterThan(3);
    // Two SourceBuffers, trimmed about once a second each; it was about 2,400.
    expect(counts.removes).toBeLessThan(30);
    // Still trimmed, and still bounded. What stays behind the playhead is 10 s back to the
    // keyframe after that point: MSE removes a video frame with everything that depends on
    // it, so [0, 14) takes the frames up to the next keyframe too - the same as before.
    expect(counts.removes).toBeGreaterThan(0);
    expect(counts.behind).toBeLessThan(12);
  });
});
