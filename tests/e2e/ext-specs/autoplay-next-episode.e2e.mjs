// Autoplay next onto an episode whose page player waits for a click: FastStream starts the page's
// player (content.js startPagePlayer), takes the stream and plays it, no click.
import fs from 'node:fs';
import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {setOptions} from '../live-specs/liveSite.mjs';

const PORT = 41874;
const SITE = `http://127.0.0.1:${PORT}`;
let server;

const next = (to) => `<p><a href="/${to}" style="display: inline-block; width: 120px; height: 24px">Next episode</a></p>`;
const SERIES = '/anime/stream/example-series';
const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));
const style = 'width: 640px; height: 360px; display: block';

/**
 * The three episode pages.
 * @param {string} file - The video.
 * @return {Object<string, string>} Pages by path.
 */
function pages(file) {
  return {
    // A page whose video plays at once: FastStream takes it.
    '/ep1': `<!doctype html><title>episode 1</title>
<video preload="auto" style="${style}" src="${file}?ep=1"></video>${next('ep2')}`,
    // An episode whose title names its series, season and episode, as a site's does.
    '/named': `<!doctype html><title>Example Series - Season 1 Episode 3 | A Series Site</title>
<video preload="auto" style="${style}" src="${file}?ep=named"></video>`,
    // The same video as WebM, which FastStream plays as it is (DirectVideoPlayer, no MSE).
    '/webm': `<!doctype html><title>a WebM video</title>
<video preload="auto" style="${style}" src="${file.replace(/\.mp4$/, '.webm')}"></video>`,
    // A JW Player as a hoster has it: idle, nothing loaded, until its play().
    '/ep2': `<!doctype html><title>episode 2</title>
<div id="jw" style="${style}"><video style="${style}"></video></div>${next('ep3')}
<script>
  let state = 'idle';
  window.jwplayer = () => ({
    getState: () => state,
    play() {
      if (state !== 'idle') return;
      state = 'buffering';
      const video = document.querySelector('#jw video');
      video.src = '${file}?ep=2';
      video.play().catch(() => {});
    },
  });
</script>`,
    // A player that loads its video on a click on it.
    '/ep3': `<!doctype html><title>episode 3</title>
<div id="box" style="${style}"><video style="${style}"></video></div>${next('ep4')}
<script>
  document.getElementById('box').addEventListener('click', () => {
    const video = document.querySelector('#box video');
    if (video.src) return;
    video.src = '${file}?ep=3';
    video.play().catch(() => {});
  });
</script>`,
    // A Video.js player: nothing loaded until its own play().
    '/ep4': `<!doctype html><title>episode 4</title>
<div id="vjs" style="${style}"><video style="${style}"></video></div>${next('ep5')}
<script>
  let started = false;
  const video = document.querySelector('#vjs video');
  const player = {
    paused: () => video.paused,
    hasStarted: () => started,
    play() {
      started = true;
      video.src = '${file}?ep=4';
      return video.play().catch(() => {});
    },
  };
  window.videojs = () => player;
  window.videojs.getPlayers = () => ({vjs: player});
</script>`,
    // A player with a big play button over its picture, which alone loads it: a click on
    // the video does nothing.
    '/ep5': `<!doctype html><title>episode 5</title>
<div style="position: relative; ${style}">
  <video style="${style}"></video>
  <button class="vjs-big-play-button" style="position: absolute; left: 270px; top: 130px; width: 100px; height: 100px">Play</button>
</div>
<script>
  document.querySelector('.vjs-big-play-button').addEventListener('click', (event) => {
    event.currentTarget.style.display = 'none';
    const video = document.querySelector('video');
    video.src = '${file}?ep=5';
    video.play().catch(() => {});
  });
</script>`,
    // A series as an anime site has it: its season, its episodes, then other series.
    [`${SERIES}/staffel-1/episode-1`]: seriesPage(file, 1),
    [`${SERIES}/staffel-1/episode-2`]: seriesPage(file, 2),
    '/anime/stream/other/staffel-1/episode-1': `<!doctype html><title>another series</title>
<video preload="auto" style="${style}" src="${file}?ep=99"></video>`,
  };
}

