// Autoplay next, on to an episode whose page waits for a click before its player loads
// anything (his report, 2026-10-11, serienstream.to: the next episode came, and he had to
// click it). The hoster there is a JW Player, idle until played; another kind loads its
// video on a click on it. After FastStream went to the next episode by itself, it starts the
// page's player (content.js startPagePlayer, background.mjs startPagePlayers), takes the
// stream, and its own player plays it, all without a click.
import fs from 'node:fs';
import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {setOptions} from '../live-specs/liveSite.mjs';

const PORT = 41874;
const SITE = `http://127.0.0.1:${PORT}`;
let server;

const next = (to) => `<p><a href="/${to}" style="display: inline-block; width: 120px; height: 24px">Next episode</a></p>`;
const SERIES = '/anime/stream/girls';
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
    // A series as aniworld.cc has it (his report, 2026-10-11: after a season's last episode,
    // autoplay went on to another series): its season, its episodes, then other series.
    [`${SERIES}/staffel-1/episode-1`]: seriesPage(file, 1),
    [`${SERIES}/staffel-1/episode-2`]: seriesPage(file, 2),
    '/anime/stream/other/staffel-1/episode-1': `<!doctype html><title>another series</title>
<video preload="auto" style="${style}" src="${file}?ep=99"></video>`,
  };
}

/**
 * An episode of a two-episode series, as aniworld.cc lays it out.
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

  it('keeps a fullscreen into the next episode, and Escape gives the window back', async function() {
    // His report (2026-10-11): the next episode played windowed, because Firefox lets no page
    // go fullscreen without a click. The browser window goes fullscreen instead
    // (background.mjs setCarriedFullscreen) and the player fills the page. Firefox's
    // window.fullScreen is the browser window in fullscreen mode (as F11), read in the page:
    // WebDriver's scripts have no extension API in the player's frame.
    // A blank page first: the test before ends with an episode playing in this tab.
    await browser.url('about:blank');
    await browser.url(`${SITE}/ep1`);
    await intoPlayer('the first episode');
    await browser.waitUntil(() => browser.execute(() => (window.fastStream?.player?.getVideo?.()?.readyState || 0) >= 2),
        {timeout: 30000, timeoutMsg: 'the first episode never loaded'});
    // Episode 1 in fullscreen, as the player knows it (a real one needs a click on its button,
    // which WebDriver's element lookup in the player's frame cannot reach): what goes on to
    // the next episode is the player's own state (getFullscreenState, in its continuation).
    await browser.execute(() => {
      window.fastStream.state.fullscreen = true;
    });
    await playToTheEnd();

    await onPage('/ep2');
    await intoPlayer('the next episode');
    await browser.waitUntil(() => browser.execute(() => !!window.fastStream?.state?.carriedFullscreen),
        {timeout: 30000, timeoutMsg: 'the next episode did not carry the fullscreen'});
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

  it('stops after the series\' last episode, says so, and never goes on to another series', async function() {
    await browser.url('about:blank');
    await browser.url(`${SITE}${SERIES}/staffel-1/episode-1`);
    await intoPlayer('the series\' first episode');
    await playToTheEnd();

    await onPage(`${SERIES}/staffel-1/episode-2`);
    await intoPlayer('the series\' last episode');
    expect((await playsByItself(22))?.paused).toBe(false);
    // The page told the player its series ends here (content.js isSeriesEnd).
    await browser.waitUntil(() => browser.execute(() => window.fastStream.state.seriesEnd === true &&
        !window.fastStream.hasNextVideo()), {timeout: 30000, timeoutMsg: 'the player never heard the series ends there'});
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
