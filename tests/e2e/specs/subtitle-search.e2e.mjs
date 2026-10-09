// The subtitle search (OpenSubtitlesSearch) in the player, against the OpenSubtitles API's own
// answers (tests/unit/fixtures/opensubtitles, recorded 2026-10-09): the page's requests are
// answered from them, so this runs without the network and the API's key.
//
// A search finds the title first - a text search for subtitles and a title search side by side,
// pooled and scored (SubtitleSearchTitles) - then lists that title's subtitles by its id, the
// most downloaded first, each by its release name. Before, the text search's results were the
// list: for "Oppenheimer" in German a 2025 documentary came first, and the film's most
// downloaded subtitle was not among the first 8.

import fs from 'node:fs';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

const FIXTURES = path.resolve(import.meta.dirname, '../../unit/fixtures/opensubtitles');
const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));

// What the API answers, by request: 'subtitles:<query>', 'features:<query>[:<type>]',
// 'imdb:<id>:<languages>', 'show:<id>:<languages>'. Anything else: nothing found.
const ANSWERS = {
  'subtitles:oppenheimer': read('oppenheimer-de'),
  'features:oppenheimer': read('features-oppenheimer'),
  'imdb:15398776:de': read('oppenheimer-imdb-de'),
  'imdb:15398776:': read('oppenheimer-imdb-de'),
  'subtitles:the bear': read('the-bear-s2e3-en'),
  'features:the bear:tvshow': read('features-the-bear-tvshow'),
  'show:1385125:en': read('the-bear-show-s2e3-en'),
};

/** Opens the player, its requests answered from ANSWERS and recorded in window.__requests. */
async function openPlayer() {
  await browser.url('/player/index.html?t=' + Date.now());
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.interfaceController?.subtitlesManager),
      {timeout: 15000, timeoutMsg: 'the player never appeared'});
  await browser.executeAsync((answers, done) => {
    import('/player/utils/RequestUtils.mjs').then(({RequestUtils}) => {
      window.__requests = [];
      RequestUtils.request = async (options) => {
        const where = options.url.replace('https://api.opensubtitles.com/api/v1/', '');
        const query = options.query || {};
        window.__requests.push({where, query});
        let key;
        if (where === 'features') key = `features:${query.query.toLowerCase()}${query.type ? ':' + query.type : ''}`;
        else if (query.query) key = `subtitles:${query.query.toLowerCase()}`;
        else if (query.imdb_id) key = `imdb:${query.imdb_id}:${query.languages || ''}`;
        else if (query.parent_feature_id) key = `show:${query.parent_feature_id}:${query.languages || ''}`;
        return {status: 200, response: answers[key] || {data: [], total_pages: 0, page: 1}};
      };
      done();
    });
  }, ANSWERS);
}

/**
 * Fills the search in, searches, and waits for its results.
 * @param {Object} fields - query, language, year, season, episode.
 * @return {Promise<Object>} What the panel shows, and the requests made.
 */
async function search(fields) {
  await browser.execute((fields) => {
    const {subui, startSearch} = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch;
    subui.search.value = fields.query;
    subui.languageInput.value = fields.language || '';
    subui.yearInput.value = fields.year || '';
    subui.seasonInput.value = fields.season || '';
    subui.episodeInput.value = fields.episode || '';
    window.__requests = [];
    startSearch.call(window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch);
  }, fields);
  return shown();
}

/**
 * What the panel shows once its search settled.
 * @return {Promise<Object>}
 */
async function shown() {
  let state;
  await browser.waitUntil(async () => {
    state = await browser.execute(() => {
      const {subui} = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch;
      return {
        title: subui.title.querySelector('.subtitle-search-title-name')?.textContent ?? null,
        others: [...subui.title.querySelectorAll('.subtitle-other-title')].map((button) => button.textContent),
        releases: [...subui.results.querySelectorAll('.subtitle-result-title')].map((row) => row.textContent),
        meta: subui.results.querySelector('.subtitle-result-meta')?.textContent ?? null,
        message: subui.results.querySelector('.subtitle-search-message')?.textContent ?? null,
        searching: subui.results.textContent.includes('...') || subui.results.textContent === '',
        requests: window.__requests,
      };
    });
    return !state.searching && (state.releases.length > 0 || state.message);
  }, {timeout: 10000, timeoutMsg: 'the search never settled'});
  return state;
}