/**
 * An episode of a two-episode series, as an anime site lays it out.
 * @param {string} file - The video.
 * @param {number} episode
 * @return {string}
 */
function seriesPage(file, episode) {
  return `<!doctype html><meta charset="utf-8"><title>girls, episode ${episode}</title>
<video preload="auto" style="${style}" src="${file}?ep=2${episode}"></video>
<ul><li><a href="${SERIES}/staffel-1">Staffel 1</a></li></ul>
<ul><li><a href="${SERIES}/staffel-1/episode-1">1</a></li><li><a href="${SERIES}/staffel-1/episode-2">2</a></li></ul>
<ul><li><a href="/anime/stream/other/staffel-1/episode-1">Another series</a></li></ul>`;
}

/**
 * A test's steps, logged with the seconds since it began, so a timeout says where.
 * @return {(what: string) => void}
 */
function stepLog() {
  const start = Date.now();
  return (what) => console.log(`      [${((Date.now() - start) / 1000).toFixed(1)} s] ${what}`);
}

/**
 * Waits for FastStream's player in the page, and switches into it.
 * @param {string} what - For the failure message.
 */
async function intoPlayer(what) {
  await browser.switchFrame(null);
  await browser.waitUntil(() => browser.$('iframe[src*="player/index.html"]').isExisting(),
      {timeout: 30000, timeoutMsg: `FastStream never took ${what}`});
  await browser.switchFrame(await browser.$('iframe[src*="player/index.html"]'));
}

/**
 * Clicks the progress bar's last pixel once the player's frame has its size, checked in the click's
 * task.
 * A bar 0 wide does not seek, and the out-of-process frame gets its size asynchronously; a long
 * wait is logged.
 * @param {string} what - For the messages.
 * @param {boolean} pause - Pause the video first.
 * @return {Promise<{before: number, sought: number, time: number, duration: number, barWidth: number,
 *   frame: string, visibility: string}>} The click's state: before it, right after the press, after.
 */
async function clickBarEnd(what, pause) {
  const since = Date.now();
  /** @type {any} */
  let at = null;
  await browser.waitUntil(async () => {
    at = await browser.execute(async (pause) => {
      // A script error is told as itself, not as a frame without a size.
      try {
        if (pause) await window.fastStream.pause();
        const bar = /** @type {?HTMLElement} */ (document.querySelector('.mainplayer .fluid_controls_progress_container'));
        const frame = `${innerWidth}x${innerHeight}`;
        if (!bar || !(bar.clientWidth > 0) || !(innerWidth > 0)) return {clicked: false, barWidth: bar?.clientWidth ?? null, frame};
        const before = window.fastStream.currentTime;
        const rect = bar.getBoundingClientRect();
        const x = rect.left + rect.width - 1;
        const y = rect.top + rect.height / 2;
        bar.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, button: 0, clientX: x, clientY: y}));
        const sought = window.fastStream.currentTime;
        document.dispatchEvent(new MouseEvent('mouseup', {bubbles: true, button: 0, clientX: x, clientY: y}));
        return {clicked: true, before, sought, time: window.fastStream.currentTime, duration: window.fastStream.duration,
          barWidth: bar.clientWidth, frame, visibility: document.visibilityState};
      } catch (e) {
        return {clicked: false, error: String(e)};
      }
    }, pause);
    return at.clicked || !!at.error;
  }, {timeout: 10000, interval: 100}).catch(async () => {
    const state = at;
    throw new Error(`${what}: the player frame never got its size: ${JSON.stringify(state)}; the page: ${JSON.stringify(await pageFrames())}`);
  });
  if (at.error) throw new Error(`${what}: the click on the bar failed: ${at.error}`);
  const waited = Date.now() - since;
  if (waited > 1000) console.log(`      ${what}: the player's frame had no size for the click for ${waited} ms`);
  return at;
}

