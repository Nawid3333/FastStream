// The seek preview of an MP4 shows each place the pointer rests on: forward, back, a place
// before the last one in the same part of the file, and after quick moves, while the video is
// paused and while it plays.
//
// Its player is a second MP4Player, always paused. Its loop runs at the paused pace (250 ms)
// and a seek wakes it (wakeLoop, 2026-11-13); a seek it did not make itself is checked as well
// (onElementSeeking). The A/B benchmark (tools/bench-ab.mjs) once timed out waiting for the
// preview at 120 s on that build, in one run of 21: this spec hovers many places in turn and
// fails, with the preview's state, on any that does not show.

import path from 'node:path';
import {browser, expect} from '@wdio/globals';

import {ensureMp4Shape, fixturesDir} from '../mp4Shapes.mjs';

// 160 s, 17 MB: 18 of MP4Player's 1 MB ranges. wdio.conf.mjs writes it.
const LONG_FIXTURE = path.join(fixturesDir, 'long-av.mp4');

// Ten seconds per place: a local file shows one in well under a second (about 30 ms measured).
const SHOWN_WITHIN_MS = 10000;
// long-av.mp4 is 160 s.
const PLACES = [120, 30, 90, 10, 150, 60, 140, 5, 100, 45, 125, 70];

/**
 * The preview's video state.
 * @return {Promise<{time: number, seeking: boolean, readyState: number, buffered: number[][]}>}
 */
function previewState() {
  return browser.execute(() => {
    const video = /** @type {any} */ (window).fastStream.previewPlayer.getVideo();
    const buffered = [];
    for (let i = 0; i < video.buffered.length; i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]);
    return {time: video.currentTime, seeking: video.seeking, readyState: video.readyState, buffered};
  });
}

/**
 * Points the preview at a place and waits until it shows it.
 * @param {number} time
 * @param {number[]} [movesBefore] - Places the pointer passes on the way, 20 ms apart.
 * @return {Promise<number>} How long it took, in ms.
 */
async function showPreviewAt(time, movesBefore = []) {
  const start = Date.now();
  await browser.execute(async (moves, target) => {
    const client = /** @type {any} */ (window).fastStream;
    for (const move of moves) {
      client.seekPreview(move);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    client.seekPreview(target);
  }, movesBefore, time);
  let state;
  await browser.waitUntil(async () => {
    state = await previewState();
    return !state.seeking && state.readyState >= 2 && Math.abs(state.time - time) < 0.5;
  }, {timeout: SHOWN_WITHIN_MS, interval: 25}).catch(() => {
    throw new Error(`the preview did not show ${time} s: ${JSON.stringify(state)}`);
  });
  return Date.now() - start;
}

describe('The seek preview of an MP4', function() {
  after(async function() {
    await browser.url('about:blank');
  });

  it('shows each place it is pointed at, paused and playing', async function() {
    const source = globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/long-av.mp4?preview=${Date.now()}`;
    await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
    await browser.waitUntil(() => browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      return (client?.player?.getVideo?.()?.readyState ?? 0) >= 2 && !!client.previewPlayer?.getVideo?.();
    }), {timeout: 20000, interval: 100, timeoutMsg: 'the video or its preview did not load'});

    const times = [];
    for (const place of PLACES) {
      times.push(await showPreviewAt(place));
    }
    // The pointer sweeping over the bar: each move restarts the load; the last place shows.
    times.push(await showPreviewAt(80, [20, 40, 60, 79]));
    times.push(await showPreviewAt(81, [80.5]));

    // Playing, the same.
    await browser.execute(() => /** @type {any} */ (window).fastStream.play());
    await browser.waitUntil(() => browser.execute(() => /** @type {any} */ (window).fastStream.currentTime > 1),
        {timeout: 20000, interval: 100, timeoutMsg: 'the video did not play'});
    for (const place of [135, 15, 95]) {
      times.push(await showPreviewAt(place));
    }
    await browser.execute(() => /** @type {any} */ (window).fastStream.hidePreview());
    console.log(`      shown after (ms): ${times.join(' ')}`);
    expect(times.length).toBe(PLACES.length + 5);
  });

  // A fragmented file without its duration in the metadata (no mehd box): the preview knows only
  // what it has read, up to its first frame (about 9 s), and the element landed every place past
  // that on 9 s - each hover past it showed the frame at 9 s (MP4Player's previewSeek).
  it('shows a place far into a fragmented MP4 without its duration in the metadata', async function() {
    // As mp4-files.e2e.mjs writes it.
    ensureMp4Shape('long-fragmented.mp4', ['-i', LONG_FIXTURE, '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov']);
    const source = globalThis.__E2E_FIXTURES_ORIGIN__ + `/fixtures/mp4-shapes/long-fragmented.mp4?preview=${Date.now()}`;
    await browser.url(`/player/index.html?t=${Date.now()}#${source}`);
    // The main player reads ahead by ranges, and knows the duration past 150 s once it has.
    await browser.waitUntil(() => browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      return (client?.player?.getVideo?.()?.readyState ?? 0) >= 2 && !!client.previewPlayer?.getVideo?.() &&
        client.duration > 150;
    }), {timeout: 30000, interval: 100, timeoutMsg: 'the video, its preview or its duration did not load'});

    const times = [];
    for (const place of [120, 30, 150, 60]) {
      times.push(await showPreviewAt(place));
    }
    await browser.execute(() => /** @type {any} */ (window).fastStream.hidePreview());
    console.log(`      shown after (ms): ${times.join(' ')}`);
    expect(times.length).toBe(4);
  });
});