describe('Subtitle search', function() {
  it('finds the film, and lists its subtitles by release, the most downloaded first', async function() {
    await openPlayer();
    const state = await search({query: 'Oppenheimer', language: 'de', year: 2023});
    console.log('      oppenheimer:', JSON.stringify({...state, requests: state.requests.length}));
    expect(state.title).toBe('Oppenheimer (2023)');
    expect(state.releases[0]).toBe('Oppenheimer.2023.German.DL.1080p.BluRay.x264.RERiP-DETAiLS');
    expect(state.releases).toHaveLength(7);
    expect(state.meta.split(' ')[0].replace(/[^0-9]/g, '')).toBe('6911');
    // The text search and the title search, then the film's subtitles by its IMDb id.
    expect(state.requests.map((request) => request.where)).toEqual(['subtitles', 'features', 'subtitles']);
    expect(state.requests[0].query).toMatchObject({query: 'Oppenheimer', languages: 'de', year: '2023'});
    expect(state.requests[2].query).toEqual({imdb_id: '15398776', languages: 'de', order_by: 'download_count'});
    // Another title of that name, one click away.
    expect(state.others).toContain('Oppenheimer (1980)');
  });

  it('switches to another title found', async function() {
    await openPlayer();
    await search({query: 'Oppenheimer', language: 'de'});
    await browser.execute(() => {
      window.__requests = [];
      [...document.querySelectorAll('.subtitle-other-title')].find((button) => button.textContent === 'Oppenheimer (1980)').click();
    });
    const state = await shown();
    expect(state.title).toBe('Oppenheimer (1980)');
    expect(state.others).toContain('Oppenheimer (2023)');
    expect(state.requests.map((request) => request.query)).toEqual([
      {parent_feature_id: '1495976', languages: 'de', order_by: 'download_count'},
      {parent_feature_id: '1495976', order_by: 'download_count'},
    ]);
  });

  it('finds the show of an episode, not another with "bear" in its name', async function() {
    await openPlayer();
    const state = await search({query: 'The Bear', language: 'en', season: 2, episode: 3});
    console.log('      the bear:', JSON.stringify({...state, requests: state.requests.length}));
    expect(state.title).toBe('The Bear (2022) - S02E03');
    expect(state.releases[0]).toBe('The.Bear.S02E03.720p.WEB.h264-EDITH');
    expect(state.requests[0].query).toMatchObject({query: 'The Bear', languages: 'en', type: 'episode', season_number: '2', episode_number: '3'});
    expect(state.requests[1]).toEqual({where: 'features', query: {query: 'The Bear', type: 'tvshow'}});
    expect(state.requests[2].query).toEqual({parent_feature_id: '1385125', season_number: '2', episode_number: '3', languages: 'en',
      order_by: 'download_count'});
    expect(state.others.join(' ')).not.toMatch(/masha/i);
  });

  it('shows every language, and says so, when the title has none in the one asked for', async function() {
    await openPlayer();
    const state = await search({query: 'Oppenheimer', language: 'fr', year: 2023});
    expect(state.title).toBe('Oppenheimer (2023)');
    expect(state.message).toContain('fr');
    expect(state.releases.length).toBeGreaterThan(0);
    expect(state.requests.slice(2).map((request) => request.query)).toEqual([
      {imdb_id: '15398776', languages: 'fr', order_by: 'download_count'},
      {imdb_id: '15398776', order_by: 'download_count'},
    ]);
  });

  it('fills the search in from what the tab\'s title told', async function() {
    await openPlayer();
    const fields = await browser.execute(() => {
      const search = window.fastStream.interfaceController.subtitlesManager.openSubtitlesSearch;
      search.setMediaInfo({name: 'The Bear', year: null, season: 2, episode: 3});
      const {subui} = search;
      return [subui.search.value, subui.yearInput.value, subui.seasonInput.value, subui.episodeInput.value];
    });
    expect(fields).toEqual(['The Bear', '', '2', '3']);
  });
});
