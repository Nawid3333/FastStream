// The player's OpenSubtitles search: the order its answers come in, a failed search, Enter
// on its dropdowns, and a failed download while the search was closed.
//
// Each case opens the web player with no source and the search on it. Its requests to
// opensubtitles.com are stubbed in the page, and nothing goes out: each one waits in
// window.__requests until the case answers it.
import fs from 'node:fs';
import {browser, expect} from '@wdio/globals';

const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));

// A download link as the API gives them; the player fetches no link on another host.
const DOWNLOAD_LINK = 'https://www.opensubtitles.com/download/0123456789ABCDEF/subfile/sub.vtt';

/**
 * An answer of the search API with one result.
 * @param {string} title - The result's title.
 * @param {number} [pages] - How many pages of results there are.
 * @return {Object}
 */
function answer(title, pages = 1) {
  return {response: {page: 1, total_pages: pages, data: [{attributes: {
    language: 'en', ratings: 5, url: 'https://www.opensubtitles.com/en/subtitles/x',
    feature_details: {movie_name: title, year: 2000}, uploader: {name: 'someone'}, files: [{file_id: 1}],
  }}]}};
}

/**
 * Opens the player with no source and the search on it, its requests stubbed.
 * @return {Promise<void>}
 */
async function openSearch() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  const error = await browser.executeAsync((done) => {
    import('/player/utils/RequestUtils.mjs').then(({RequestUtils}) => {
      window.__requests = [];
      RequestUtils.request = (options) => new Promise((resolve, reject) => {
        window.__requests.push({options, resolve, reject});
      });
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.openUI();
      done(null);
    }).catch((e) => done(String(e)));
  });
  expect(error).toBe(null);
}

/**
 * Starts a search for a text, as the search button does.
 * @param {string} text - What to search for.
 * @return {Promise<void>}
 */
async function search(text) {
  await browser.execute((text) => {
    window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.queryOpenSubtitles({
      query: text, type: 'all', season: '', episode: '', language: '', year: '',
      sortBy: 'download_count', sortDirection: 'desc', page: 1,
    });
  }, text);
}

/**
 * What the search shows once the page has dealt with its answers.
 * @return {Promise<{titles: string[], message: string, pages: number, requests: number}>}
 */
async function shown() {
  return browser.executeAsync((done) => setTimeout(() => {
    const subui = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui;
    done({
      titles: Array.from(subui.results.querySelectorAll('.subtitle-result-title'), (el) => el.textContent),
      message: subui.results.textContent,
      pages: subui.pages.children.length,
      requests: window.__requests.length,
    });
  }, 100));
}

