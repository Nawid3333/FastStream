// The player's OpenSubtitles search: the order its answers come in, a failed search, Enter
// in its fields, its pages, and its downloads.
//
// Each case opens the web player with no source and the search on it. Its requests to
// opensubtitles.com are stubbed in the page, and nothing goes out: each one waits in
// window.__requests until the case answers it. A search asks twice at once - a text search
// for subtitles and a title search - then for the subtitles of the title it took
// (subtitle-search-titles.e2e.mjs tests which title, with the API's real answers).
import fs from 'node:fs';
import {browser, expect} from '@wdio/globals';

const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));

// A download link as the API gives them; the player fetches no link on another host.
const DOWNLOAD_LINK = 'https://www.opensubtitles.com/download/0123456789ABCDEF/subfile/sub.vtt';

/**
 * An answer of the subtitles API with one result: a subtitle of the film of that title.
 * @param {string} title - The film's title.
 * @param {number} [pages] - How many pages of results there are.
 * @return {Object}
 */
function answer(title, pages = 1) {
  return {response: {page: 1, total_pages: pages, data: [{attributes: {
    language: 'en', download_count: 5, url: 'https://www.opensubtitles.com/en/subtitles/x',
    feature_details: {movie_name: title, title, year: 2000, feature_type: 'Movie', imdb_id: 1000 + title.length},
    uploader: {name: 'someone'}, files: [{file_id: 1}],
  }}]}};
}

const NOTHING = {response: {page: 1, total_pages: 0, data: []}};

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
 * Starts a search for a text, as the search button does: requests n and n + 1.
 * @param {string} text - What to search for.
 * @return {Promise<void>}
 */
async function search(text) {
  await browser.execute((text) => {
    const search = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch;
    search.subui.search.value = text;
    search.subui.languageInput.value = '';
    search.startSearch();
  }, text);
}

/**
 * Waits for a request, by its number.
 * @param {number} index
 * @return {Promise<void>}
 */
async function asked(index) {
  await browser.waitUntil(async () => browser.execute((index) => window.__requests.length > index, index),
      {timeout: 10000, timeoutMsg: `request ${index} was never made`});
}

/**
 * Answers a search's two requests, and then the subtitles of the title it took.
 * @param {number} first - The number of the search's first request.
 * @param {Object} subtitles - The answer for the text search and the title's subtitles.
 * @param {Object} [list] - The title's subtitles, when other than the text search's.
 * @return {Promise<void>}
 */