/**
 * The page's player frames as the page lays them out, for a failure's message. Leaves the context
 * at the page.
 * @return {Promise<Object>}
 */
async function pageFrames() {
  await browser.switchFrame(null);
  return browser.execute(() => ({visibility: document.visibilityState, window: `${innerWidth}x${innerHeight}`,
    frames: Array.from(document.querySelectorAll('iframe'), (frame) => {
      const style = getComputedStyle(frame);
      const box = frame.getBoundingClientRect();
      return {player: frame.src.includes('player/index.html'), connected: frame.isConnected, display: style.display,
        visibility: style.visibility, position: style.position,
        box: [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)],
        inline: (frame.getAttribute('style') || '').slice(0, 300)};
    })}));
}

/**
 * Waits until the player plays its video, by itself.
 * @param {string} episode - The ep= the source must name.
 * @return {Promise<Object>} The player's state.
 */
async function playsByItself(episode) {
  let state;
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const video = window.fastStream?.player?.getVideo?.();
      return video ? {url: window.fastStream.source?.url, paused: video.paused, time: video.currentTime} : null;
    });
    return !!state && state.url?.includes(`ep=${episode}`) && !state.paused && state.time > 0.5;
  }, {timeout: 30000, interval: 250}).catch(() => {});
  console.log(`      episode ${episode}: ${JSON.stringify(state)}`);
  return state;
}

/** Plays the player's video into its end, which goes on to the next episode. */
async function playToTheEnd() {
  await browser.waitUntil(() => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2 &&
      window.fastStream.hasNextVideo()), {timeout: 30000, timeoutMsg: 'the player never found the next episode'});
  await browser.execute(() => {
    const client = window.fastStream;
    client.currentTime = Math.max(0, client.duration - 1.5);
    client.play();
  });
}

/**
 * Waits for the tab to show a page.
 * @param {string} path
 */
async function onPage(path) {
  await browser.switchFrame(null);
  await browser.waitUntil(async () => (await browser.getUrl()) === SITE + path,
      {timeout: 30000, timeoutMsg: `autoplay next never went on to ${path}`});
}

