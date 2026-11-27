// What the live specs share: the public streams and the checks of FastStream's player in a page. The
// libraries their sites use are npm releases (../npmPackages.mjs).

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';
import {inExtensionPage} from '../extension-page.mjs';

export const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

const SHAKA = 'https://storage.googleapis.com/shaka-demo-assets';
/** Public test streams: long-lived and CORS-enabled. */
export const STREAMS = {
  // 60 s, 5 H.264 levels, 6 audio renditions in 5 languages, 4 WebVTT subtitle renditions.
  hls: `${SHAKA}/angel-one-hls/hls.m3u8`,
  // The same title as DASH (SegmentBase, on-demand profile).
  dash: `${SHAKA}/angel-one/dash.mpd`,
  // 888 s, for a seek far into a long title.
  dashLong: `${SHAKA}/sintel/dash.mpd`,
  // A live stream: type="dynamic", a SegmentTimeline that grows every 4 s.
  dashLive: 'https://storage.googleapis.com/shaka-live-assets/player-source.mpd',
  // Progressive MP4 served as application/octet-stream, as file hosts often do.
  mp4: 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4',
};

/**
 * Saves options the way the options page does, and has the background reload them.
 * @param {Object} options - The options to save; everything else takes its default.
 */
export async function setOptions(options) {
  await inExtensionPage((options, done) => {
    chrome.storage.local.set({options: JSON.stringify(options)}, () => {
      chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
        void chrome.runtime.lastError;
        setTimeout(() => done(true), 500);
      });
    });
  }, options);
}

/**
 * What the page's own videos are doing, for a failure message: open shadow roots and
 * same-origin frames included.
 * @return {Promise<Array<Object>>}
 */
export const pageVideos = () => browser.execute(() => {
  const out = [];
  const walk = (node, where) => {
    for (const video of node.querySelectorAll('video')) {
      out.push({where, src: (video.currentSrc || video.src || '').slice(0, 80), readyState: video.readyState,
        paused: video.paused, width: video.videoWidth, size: `${video.clientWidth}x${video.clientHeight}`});
    }
    for (const element of node.querySelectorAll('*')) {
      if (element.shadowRoot) walk(element.shadowRoot, `${where} > ${element.localName}::shadow`);
    }
  };
  walk(document, 'page');
  return out;
});

/**
 * Waits for FastStream's player to replace the page's video, then switches into it,
 * through the site's own iframe when the video is in one.
 * @param {number} timeout - How long to wait, in ms.
 */
export async function enterPlayer(timeout = 60000) {
  const selector = 'iframe[src*="player/index.html"]';
  await browser.switchFrame(null);
  let nested = false;
  try {
    await browser.waitUntil(async () => {
      await browser.switchFrame(null);
      if (await browser.$(selector).isExisting()) {
        nested = false;
        return true;
      }
      for (const frame of await browser.$$('iframe')) {
        await browser.switchFrame(null);
        await browser.switchFrame(frame);
        if (await browser.$(selector).isExisting()) {
          nested = true;
          return true;
        }
      }
      return false;
    }, {timeout, interval: 500});
  } catch (e) {
    await browser.switchFrame(null);
    throw new Error(`FastStream never replaced the page's player; the page's videos: ${JSON.stringify(await pageVideos())}`);
  }
  if (!nested) {
    await browser.switchFrame(null);
  }
  await browser.switchFrame(await browser.$(selector));
}

/**
 * Reads the player's state.
 * @return {Promise<Object>} The state.
 */
export const playerState = () => browser.execute(() => {
  const client = window.fastStream;
  const video = client?.player?.getVideo?.();
  // What the player was given and what it shows, for a failure message.
  const context = {
    sources: (client?.sourcesBrowser?.sources || []).filter((source) => source.url)
        .map((source) => `${source.mode} ${source.url}`),
    status: Array.from(document.querySelectorAll('.mainplayer .status_message'))
        .map((element) => element.textContent.trim()).filter(Boolean),
  };
  if (!video) {
    return {loaded: false, source: client?.source ? `${client.source.mode} ${client.source.url}` : null, ...context};
  }
  const toRanges = (list) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      out.push([+list.start(i).toFixed(2), +list.end(i).toFixed(2)]);
    }
    return out;
  };
  const ranges = toRanges(video.buffered);
  const levels = client.getVideoLevels();
  const playing = levels.get(client.getCurrentVideoLevelID());
  return {
    loaded: true,
    mode: client.source?.mode,
    url: client.source?.url,
    time: client.currentTime,
    // The element's own position and window: a live stream left at 0, outside its window,
    // while its buffer filled at the live edge.
    videoTime: +video.currentTime.toFixed(2),
    seekable: toRanges(video.seekable),
    duration: client.duration,
    paused: video.paused,
    seeking: video.seeking,
    readyState: video.readyState,
    width: video.videoWidth,
    ranges,
    playingLevel: playing ? `${playing.width}x${playing.height} ${playing.videoCodec}` : null,
    videoLevels: Array.from(levels.values()).map((level) => `${level.width}x${level.height} ${level.videoCodec}`),
    audioLanguages: Array.from(client.getAudioLevels().values()).map((level) => level.language),
    error: video.error ? video.error.message || String(video.error.code) : null,
    ...context,
  };
});

/**
 * Waits until the player has data to play at its position, and returns its state.
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state.
 */
export async function waitPlayable(what) {
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await playerState();
      return last.loaded && !last.seeking && last.readyState >= 3 && last.width > 0;
    }, {timeout: 60000, interval: 500});
  } catch (e) {
    throw new Error(`${what} never became playable: ${JSON.stringify(last)}`);
  }
  return last;
}

/**
 * Plays until the position has advanced by `seconds`, and pauses.
 * @param {number} seconds - How far.
 * @param {string} what - For the error message.
 * @return {Promise<Object>} The state at the end.
 */
export async function playFor(seconds, what) {
  const start = (await playerState()).time;
  await browser.execute(() => {
    window.fastStream.play().catch((e) => {
      window.__playError = String(e);
    });
  });
  let last;
  try {
    await browser.waitUntil(async () => {
      last = await playerState();
      return last.time >= start + seconds;
    }, {timeout: 30000 + seconds * 3000, interval: 500});
  } catch (e) {
    const playError = await browser.execute(() => window.__playError || null);
    throw new Error(`${what}: playback did not advance ${seconds} s from ${start}: ` +
      JSON.stringify({...last, playError}));
  } finally {
    await browser.execute(() => {
      window.fastStream.pause();
    });
  }
  return last;
}

/**
 * Seeks, waits for the new position to play, and plays on from it.
 * @param {number} target - Where to, in seconds.
 * @param {string} what - For the error message.
 */
export async function seekAndPlay(target, what) {
  await browser.execute((target) => {
    window.fastStream.currentTime = target;
  }, target);
  const state = await waitPlayable(`${what} after a seek to ${target} s`);
  expect(Math.abs(state.time - target)).toBeLessThan(2);
  await playFor(2, `${what} after a seek to ${target} s`);
}
