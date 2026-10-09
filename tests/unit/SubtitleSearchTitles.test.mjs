import fs from 'node:fs';

import {describe, expect, it} from 'vitest';

import {chooseTitles, describeSubtitle, nameMatch, normalizeTitle, poolTitles, rankTitles, titleQuery, titlesFromFeatures,
  titlesFromSubtitles} from '../../chrome/player/ui/subtitles/SubtitleSearchTitles.mjs';

// Which title a subtitle search means. The fixtures are the OpenSubtitles API's own answers
// (2026-10-09), trimmed to the fields read: a text search for subtitles (GET /subtitles?query=)
// and a title search (GET /features?query=). Either alone picked the wrong title in some of these.

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`fixtures/opensubtitles/${name}.json`, import.meta.url), 'utf8')).data;

/**
 * The title the search would take.
 * @param {string} subtitles - The text search's fixture.
 * @param {string} features - The title search's fixture.
 * @param {Object} wanted
 * @param {string} [language]
 * @return {Object}
 */
function pick(subtitles, features, wanted, language = '') {
  const pooled = poolTitles(titlesFromSubtitles(fixture(subtitles)), titlesFromFeatures(fixture(features), language));
  return rankTitles(pooled, wanted)[0];
}

describe('the title a subtitle search means', () => {
  it('takes Oppenheimer (2023), not the 2025 documentary the text search listed first', () => {
    expect(fixture('oppenheimer-de')[0].attributes.feature_details.title).not.toBe('Oppenheimer');
    for (const wanted of [{name: 'Oppenheimer', year: 2023}, {name: 'Oppenheimer'}]) {
      expect(pick('oppenheimer-de', 'features-oppenheimer', wanted, 'de')).toMatchObject({kind: 'movie', imdbId: 15398776, year: 2023});
    }
  });

  it('takes Titanic (1997), which the text search did not list in its first 50', () => {
    expect(fixture('titanic-en').some((item) => item.attributes.feature_details.imdb_id === 120338)).toBe(false);
    for (const wanted of [{name: 'Titanic'}, {name: 'Titanic', year: 1997}]) {
      expect(pick('titanic-en', 'features-titanic', wanted, 'en')).toMatchObject({kind: 'movie', imdbId: 120338, year: 1997});
    }
  });

  it('takes the show The Bear for its episode, not Masha and the Bear', () => {
    const show = pick('the-bear-s2e3-en', 'features-the-bear-tvshow', {name: 'The Bear', season: 2, episode: 3}, 'en');
    expect(show).toMatchObject({kind: 'show', showId: 1385125, title: expect.stringMatching(/^the bear$/i)});
    // The show the text search found under its episodes is the one the title search found.
    expect(titlesFromSubtitles(fixture('the-bear-s2e3-en'))[0]).toMatchObject({kind: 'show', showId: 1385125});
  });

  it('takes Dune: Part Two, which only the text search found', () => {
    expect(titlesFromFeatures(fixture('features-dune-part-two')).some((title) => title.year === 2024 && title.kind === 'movie')).toBe(false);
    for (const wanted of [{name: 'Dune Part Two', year: 2024}, {name: 'Dune: Part Two'}]) {
      expect(pick('dune-part-two-de', 'features-dune-part-two', wanted, 'de')).toMatchObject({kind: 'movie', year: 2024,
        title: expect.stringMatching(/^dune: part two$/i)});
    }
  });

  it('takes 1917 (2019) by its subtitles, of two films of that name, when the text search finds nothing', () => {
    expect(fixture('1917-en')).toEqual([]);
    expect(pick('1917-en', 'features-1917', {name: '1917'}, 'en')).toMatchObject({kind: 'movie', year: 2019});
  });

  it('prefers a show for an episode and a movie otherwise', () => {
    const movie = {key: 'movie:1', kind: 'movie', title: 'Titanic', year: 1997, imdbId: 1, showId: null, subtitles: 50, order: 0};
    const show = {key: 'show:2', kind: 'show', title: 'Titanic', year: 2012, imdbId: null, showId: 2, subtitles: 50, order: 1};
    expect(rankTitles([movie, show], {name: 'Titanic'})[0].key).toBe('movie:1');
    expect(rankTitles([movie, show], {name: 'Titanic', season: 1, episode: 2})[0].key).toBe('show:2');
  });
});