describe('Autoplay next, on to a page whose player waits for a click', function() {
  before(async function() {
    const routes = pages(globalThis.__EXT_FIXTURE_MP4__);
    server = http.createServer((req, res) => {
      const page = routes[new URL(req.url, SITE).pathname];
      res.writeHead(page ? 200 : 404, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(page || '');
    });
    await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    await setOptions({autoEnableURLs: [SITE], autoplayNext: true});
  });

  after(async function() {
    await browser.switchFrame(null);
    await setOptions({});
    await new Promise((resolve) => server.close(resolve));
  });

  it('starts each kind of waiting player (JW, a click, Video.js, a big play button) and plays it without a click', async function() {
    await browser.url(`${SITE}/ep1`);
    await intoPlayer('the first episode');
    await playToTheEnd();

    await onPage('/ep2');
    await intoPlayer('the JW Player\'s episode');
    expect((await playsByItself(2))?.paused).toBe(false);

    await playToTheEnd();
    await onPage('/ep3');
    await intoPlayer('the episode that loads on a click');
    expect((await playsByItself(3))?.paused).toBe(false);

    await playToTheEnd();
    await onPage('/ep4');
    await intoPlayer('the Video.js episode');
    expect((await playsByItself(4))?.paused).toBe(false);

    await playToTheEnd();
    await onPage('/ep5');
    await intoPlayer('the episode behind a big play button');
    expect((await playsByItself(5))?.paused).toBe(false);
  });

  it('gives the next episode\'s player the keyboard: F goes fullscreen without a click', async function() {
    // after autoplay went on, F and Space work without a click in the player
    const step = stepLog();
    await browser.url('about:blank');
    await browser.url(`${SITE}/ep1`);
    step('episode 1 loaded');
    await intoPlayer('the first episode');
    step('in episode 1\'s player');
    await playToTheEnd();
    step('episode 1 played to its end');
    await onPage('/ep2');
    step('on episode 2');
    await intoPlayer('the next episode');
    step('in episode 2\'s player');
    expect((await playsByItself(2))?.paused).toBe(false);
    expect(await browser.execute(() => document.hasFocus())).toBe(true);
    step('episode 2 plays, its player has the keyboard');

    // The key as the user presses it, where the keyboard is, with no click before.
    await browser.switchFrame(null);
    await browser.keys(['f']);
    await browser.waitUntil(() => browser.execute(() => !!document.fullscreenElement),
        {timeout: 10000, timeoutMsg: 'F did not reach the player'});
    step('fullscreen');
    await browser.execute(() => document.exitFullscreen());
    await browser.waitUntil(() => browser.execute(() => !document.fullscreenElement), {timeout: 10000});
    step('fullscreen left');
  });

  it('keeps a fullscreen into the next episode, and Escape gives the window back', async function() {
    // Firefox lets no page go fullscreen without a click: the browser window does
    // (setCarriedFullscreen) and the player fills the page.
    await browser.url('about:blank');
    await browser.url(`${SITE}/ep1`);
    await intoPlayer('the first episode');
    await browser.waitUntil(() => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2),
        {timeout: 30000, timeoutMsg: 'the first episode never loaded'});
    // Episode 1 in fullscreen as the player knows it: what goes on is the player's own state
    // (getFullscreenState).
    await browser.execute(() => {
      window.fastStream.state.fullscreen = true;
    });
    await playToTheEnd();

    await onPage('/ep2');
    await intoPlayer('the next episode');
    // Both halves: carriedFullscreen at once, windowedFullscreen once the background answers the
    // second request.
    let carried;
    await browser.waitUntil(async () => {
      carried = await browser.execute(() => ({
        carried: !!window.fastStream?.state?.carriedFullscreen,
        fillsPage: !!window.fastStream?.state?.windowedFullscreen,
      }));
      return carried.carried && carried.fillsPage;
    }, {timeout: 30000, interval: 250}).catch(() => {
      throw new Error(`the next episode did not carry the fullscreen: ${JSON.stringify(carried)}`);
    });
    expect(await browser.execute(() => ({
      state: window.fastStream.getFullscreenState(),
      fillsPage: !!window.fastStream.state.windowedFullscreen,
      button: document.querySelector('.mainplayer .fluid_control_fullscreen').classList.contains('out'),
    }))).toEqual({state: 'fullscreen', fillsPage: true, button: true});

    // The browser window, read in the page; Escape where the keyboard is after the page loaded.
    await browser.switchFrame(null);
    expect(await browser.execute(() => window.fullScreen)).toBe(true);
    await browser.keys(['Escape']);
    await browser.waitUntil(() => browser.execute(() => !window.fullScreen),
        {timeout: 10000, timeoutMsg: 'Escape left the window fullscreen'});
    await intoPlayer('the next episode');
    await browser.waitUntil(() => browser.execute(() => !window.fastStream.state.carriedFullscreen &&
        !window.fastStream.state.windowedFullscreen), {timeout: 10000, timeoutMsg: 'the player still fills the page'});
  });

  // the countdown set in the options is the player's; 0 turns the banner off
  it('counts down for as long as the options say', async function() {
    await setOptions({autoEnableURLs: [SITE], autoplayNext: true, autoplayCountdown: 12});
    try {
      await browser.url(`${SITE}/ep1`);
      await intoPlayer('the first episode');
      await browser.waitUntil(() => browser.execute(() => !!window.fastStream?.player), {timeout: 30000});
      expect(await browser.execute(() => window.fastStream.options.autoplayCountdown)).toBe(12);
    } finally {
      await browser.switchFrame(null);
      await setOptions({autoEnableURLs: [SITE], autoplayNext: true});
    }
  });

  // The player's Media Session names the video, shows a frame and has a time line and seek keys
  // (MediaKeys).
  it('gives the system\'s media overlay the video\'s name and a frame of it', async function() {
    await browser.url(`${SITE}/named`);
    await intoPlayer('the named episode');
    try {
      await browser.waitUntil(() => browser.execute(() => (navigator.mediaSession.metadata?.artwork?.length || 0) > 0),
          {timeout: 30000});
    } catch (e) {
      const state = await browser.execute(() => {
        const keys = window.fastStream?.interfaceController?.toolManager?.mediaKeys;
        const video = window.fastStream?.player?.getVideo?.();
        return {metadata: navigator.mediaSession.metadata && {title: navigator.mediaSession.metadata.title},
          info: keys?.info, artwork: keys?.artwork, taken: window.fastStream?.artworkTaken, mediaInfo: window.fastStream?.mediaInfo,
          video: video && {readyState: video.readyState, width: video.videoWidth, paused: video.paused, src: String(video.currentSrc).slice(0, 40)}};
      });
      throw new Error(`the overlay never got a picture of the video: ${JSON.stringify(state)}`);
    }
    const overlay = await browser.execute(() => {
      const meta = /** @type {MediaMetadata} */ (navigator.mediaSession.metadata);
      return {
        title: meta.title,
        artist: meta.artist,
        artwork: meta.artwork.map((art) => ({blob: art.src.startsWith('blob:'), sizes: art.sizes, type: art.type})),
      };
    });
    expect(overlay).toEqual({
      title: 'Example Series',
      artist: 'S01E03',
      artwork: [{blob: true, sizes: expect.stringMatching(/^320x\d+$/), type: 'image/jpeg'}],
    });
    // The picture is a frame of the video, not an empty one: it decodes to its size.
    const decoded = await browser.execute(async () => {
      const art = /** @type {MediaMetadata} */ (navigator.mediaSession.metadata).artwork[0];
      const bitmap = await createImageBitmap(await (await fetch(art.src)).blob());
      return `${bitmap.width}x${bitmap.height}`;
    });
    expect(decoded).toBe(overlay.artwork[0].sizes);
    // Once it plays, the overlay's seek keys are the player's too: Firefox took each handler.
    const firstPicture = await browser.execute(() => navigator.mediaSession.metadata.artwork[0].src);
    await browser.execute(() => window.fastStream.play());
    await browser.waitUntil(() => browser.execute(() => window.fastStream.interfaceController.toolManager.mediaKeys.seekOffered),
        {timeout: 15000, timeoutMsg: 'the seek keys were never offered once the video played'});
    expect(await browser.execute(() => window.fastStream.interfaceController.toolManager.mediaKeys.offered))
        .toMatchObject({seekbackward: true, seekforward: true, seekto: true});
    // A few seconds in, a later frame replaces the first, which is often black.
    await browser.waitUntil(() => browser.execute((first) => window.fastStream.artworkTaken === true &&
        navigator.mediaSession.metadata?.artwork?.[0]?.src !== first, firstPicture),
    {timeout: 20000, timeoutMsg: 'the picture was never taken again a few seconds in'});
  });

  // A click on the bar's last pixel reaches the end, and the next episode follows.
  it('goes on to the next episode after a click on the bar\'s end, also paused', async function() {
    await browser.url(`${SITE}/ep1`);
    await intoPlayer('the first episode');
    await browser.waitUntil(() => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2 &&
        window.fastStream.hasNextVideo()), {timeout: 30000, timeoutMsg: 'the player never found the next episode'});
    // The keyboard's next-track key goes there as well: Firefox took the player's handler, in
    // the page's frame (MediaKeys; a key itself cannot be pressed from here).
    expect(await browser.execute(() => window.fastStream.interfaceController.toolManager.mediaKeys.offered.nexttrack)).toBe(true);
    // Paused, then the bar's last pixel, pressed and let go as a click there.
    const at = await clickBarEnd('the first episode', true);
    console.log(`      clicked the bar's end: ${JSON.stringify(at)}`);
    // a click that did not seek is said here, not after the 30 s wait
    if (!(at.time > at.duration - 0.25)) {
      throw new Error(`the click on the bar's end did not seek: ${JSON.stringify(at)}`);
    }
    await onPage('/ep2');
  });

  // A click at the end of a playing video does not start it again (Firefox does not count it
  // ended). Autoplay off.
  it('ends a playing video after a click on the bar\'s end, and does not start it again', async function() {
    await setOptions({autoEnableURLs: [SITE], autoplayNext: false});
    try {
      // An MP4 (MP4Player, through MSE) and a WebM (DirectVideoPlayer, the file itself).
      for (const page of ['/ep1', '/webm']) {
        await browser.url(`${SITE}${page}`);
        await intoPlayer(page);
        await browser.waitUntil(() => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2),
            {timeout: 30000, timeoutMsg: `${page}: the video never loaded`});
        await browser.execute(() => window.fastStream.play());
        await browser.waitUntil(() => browser.execute(() => window.fastStream.state.playing),
            {timeout: 10000, timeoutMsg: `${page}: the video never played`});
        const at = await clickBarEnd(page, false);
        await browser.pause(1500);
        const after = await browser.execute(() => ({player: window.fastStream.player.constructor.name,
          time: window.fastStream.currentTime, duration: window.fastStream.duration}));
        // the click's own state tells a click that did not seek from one started again
        console.log(`      ${page}, 1.5 s after the click: ${JSON.stringify({...after, click: at})}`);
        // Started again, it would be about 1.5 s in.
        expect(after.time).toBeGreaterThan(after.duration - 0.25);
      }
    } finally {
      await browser.switchFrame(null);
      await setOptions({autoEnableURLs: [SITE], autoplayNext: true});
    }
  });

  it('stops after the series\' last episode, says so, and never goes on to another series', async function() {
    const step = stepLog();
    await browser.url('about:blank');
    await browser.url(`${SITE}${SERIES}/staffel-1/episode-1`);
    step('episode 1 loaded');
    await intoPlayer('the series\' first episode');
    step('in episode 1\'s player');
    await playToTheEnd();
    step('episode 1 played to its end');

    await onPage(`${SERIES}/staffel-1/episode-2`);
    step('on episode 2');
    await intoPlayer('the series\' last episode');
    step('in episode 2\'s player');
    expect((await playsByItself(22))?.paused).toBe(false);
    // The page told the player its series ends here (content.js isSeriesEnd).
    await browser.waitUntil(() => browser.execute(() => window.fastStream.state.seriesEnd === true &&
        !window.fastStream.hasNextVideo()), {timeout: 30000, timeoutMsg: 'the player never heard the series ends there'});
    step('the player knows the series ends');
    await browser.execute(() => {
      const client = window.fastStream;
      client.currentTime = Math.max(0, client.duration - 1.5);
      client.play();
    });
    const said = en.player_autoplay_series_end.message;
    await browser.waitUntil(() => browser.execute((said) => Array.from(document.querySelectorAll('.mainplayer .status_message'))
        .some((el) => el.textContent.includes(said)), said), {timeout: 15000, timeoutMsg: 'the player did not say the series ended'});
    // A while later the tab is still on the series.
    await browser.pause(4000);
    await browser.switchFrame(null);
    expect(await browser.getUrl()).toBe(`${SITE}${SERIES}/staffel-1/episode-2`);
  });
});
