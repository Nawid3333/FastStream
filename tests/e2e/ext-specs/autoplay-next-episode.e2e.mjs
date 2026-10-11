// Autoplay next, on to an episode whose page waits for a click before its player loads
// anything (his report, 2026-10-11, serienstream.to: the next episode came, and he had to
// click it). The hoster there is a JW Player, idle until played; another kind loads its
// video on a click on it. After FastStream went to the next episode by itself, it starts the
// page's player (content.js startPagePlayer, background.mjs startPagePlayers), takes the
// stream, and its own player plays it, all without a click.
import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {setOptions} from '../live-specs/liveSite.mjs';

const PORT = 41874;
const SITE = `http://127.0.0.1:${PORT}`;
let server;

const next = (to) => `<p><a href="/${to}" style="display: inline-block; width: 120px; height: 24px">Next episode</a></p>`;
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
<div id="box" style="${style}"><video style="${style}"></video></div>
<script>
  document.getElementById('box').addEventListener('click', () => {
    const video = document.querySelector('#box video');
    if (video.src) return;
    video.src = '${file}?ep=3';
    video.play().catch(() => {});
  });
</script>`,
  };
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

  it('starts an idle JW Player and then one that loads on a click, and plays each without a click', async function() {
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
  });
});