describe('the titles a search offers', () => {
  const choose = (subtitles, features, wanted, language) =>
    chooseTitles(titlesFromSubtitles(fixture(subtitles)), titlesFromFeatures(fixture(features), language), wanted);

  it('offers the other titles of that name, each once, and not those that only share a word', () => {
    const oppenheimer = choose('oppenheimer-de', 'features-oppenheimer', {name: 'Oppenheimer', year: 2023}, 'de');
    expect(oppenheimer.best.imdbId).toBe(15398776);
    expect(oppenheimer.others.map((title) => `${title.title} ${title.year}`.toLowerCase())).toContain('oppenheimer 1980');
    const bear = choose('the-bear-s2e3-en', 'features-the-bear-tvshow', {name: 'The Bear', season: 2, episode: 3}, 'en');
    expect(bear.others.map((title) => title.title.toLowerCase())).toEqual(['the bear family and me']);
    const labels = (list) => list.map((title) => normalizeTitle(title.title) + '|' + title.year);
    const all = chooseTitles(titlesFromSubtitles(fixture('the-bear-s2e3-en')), titlesFromFeatures(fixture('features-the-bear-tvshow'), 'en'),
        {name: 'The Bear', season: 2, episode: 3}, {minMatch: 1, most: 50});
    expect(new Set(labels(all.others)).size).toBe(all.others.length);
  });

  it('takes the text search\'s title when no name matches: the API knows a film\'s other titles', () => {
    // OpenSubtitles calls it "Amélie"; its title search finds nothing for the German name.
    expect(fixture('features-amelie')).toEqual([]);
    const amelie = choose('amelie-de', 'features-amelie', {name: 'Die fabelhafte Welt der Amélie', year: 2001}, 'de');
    expect(amelie.best).toMatchObject({kind: 'movie', year: 2001, title: 'Amélie', name: 0});
  });

  it('finds nothing in nothing', () => {
    expect(chooseTitles([], [], {name: 'Anything'})).toBe(null);
  });
});

describe('title names', () => {
  it('compares them without accents, case or punctuation', () => {
    expect(normalizeTitle('Die fabelhafte Welt der Amélie')).toBe('die fabelhafte welt der amelie');
    expect(normalizeTitle('Spider-Man: No Way Home')).toBe('spider man no way home');
    expect(normalizeTitle('Fast & Furious')).toBe('fast and furious');
    expect(nameMatch('Dune: Part Two', 'Dune Part Two')).toBe(100);
    expect(nameMatch('The Bear', 'Bear')).toBe(95);
    expect(nameMatch('Dune', 'Dune Part Two')).toBe(60);
    expect(nameMatch('Masha and the Bear', 'The Bear')).toBe(25);
    expect(nameMatch('Titane', 'Titanic')).toBe(0);
    expect(nameMatch('', 'Titanic')).toBe(0);
  });
});

describe('asking for one title\'s subtitles', () => {
  it('asks for a movie by its IMDb id and an episode by its show, the most downloaded first', () => {
    expect(titleQuery({kind: 'movie', imdbId: 15398776}, {language: 'de'}))
        .toEqual({imdb_id: '15398776', languages: 'de', order_by: 'download_count'});
    expect(titleQuery({kind: 'show', showId: 1385125}, {language: 'en', season: 2, episode: 3, page: 2}))
        .toEqual({parent_feature_id: '1385125', season_number: '2', episode_number: '3', languages: 'en',
          order_by: 'download_count', page: '2'});
    expect(titleQuery({kind: 'movie', imdbId: 1}, {})).toEqual({imdb_id: '1', order_by: 'download_count'});
  });

  it('shows a subtitle by its release name, downloads and kind', () => {
    const [first] = fixture('oppenheimer-imdb-de');
    expect(describeSubtitle(first.attributes)).toEqual({
      release: 'Oppenheimer.2023.German.DL.1080p.BluRay.x264.RERiP-DETAiLS', downloads: first.attributes.download_count,
      language: 'de', uploader: first.attributes.uploader.name ?? '', fps: 23.976, hearingImpaired: false, machine: false,
      trusted: !!first.attributes.from_trusted,
    });
    expect(describeSubtitle({ai_translated: true, fps: 0, feature_details: {movie_name: 'X'}}))
        .toMatchObject({release: 'X', machine: true, fps: null, downloads: 0});
    expect(describeSubtitle(undefined).release).toBe('');
  });
});
