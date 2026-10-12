import {afterEach, describe, expect, it, vi} from 'vitest';

import {installFakeDom} from './fakeCueDom.mjs';
import {hlsPlaylist, loadBackground, response} from './backgroundHarness.mjs';

// MPV mode sends the page's subtitles with its stream, as the in-page player shows them:
// the subtitle files the page asked for and its <track> elements. MPV mode sent the stream
// alone. Its own file: the subtitle parser needs the stand-in DOM, which the other
// background tests do without.

installFakeDom();

const PAGE = 'https://site.test/watch/1';
const EPISODE = 'https://cdn.test/episode/master.m3u8';
const SUB = 'https://cdn.test/subs/episode-en.vtt';
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n';
const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/**
 * A background with MPV mode on for site.test (its allowlist), and the page loaded.
 * @param {Object} [setup] - loadBackground's, over these.
 * @return {Promise<void>}
 */
async function allowlistedPage(setup = {}) {
  bg = await loadBackground({
    options: {mpvMode: true, mpvAllowlist: ['https://site.test/']},
    tabs: [{id: 1, url: PAGE}],
    fetch: (url) => {
      if (url === SUB) return response(VTT);
      if (url === EPISODE) return response(hlsPlaylist(1400));
      return response('', 404);
    },
    ...setup,
  });
  // The parser, which MpvSubtitles imports when first needed, loaded into the fresh module
  // registry (loadBackground resets it): its file is read from disk, which the fake timers'
  // waits (bg.wait) do not wait for.
  await import('../../chrome/player/SubtitleTrack.mjs');
  await bg.navigated(1, PAGE);
  await bg.frameAdded(1, 0, PAGE, 'page');
}

/** @return {Array<Object>} The open messages the host got. */
const opens = () => bg.native.filter((m) => m.type === 'open');

describe('MPV mode and the page\'s subtitles', () => {
  it('sends a subtitle file the page asked for with the stream the allowlist hands to mpv', async () => {
    await allowlistedPage();
    await bg.request({tabId: 1, url: SUB});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(opens()).toHaveLength(1);
    expect(opens()[0]).toMatchObject({url: EPISODE, subtitles: [{label: 'episode-en', srt: SRT}]});
  });

  it('sends the page\'s <track> elements, as content.js reads them', async () => {
    await allowlistedPage({onTabMessage: ({message}) => message.type === 'SCRAPE_CAPTIONS' ?
      [{data: VTT, source: 'https://site.test/subs/de.vtt', label: 'Deutsch', language: 'de'}] : undefined});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(opens()[0]).toMatchObject({url: EPISODE, subtitles: [{label: 'Deutsch', srt: SRT}]});
  });

  it('sends a stream whose page has no subtitles as before', async () => {
    await allowlistedPage();
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(1000);
    expect(opens()).toHaveLength(1);
    expect(opens()[0].url).toBe(EPISODE);
    expect(opens()[0]).not.toHaveProperty('subtitles');
  });

  it('does not wait for a page that never tells its <track> elements', async () => {
    // A page busy with its own scripts: content.js does not answer. The stream goes after
    // CaptionScrapeWaitMs (1 s), with the subtitle file the page asked for.
    await allowlistedPage({onTabMessage: ({message}) => message.type === 'SCRAPE_CAPTIONS' ?
      new Promise(() => {}) : undefined});
    await bg.request({tabId: 1, url: SUB});
    await bg.request({tabId: 1, url: EPISODE});
    await bg.wait(500);
    expect(opens()).toHaveLength(0);
    await bg.wait(1000);
    expect(opens()[0]).toMatchObject({url: EPISODE, subtitles: [{label: 'episode-en', srt: SRT}]});
  });

  it('leaves the player\'s button its own choice: the tracks it shows, none included', async () => {
    await allowlistedPage({options: {mpvMode: false}});
    await bg.request({tabId: 1, url: SUB});
    const fetched = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      fetched.push(String(url));
      return realFetch(url, init);
    };
    await bg.message({type: 'MPV_OPEN', url: EPISODE, headers: [], subtitles: undefined}, {tabId: 1});
    expect(opens()).toHaveLength(1);
    expect(opens()[0]).not.toHaveProperty('subtitles');
    expect(fetched).not.toContain(SUB);
  });
});
