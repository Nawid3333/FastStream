// The A/B benchmark itself (run by tools/bench-ab.mjs, config wdio.bench.conf.mjs).
//
// Each scenario opens a build's web player on a local video, the same way the playback suite
// does (player/index.html#<url>), with autoplay on as when FastStream takes over a page's video,
// and reads what a probe put into the page before the player's first script:
//
// - client: the player's modules loaded and run (window.fastStream created), ms after navigation
// - firstFrame / playing: the video's loadeddata / first playing, ms after navigation
// - seeked / resumed (MP4): from setting the time to 80 s to seeked, and to playing past it
// - previewReady (MP4, paused): from hovering the seek bar at 120 s (seekPreview) to the
//   preview's frame there; then wake-ups while paused once the hover has left
// - wake-ups once the MP4 has played to its end
// - wake-ups a second while playing, while paused, and in an idle player with no video: timer,
//   interval, animation-frame and idle callbacks the page's own code had run (a probe wraps
//   them; workers and event listeners are not counted)
// - DOM changes a second while playing (a MutationObserver's records)
// - jank: animation frames more than 50 ms apart while playing, and dropped video frames
//
// Builds alternate in each round (ABBA). One round per build is run first and thrown away:
// the first load of a build compiles its modules.
import fs from 'node:fs';
import path from 'node:path';

import {browser} from '@wdio/globals';

import {bench, boundedNumber} from './settings.mjs';
import {compare, renderTable, roundOrder} from './stats.mjs';

const PLAY_MS = boundedNumber('BENCH_PLAY_MS', 5000, 600000);
const PAUSED_MS = boundedNumber('BENCH_PAUSED_MS', 10000, 600000);
const IDLE_MS = boundedNumber('BENCH_IDLE_MS', 5000, 600000);
const WARMUP = bench.warmup;
const SEEK_TO = 80;

/**
 * What each measure is, for the report. floor: below this a difference says nothing (a
 * timeupdate comes about every 250 ms; a frame is 16 ms).
 * @type {Record<string, {label: string, unit: string, floor: number, lowerIsBetter?: boolean}>}
 */
const MEASURES = {
  client: {label: 'player modules ready', unit: 'ms', floor: 5},
  firstFrame: {label: 'first frame', unit: 'ms', floor: 10},
  playing: {label: 'playing', unit: 'ms', floor: 10},
  seeked: {label: 'seek to 80 s: seeked', unit: 'ms', floor: 10},
  resumed: {label: 'seek to 80 s: playing past it', unit: 'ms', floor: 250},
  playWake: {label: 'wake-ups while playing', unit: '/s', floor: 1},
  playMutations: {label: 'DOM changes while playing', unit: '/s', floor: 1},
  longFrames: {label: 'frames > 50 ms apart while playing', unit: '', floor: 1},
  dropped: {label: 'dropped video frames while playing', unit: '', floor: 1},
  pausedWake: {label: 'wake-ups while paused', unit: '/s', floor: 0.5},
  previewReady: {label: 'seek preview at 120 s shown', unit: 'ms', floor: 10},
  afterPreviewWake: {label: 'wake-ups while paused, after a seek preview', unit: '/s', floor: 0.5},
  endedWake: {label: 'wake-ups once the video has ended', unit: '/s', floor: 0.5},
  idleWake: {label: 'wake-ups, idle player (no video)', unit: '/s', floor: 0.5},
};

/**
 * The scenarios: a source, and what to measure on it.
 * @type {Record<string, {source: ((origin: string, run: string) => string) | null, seek?: boolean,
 *   paused?: boolean, playMs?: number}>}
 */
const SCENARIOS = {
  mp4: {source: (origin, run) => `${origin}/fixtures/long-av.mp4?run=${run}`, seek: true, paused: true},
  hls: {source: (origin, run) => `${origin}/fixtures/hls-fmp4/index.m3u8?run=${run}`, playMs: 3000},
  dash: {source: (origin, run) => `${origin}/fixtures/dash-template/manifest.mpd?run=${run}`, playMs: 3000},
  idle: {source: null},
};

/**
 * Put into every page before its first script (addInitScript). Records the moments above in
 * window.__bench, counts the page's callbacks while asked to, and turns autoplay on the moment
 * main.mjs creates the player (window.fastStream), before it loads the source.
 * @param {boolean} where - Also count, per place in the player's code that asked for them,
 *   the callbacks run while counting (BENCH_WHERE=1: to find what wakes a player up).
 */