async function answerSearch(first, subtitles, list = subtitles) {
  await asked(first + 1);
  await browser.execute((first, subtitles, nothing) => {
    window.__requests[first].resolve(subtitles);
    window.__requests[first + 1].resolve(nothing);
  }, first, subtitles, NOTHING);
  await asked(first + 2);
  await browser.execute((index, list) => window.__requests[index].resolve(list), first + 2, list);
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
    await answerSearch(2, answer('New'));
    await browser.execute((answer, nothing) => {
      window.__requests[0].resolve(answer);
      window.__requests[1].resolve(nothing);
    }, answer('Old'), NOTHING);
    const state = await shown();
    console.log('      results:', JSON.stringify(state));
    expect(state.titles).toEqual(['New']);
    // The old search, answered late, asked for nothing more.
    expect(state.requests).toBe(5);
    // Nor does an earlier search's failure, coming after: it cleared the newer one's pages.
    await search('failing');
    await search('newest');
    await answerSearch(7, answer('Newest', 3));
    await browser.execute(() => {
      window.__requests[5].reject(new Error('offline'));
      window.__requests[6].reject(new Error('offline'));
    });
    const after = await shown();
    expect(after.titles).toEqual(['Newest']);
    expect(after.pages).toBeGreaterThan(0);
  });

  it('says the search is off in the web player when it fails, without the last search\'s pages', async function() {
    // `chrome` is not declared in the web build, so chrome?.extension threw and
    // "Searching..." stayed; and the pages of the search before stayed on, searching
    // again for its query when clicked.
    await openSearch();
    await search('first');
    await answerSearch(0, answer('First', 3));
    const before = await shown();
    expect(before.pages).toBeGreaterThan(0);
    await search('second');
    await asked(4);
    await browser.execute(() => {
      window.__requests[3].reject(new Error('offline'));
      window.__requests[4].reject(new Error('offline'));
    });
    const state = await shown();
    console.log('      after a failed search:', JSON.stringify(state));
    expect(state.message).toBe(en.player_opensubtitles_disabled.message);
    expect(state.pages).toBe(0);
    // The same when the API answers with an error.
    await search('third');
    await answerSearch(5, answer('Third', 3));
    expect((await shown()).pages).toBeGreaterThan(0);
    await search('fourth');
    await asked(9);
    await browser.execute(() => {
      window.__requests[8].resolve({response: {errors: ['Bad query']}});
      window.__requests[9].resolve({response: {errors: ['Bad query']}});
    });
    const refused = await shown();
    expect(refused.message).toBe(en.player_opensubtitles_error.message.replace('$1', 'Bad query'));
    expect(refused.pages).toBe(0);
  });

  it('searches once when Enter is pressed in one of its fields', async function() {
    // Enter in a field searches, once.
    await openSearch();
    const requests = await browser.execute(() => {
      const {subui} = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch;
      subui.search.value = 'film';
      subui.yearInput.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true, cancelable: true}));
      return window.__requests.map((request) => request.options.url.split('/').pop());
    });
    expect(requests).toEqual(['subtitles', 'features']);
  });

  it('says why when a search answers with no results list', async function() {
    // OpenSubtitles' "Throttle limit reached" and bad-key answers have a message and no
    // data: reading data threw with the results already cleared, and the pane stayed blank.
    await openSearch();
    await search('throttled');
    await asked(1);
    await browser.execute(() => {
      window.__requests[0].resolve({response: {message: 'Throttle limit reached'}});
      window.__requests[1].resolve({response: {message: 'Throttle limit reached'}});
    });
    const state = await shown();
    expect(state.message).toBe(en.player_opensubtitles_error.message.replace('$1', 'Throttle limit reached'));
    expect(state.pages).toBe(0);
    await search('nothing');
    await asked(3);
    await browser.execute(() => {
      window.__requests[2].resolve({response: {}});
      window.__requests[3].resolve({response: {}});
    });
    expect((await shown()).message).toBe(en.player_opensubtitles_error_down.message);
  });

  it('lists the other results when one has no file, uploader or title', async function() {
    await openSearch();
    await search('good');
    const good = answer('Good');
    await answerSearch(0, good, {response: {page: 1, total_pages: 1, data: [
      {attributes: {language: 'en'}},
      {attributes: {language: 'en', files: [{file_id: 2}]}},
      good.response.data[0],
    ]}});
    const state = await shown();
    // The one without a file is left out; the one without release or title is listed.
    expect(state.titles).toEqual(['', 'Good']);
  });

  it('loads the page clicked while another page is loading', async function() {
    // The bar shown while a page loads loaded that page again, whichever page was clicked.
    await openSearch();
    await search('film');
    await answerSearch(0, answer('Film', 5));
    await shown();
    const clickPage = (page) => browser.execute((page) => {
      const pages = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.pages;
      const marker = Array.from(pages.querySelectorAll('.page-marker')).find((el) => el.textContent === String(page));
      marker.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    }, page);
    await clickPage(2);
    await clickPage(4);
    // The film's pages: by its IMDb id.
    const pagesAsked = await browser.execute(() => window.__requests.filter((r) => r.options.query.imdb_id)
        .map((r) => r.options.query.page || '1'));
    expect(pagesAsked).toEqual(['1', '2', '4']);
  });

  /**
   * Clicks the first result, answers its download link request, and leaves the
   * subtitle file's request (number 4) waiting.
   * @return {Promise<void>}
   */
  async function startDownload() {
    await search('film');
    await answerSearch(0, answer('Film'));
    await shown();
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.results
          .querySelector('.subtitle-result-container').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    await browser.waitUntil(async () => browser.execute(() => window.__requests.length === 4),
        {timeout: 15000, timeoutMsg: 'choosing a result asked for no download link'});
    await browser.execute((link) => window.__requests[3].resolve({response: {link}}), DOWNLOAD_LINK);
    await browser.waitUntil(async () => browser.execute(() => window.__requests.length === 5),
        {timeout: 15000, timeoutMsg: 'the subtitle file was never fetched from its link'});
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
  const answerFile = (text) => browser.execute((text) => window.__requests[4].resolve({
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
    await answerSearch(0, answer('Film'));
    await shown();
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.results
          .querySelector('.subtitle-result-container').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    });
    await browser.waitUntil(async () => browser.execute(() => window.__requests.length === 4),
        {timeout: 10000, timeoutMsg: 'the picked subtitle was never asked for'});
    // Closed first, so the failure shows no alert to wait on.
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.closeUI();
      window.__requests[3].resolve({response: {link: 'https://dl.example/sub.vtt'}});
    });
    const state = await shown();
    expect(state.requests).toBe(4);
    expect(await trackLabels()).toEqual([]);
  });

  it('downloads a result again after its download failed while the search was closed', async function() {
    // A failed download with the search closed returned before it cleared the result's
    // "downloading" mark, and the result ignored every click after.
    await openSearch();
    await search('film');
    await answerSearch(0, answer('Film'));
    await shown();
    const click = () => browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.subui.results
          .querySelector('.subtitle-result-container').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    });
    await click();
    await asked(3);
    await browser.execute(() => {
      window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.closeUI();
      window.__requests[3].reject(new Error('offline'));
    });
    await shown();
    await browser.execute(() => window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch.openUI());
    await click();
    const state = await shown();
    console.log('      requests:', state.requests);
    expect(state.requests).toBe(5);
  });
});