describe('Subtitle search', function() {
  it('shows the newest search\'s results when an earlier search answers after it', async function() {
    // Each answer replaced the results, so a slow first search put its results over the
    // second one's.
    await openSearch();
    await search('old');
    await search('new');
    await browser.execute((answer) => window.__requests[1].resolve(answer), answer('New'));
    await browser.execute((answer) => window.__requests[0].resolve(answer), answer('Old'));
    const state = await shown();
    console.log('      results:', JSON.stringify(state));
    expect(state.titles).toEqual(['New (2000)']);
    // Nor does an earlier search's failure, coming after: it cleared the newer one's pages.
    await search('failing');
    await search('newest');
    await browser.execute((answer) => window.__requests[3].resolve(answer), answer('Newest', 3));
    await browser.execute(() => window.__requests[2].reject(new Error('offline')));
    const after = await shown();
    expect(after.titles).toEqual(['Newest (2000)']);
    expect(after.pages).toBeGreaterThan(0);
  });

  it('says the search is off in the web player when it fails, without the last search\'s pages', async function() {
    // `chrome` is not declared in the web build, so chrome?.extension threw and
    // "Searching..." stayed; and the pages of the search before stayed on, searching
    // again for its query when clicked.
    await openSearch();
    await search('first');
    await browser.execute((answer) => window.__requests[0].resolve(answer), answer('First', 3));
    const before = await shown();
    expect(before.pages).toBeGreaterThan(0);
    await search('second');
    await browser.execute(() => window.__requests[1].reject(new Error('offline')));
    const state = await shown();
    console.log('      after a failed search:', JSON.stringify(state));
    expect(state.message).toBe(en.player_opensubtitles_disabled.message);
    expect(state.pages).toBe(0);
    // The same when the API answers with an error.
    await search('third');
    await browser.execute((answer) => window.__requests[2].resolve(answer), answer('Third', 3));
    expect((await shown()).pages).toBeGreaterThan(0);
    await search('fourth');
    await browser.execute(() => window.__requests[3].resolve({response: {errors: ['Bad query']}}));
    const refused = await shown();
    expect(refused.message).toBe(en.player_opensubtitles_error.message.replace('$1', 'Bad query'));
    expect(refused.pages).toBe(0);
  });

  it('searches with the type shown when Enter is pressed on the type filter', async function() {
    // A guard, which passes on main too: Enter on a dropdown searches, and the dropdown's
    // own Enter (the next choice) must not run as well. The search's handler is a capture
    // listener on the dropdown itself, and its stopPropagation() also skips the dropdown's
    // listener there (measured, Firefox 156).
    await openSearch();
    const state = await browser.execute(() => {
      const selector = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.typeSelector;
      selector.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
      return {type: selector.dataset.val, requests: window.__requests.length};
    });
    expect(state).toEqual({type: 'all', requests: 1});
  });

  it('says why when a search answers with no results list', async function() {
    // OpenSubtitles' "Throttle limit reached" and bad-key answers have a message and no
    // data: reading data threw with the results already cleared, and the pane stayed blank.
    await openSearch();
    await search('throttled');
    await browser.execute(() => window.__requests[0].resolve({response: {message: 'Throttle limit reached'}}));
    const state = await shown();
    expect(state.message).toBe(en.player_opensubtitles_error.message.replace('$1', 'Throttle limit reached'));
    expect(state.pages).toBe(0);
    await search('nothing');
    await browser.execute(() => window.__requests[1].resolve({response: {}}));
    expect((await shown()).message).toBe(en.player_opensubtitles_error_down.message);
  });

  it('lists the other results when one has no file, uploader or title', async function() {
    await openSearch();
    await search('film');
    await browser.execute((good) => window.__requests[0].resolve({response: {page: 1, total_pages: 1, data: [
      {attributes: {language: 'en'}},
      {attributes: {language: 'en', files: [{file_id: 2}]}},
      good.response.data[0],
    ]}}), answer('Good'));
    const state = await shown();
    // The one without a file is left out; the one without uploader or title is listed.
    expect(state.titles).toEqual(['', 'Good (2000)']);
  });

  it('loads the page clicked while another page is loading', async function() {
    // The bar shown while a page loads loaded that page again, whichever page was clicked.
    await openSearch();
    await search('film');
    await browser.execute((answer) => window.__requests[0].resolve(answer), answer('Film', 5));
    await shown();
    const clickPage = (page) => browser.execute((page) => {
      const pages = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.pages;
      const marker = Array.from(pages.querySelectorAll('.page-marker')).find((el) => el.textContent === String(page));
      marker.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    }, page);
    await clickPage(2);
    await clickPage(4);
    const pagesAsked = await browser.execute(() => window.__requests.map((r) => r.options.query.page || '1'));
    expect(pagesAsked).toEqual(['1', '2', '4']);
  });

  /**
   * Clicks the first result, answers its download link request, and leaves the
   * subtitle file's request waiting.
   * @return {Promise<void>}
   */
  async function startDownload() {
    await search('film');
    await browser.execute((answer) => window.__requests[0].resolve(answer), answer('Film'));
    await shown();
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.results
          .querySelector('.subtitle-result-container').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    await browser.waitUntil(async () => browser.execute(() => window.__requests.length === 2));
    await browser.execute((link) => window.__requests[1].resolve({response: {link}}), DOWNLOAD_LINK);
    await browser.waitUntil(async () => browser.execute(() => window.__requests.length === 3));
  }

  const trackLabels = () => browser.execute(() =>
    window.fastStream.interfaceController.subtitlesManager.tracks.map((track) => track.label));

  const VTT_FILE = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n';
  const SIGN_IN_PAGE = '<!doctype html><title>Sign in</title><p>Please sign in</p>';

  /**
   * Answers the subtitle file's request, with its bytes as the player asks for them.
   * @param {string} text - The file.
   * @return {Promise<void>}
   */
  const answerFile = (text) => browser.execute((text) => window.__requests[2].resolve({
    status: 200, response: new TextEncoder().encode(text).buffer, getResponseHeader: () => null,
  }), text);

  it('drops a download that finishes after the subtitles were cleared for another video', async function() {
    // It was added to the new video, and turned on.
    await openSearch();
    await startDownload();
    await browser.execute(() => window.fastStream.interfaceController.subtitlesManager.clearTracks());
    await answerFile(VTT_FILE);
    await shown();
    expect(await trackLabels()).toEqual([]);

    // The same download, the subtitles left as they were: added.
    await openSearch();
    await startDownload();
    await answerFile(VTT_FILE);
    await shown();
    expect(await trackLabels()).toEqual(['someone - Film']);
  });

  it('adds no empty track when the download is no subtitle file', async function() {
    // A web page in place of the file (a login, an error) became a track with no cues.
    await openSearch();
    await startDownload();
    await answerFile(SIGN_IN_PAGE);
    await shown();
    expect(await trackLabels()).toEqual([]);
  });

  it('does not fetch a download link that is not on OpenSubtitles', async function() {
    // The link in the API's answer was fetched with the extension's host permissions,
    // whatever its scheme or host (#189).
    await openSearch();
    await search('film');
    await browser.execute((answer) => window.__requests[0].resolve(answer), answer('Film'));
    await shown();
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.results
          .querySelector('.subtitle-result-container').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    await browser.waitUntil(async () => browser.execute(() => window.__requests.length === 2));
    // Closed first, so the failure shows no alert to wait on.
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.closeUI();
      window.__requests[1].resolve({response: {link: 'https://dl.example/sub.vtt'}});
    });
    const state = await shown();
    expect(state.requests).toBe(2);
    expect(await trackLabels()).toEqual([]);
  });

  it('downloads a result again after its download failed while the search was closed', async function() {
    // A failed download with the search closed returned before it cleared the result's
    // "downloading" mark, and the result ignored every click after.
    await openSearch();
    await search('film');
    await browser.execute((answer) => window.__requests[0].resolve(answer), answer('Film'));
    const click = () => browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.results
          .querySelector('.subtitle-result-container').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    });
    await click();
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.closeUI();
      window.__requests[1].reject(new Error('offline'));
    });
    await shown();
    await browser.execute(() => window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.openUI());
    await click();
    const state = await shown();
    console.log('      requests:', state.requests);
    expect(state.requests).toBe(3);
  });
});