function probe(where) {
  const now = () => performance.now();
  const B = /** @type {any} */ (window).__bench = {
    marks: {}, counting: false, wake: 0, mutations: 0, gaps: [], seek: null, sites: {},
  };
  // Where in the player's code a callback was asked for: the first frame of the stack that is
  // not this probe's.
  const site = () => {
    // This probe runs as a Function made from the page ("index.html line 2 > Function").
    const frames = (new Error().stack || '').split('\n').filter((line) => /\/player\//.test(line) && !/> Function:/.test(line));
    return (frames[0] || '?').replace(/^(.*?)@.*\/(player\/[^?#:]*)(\?[^:]*)?:(\d+):\d+$/, '$1 $2:$4');
  };
  const original = {
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
  };
  B.original = original;
  /**
   * @param {Function} schedule
   * @return {Function}
   */
  const counted = (schedule) => function(callback, ...rest) {
    if (typeof callback !== 'function') return schedule(callback, ...rest);
    const from = where ? site() : '';
    return schedule((...args) => {
      if (B.counting) {
        B.wake++;
        if (where) B.sites[from] = (B.sites[from] || 0) + 1;
      }
      return callback(...args);
    }, ...rest);
  };
  window.setTimeout = /** @type {any} */ (counted(window.setTimeout.bind(window)));
  window.setInterval = /** @type {any} */ (counted(original.setInterval));
  window.requestAnimationFrame = /** @type {any} */ (counted(original.requestAnimationFrame));
  if (window.requestIdleCallback) {
    window.requestIdleCallback = /** @type {any} */ (counted(window.requestIdleCallback.bind(window)));
  }
  const mark = (name) => {
    if (!(name in B.marks)) B.marks[name] = now();
  };
  let client;
  Object.defineProperty(window, 'fastStream', {
    configurable: true,
    get: () => client,
    set: (value) => {
      client = value;
      mark('client');
      value?.setAutoPlay?.(true);
    },
  });
  B.observer = new MutationObserver((records) => {
    if (B.counting) B.mutations += records.length;
  });
  // The player's video, once it has one: polled with the original setInterval (not counted).
  let video = null;
  const watch = original.setInterval(() => {
    const found = client?.player?.getVideo?.();
    if (!found || found === video) return;
    video = found;
    B.video = found;
    found.addEventListener('loadeddata', () => mark('firstFrame'));
    found.addEventListener('playing', () => mark('playing'));
    found.addEventListener('seeked', () => {
      if (B.seek && B.seek.seeked === undefined) B.seek.seeked = now() - B.seek.start;
    });
    found.addEventListener('timeupdate', () => {
      if (B.seek && B.seek.resumed === undefined && !found.paused && found.currentTime >= B.seek.to + 0.2) {
        B.seek.resumed = now() - B.seek.start;
      }
    });
    if (found.readyState >= 2) mark('firstFrame');
    original.clearInterval(watch);
  }, 5);
}

/**
 * Starts counting in the page: wake-ups, DOM changes, frame gaps and dropped frames.
 * @return {Promise<void>}
 */
async function startCounting() {
  await browser.execute(() => {
    const B = /** @type {any} */ (window).__bench;
    B.wake = 0;
    B.sites = {};
    B.mutations = 0;
    B.gaps = [];
    B.droppedAtStart = B.video?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0;
    B.observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
    B.countStart = performance.now();
    B.counting = true;
    let last = performance.now();
    const frame = (time) => {
      if (!B.counting) return;
      B.gaps.push(time - last);
      last = time;
      B.original.requestAnimationFrame(frame);
    };
    B.original.requestAnimationFrame(frame);
  });
}

/**
 * Stops counting and reads the counts.
 * @return {Promise<{seconds: number, wake: number, mutations: number, longFrames: number,
 *   dropped: number, sites: Record<string, number>}>}
 */
async function stopCounting() {
  return browser.execute(() => {
    const B = /** @type {any} */ (window).__bench;
    B.counting = false;
    B.observer.disconnect();
    const seconds = (performance.now() - B.countStart) / 1000;
    const dropped = (B.video?.getVideoPlaybackQuality?.().droppedVideoFrames ?? 0) - B.droppedAtStart;
    // The first gap is from the moment counting began, not between two frames.
    const longFrames = B.gaps.slice(1).filter((gap) => gap > 50).length;
    return {seconds, wake: B.wake, mutations: B.mutations, longFrames, dropped, sites: B.sites};
  });
}

/**
 * With BENCH_WHERE=1: which places in the player's code asked for the callbacks counted.
 * @param {string} what
 * @param {{seconds: number, sites: Record<string, number>}} counted
 */
function logSites(what, {seconds, sites}) {
  if (!bench.where) return;
  const top = Object.entries(sites).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const lines = top.map(([site, n]) => `          ${(n / seconds).toFixed(1).padStart(6)}  ${site}`);
  console.log(`        ${what}, a second:\n${lines.join('\n')}`);
}

/**
 * Waits for the page's probe to hold something.
 * @param {() => any} read - Runs in the page; done when it returns something not undefined.
 * @param {number} timeout
 * @param {string} what
 * @return {Promise<any>}
 */
async function waitFor(read, timeout, what) {
  let value;
  await browser.waitUntil(async () => {
    value = await browser.execute(read);
    return value !== undefined && value !== null;
  }, {timeout, interval: 50, timeoutMsg: `timed out waiting for ${what}`});
  return value;
}

/**
 * One run of a scenario on one build.
 * @param {string} name - The scenario.
 * @param {'A'|'B'} build
 * @param {string} run - Makes the video's address new each run: the player remembers where a
 *   video was left, and would start the next run there.
 * @return {Promise<Record<string, number>>} The measures.
 */
async function runOnce(name, build, run) {
  const scenario = SCENARIOS[name];
  const origin = bench.origins[build];
  const source = scenario.source ? '#' + scenario.source(origin, run) : '';
  await browser.url(`${origin}/player/index.html?t=${run}${source}`);
  /** @type {Record<string, number>} */
  const result = {};
  if (!scenario.source) {
    await waitFor(() => /** @type {any} */ (window).__bench?.marks.client, 20000, 'the player');
    result.client = await browser.execute(() => /** @type {any} */ (window).__bench.marks.client);
    await browser.pause(1000);
    await startCounting();
    await browser.pause(IDLE_MS);
    const idle = await stopCounting();
    logSites('idle', idle);
    result.idleWake = idle.wake / idle.seconds;
    return result;
  }
  await waitFor(() => /** @type {any} */ (window).__bench?.marks.playing, 30000, 'playing');
  const marks = await browser.execute(() => /** @type {any} */ (window).__bench.marks);
  Object.assign(result, {client: marks.client, firstFrame: marks.firstFrame, playing: marks.playing});

  if (scenario.seek) {
    // Two seconds in, as someone skipping ahead would.
    await browser.pause(2000);
    await browser.execute((to) => {
      const B = /** @type {any} */ (window).__bench;
      B.seek = {to, start: performance.now()};
      /** @type {any} */ (window).fastStream.currentTime = to;
    }, SEEK_TO);
    result.resumed = await waitFor(() => /** @type {any} */ (window).__bench.seek.resumed, 30000, 'playing after the seek');
    result.seeked = await browser.execute(() => /** @type {any} */ (window).__bench.seek.seeked);
  }

  await startCounting();
  await browser.pause(scenario.playMs ?? PLAY_MS);
  const playing = await stopCounting();
  logSites('playing', playing);
  Object.assign(result, {
    playWake: playing.wake / playing.seconds,
    playMutations: playing.mutations / playing.seconds,
    longFrames: playing.longFrames,
    dropped: playing.dropped,
  });

  if (scenario.paused) {
    await browser.execute(() => /** @type {any} */ (window).fastStream.pause());
    await browser.pause(1000);
    await startCounting();
    await browser.pause(PAUSED_MS);
    const paused = await stopCounting();
    logSites('paused', paused);
    result.pausedWake = paused.wake / paused.seconds;

    // A hover over the seek bar far ahead, which the preview player loads, then leaves.
    result.previewReady = await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      const preview = client.previewPlayer?.getVideo?.();
      if (!preview) return NaN;
      const B = /** @type {any} */ (window).__bench;
      B.preview = {start: performance.now()};
      const shown = () => {
        if (B.preview.ready === undefined && !preview.seeking && preview.readyState >= 2) {
          B.preview.ready = performance.now() - B.preview.start;
        }
      };
      preview.addEventListener('seeked', shown);
      preview.addEventListener('loadeddata', shown);
      client.seekPreview(120);
      return undefined;
    }) ?? await waitFor(() => /** @type {any} */ (window).__bench.preview.ready, 20000, 'the seek preview');
    await browser.execute(() => /** @type {any} */ (window).fastStream.hidePreview());
    await browser.pause(1000);
    await startCounting();
    await browser.pause(IDLE_MS);
    const after = await stopCounting();
    logSites('paused, after a seek preview', after);
    result.afterPreviewWake = after.wake / after.seconds;

    // Played to its end, where nothing is ahead to load.
    await browser.execute(() => {
      const client = /** @type {any} */ (window).fastStream;
      const B = /** @type {any} */ (window).__bench;
      B.video.addEventListener('ended', () => B.ended = true, {once: true});
      client.currentTime = client.duration - 1.5;
      client.play();
    });
    await waitFor(() => /** @type {any} */ (window).__bench.ended || undefined, 30000, 'the end');
    await browser.pause(1000);
    await startCounting();
    await browser.pause(IDLE_MS);
    const ended = await stopCounting();
    logSites('ended', ended);
    result.endedWake = ended.wake / ended.seconds;
  }
  return result;
}

describe('A/B benchmark', function() {
  /** @type {Record<string, {A: Record<string, number[]>, B: Record<string, number[]>}>} */
  const results = {};
  /** @type {string[]} */
  const failures = [];

  before(async function() {
    await browser.addInitScript(probe, bench.where);
  });

  // A name asked for that no scenario has fails loudly, as a test of its own.
  for (const name of bench.scenarios.filter((asked) => !Object.hasOwn(SCENARIOS, asked))) {
    it(`measures ${name}`, function() {
      throw new Error(`no scenario ${name} (have ${Object.keys(SCENARIOS).join(', ')})`);
    });
  }

  // The names come from SCENARIOS itself, so nothing passed in names a key of the results.
  for (const name of Object.keys(SCENARIOS).filter((known) => bench.scenarios.includes(known))) {
    it(`measures ${name}`, async function() {
      results[name] = {A: {}, B: {}};
      for (let round = -WARMUP; round < bench.rounds; round++) {
        for (const build of roundOrder(round + WARMUP)) {
          const run = `${name}-${build}-${round}-${Date.now()}`;
          let measured;
          try {
            measured = await runOnce(name, build, run);
          } catch (error) {
            failures.push(`${name} ${bench.labels[build]} round ${round}: ${error.message}`);
            console.log(`      ${name} ${build} round ${round}: FAILED ${error.message}`);
            continue;
          } finally {
            await browser.url('about:blank');
            await browser.pause(300);
          }
          if (round < 0) continue;
          console.log(`      ${name} ${build} round ${round}: ${JSON.stringify(measured, (key, value) =>
            typeof value === 'number' ? Math.round(value * 10) / 10 : value)}`);
          for (const [measure, value] of Object.entries(measured)) {
            (results[name][build][measure] ||= []).push(value);
          }
        }
      }
      // A scenario no run of a build got through is a broken build or harness, not a number.
      for (const build of /** @type {const} */ (['A', 'B'])) {
        if (!Object.keys(results[name][build]).length) {
          throw new Error(`${name}: no run on ${bench.labels[build]} finished:\n${failures.join('\n')}`);
        }
      }
    });
  }

  after(function() {
    const rows = [];
    for (const [scenario, {A, B}] of Object.entries(results)) {
      for (const [measure, how] of Object.entries(MEASURES)) {
        if (!A[measure] && !B[measure]) continue;
        rows.push({scenario, measure: how.label, unit: how.unit,
          result: compare(A[measure] || [], B[measure] || [], {floor: how.floor, lowerIsBetter: how.lowerIsBetter ?? true})});
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const line = bench.line.rateMbit ? `${bench.line.rateMbit} Mbit/s shared line, ${bench.line.ttfbMs} ms to first byte` :
      (bench.line.ttfbMs ? `no rate limit, ${bench.line.ttfbMs} ms to first byte` : 'local, no limit');
    const header = [
      `# A/B benchmark ${new Date().toISOString()}`,
      '',
      `A = ${bench.labels.A}, B = ${bench.labels.B}. ${bench.rounds} rounds a build (ABBA), ` +
        `${WARMUP} warm-up round thrown away; media: ${line}.`,
      'Verdict: B against A, only where the medians differ by more than twice the larger MAD ' +
        'and the measure\'s floor; "same" otherwise.',
      '',
    ];
    const markdown = [...header, renderTable(rows, bench.labels), '',
      ...(failures.length ? ['Failed runs:', '', ...failures.map((failure) => `- ${failure}`), ''] : [])].join('\n');
    fs.writeFileSync(path.join(bench.out, `ab-${stamp}.md`), markdown);
    fs.writeFileSync(path.join(bench.out, `ab-${stamp}.json`),
        JSON.stringify({labels: bench.labels, line: bench.line, rounds: bench.rounds, warmup: WARMUP, results, failures}, null, 2));
    console.log('\n' + markdown);
  });
});
