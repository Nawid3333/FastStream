import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
// The script's text, as contentDom.mjs takes content.js's (?raw: CodeQL js/code-injection).
import episodeLinksSource from '../../chrome/episode-links.js?raw';

// chrome/episode-links.js, a classic content script before content.js: which link means the
// next (or the previous) episode (his wish, 2026-10-11: autoplay on as many sites as possible).
const context = vm.createContext({URL});
vm.runInContext(episodeLinksSource, context, {filename: 'chrome/episode-links.js'});
const EpisodeLinks = vm.runInContext('EpisodeLinks', context);

describe('EpisodeLinks.phraseScore', () => {
  it.each([
    ['Next episode', true], ['Next Episode 13', true], ['Nächste Folge »', true], ['nächste   episode', true],
    ['Épisode suivant', true], ['Siguiente episodio', true], ['Prossimo episodio', true], ['Volgende aflevering', true],
    ['Następny odcinek', true], ['Следующая серия', true], ['Sonraki bölüm', true], ['次のエピソード', true],
    ['下一集', true], ['다음 화', true], ['Episode berikutnya', true], ['Nächste Folge: Der Anfang', true],
    ['Previous episode', false], ['‹ Vorherige Folge', false], ['Épisode précédent', false], ['上一集', false],
    ['이전 화', false], ['Предыдущая серия', false],
    // Upper case with a Turkish İ: lower case gave "i̇", a dot added (glm's review, 2026-10-13).
    ['SONRAKİ BÖLÜM', true], ['ÖNCEKİ BÖLÜM', false], ['NEXT EPISODE', true],
  ])('takes "%s" for an episode (next: %s)', (text, isNext) => {
    expect(EpisodeLinks.phraseScore(text, isNext)).toBe(2);
  });

  it.each([['Next', true], ['weiter', true], ['Suivant', true], ['次へ', true], ['Prev', false], ['Zurück', false]])(
      'takes the bare word "%s" for a weaker hint', (text, isNext) => {
        expect(EpisodeLinks.phraseScore(text, isNext)).toBe(1);
      });

  it.each([
    // A page of a list, not an episode.
    ['Next page', true], ['Nächste Seite', true], ['Page suivante', true], ['下一页', true], ['次のページ', true],
    // The other direction, other words, a word that only starts like one.
    ['Previous episode', true], ['Next episode', false], ['Nextflix', true], ['Next episodes list', true],
    ['', true], [null, true],
  ])('does not take "%s" (next: %s)', (text, isNext) => {
    expect(EpisodeLinks.phraseScore(text, isNext)).toBe(0);
  });
});

describe('EpisodeLinks.neighbourEpisodeUrls', () => {
  it.each([
    ['https://s.to/serie/hellbound/staffel-1/episode-3', 'https://s.to/serie/hellbound/staffel-1/episode-4'],
    ['https://a.test/watch/one-piece-ep-09.html', 'https://a.test/watch/one-piece-ep-10.html'],
    ['https://a.test/anime/folge12', 'https://a.test/anime/folge13'],
    ['https://a.test/show/S02E05', 'https://a.test/show/S02E06'],
    ['https://a.test/show/2x05/', 'https://a.test/show/2x06/'],
    ['https://a.test/v?id=3&ep=12', 'https://a.test/v?id=3&ep=13'],
    ['https://a.test/watch/12', 'https://a.test/watch/13'],
    ['https://a.test/watch/007#t=10', 'https://a.test/watch/008'],
  ])('goes from %s to %s first', (from, to) => {
    expect(EpisodeLinks.neighbourEpisodeUrls(from, true)[0]).toBe(to);
  });

  it('goes back one for the previous episode, the series part unchanged', () => {
    expect(EpisodeLinks.neighbourEpisodeUrls('https://s.to/serie/x-2/staffel-2/episode-10', false)[0])
        .toBe('https://s.to/serie/x-2/staffel-2/episode-9');
  });

  it('changes the episode, not the season, where a page names both', () => {
    const next = EpisodeLinks.neighbourEpisodeUrls('https://s.to/serie/x/staffel-1/episode-9', true);
    expect(next).toEqual(['https://s.to/serie/x/staffel-1/episode-10']);
  });

  it('has nothing for a page without a number, or no address', () => {
    expect(EpisodeLinks.neighbourEpisodeUrls('https://a.test/watch/movie', true)).toEqual([]);
    expect(EpisodeLinks.neighbourEpisodeUrls('not a url', true)).toEqual([]);
  });
});

// His report (2026-10-11, aniworld.cc): after a season's last episode, autoplay went on to
// another series.
describe('EpisodeLinks.seriesOf / inSeries', () => {
  const ANIWORLD = 'https://aniworld.cc/anime/stream/the-100-girlfriends';
  it.each([
    [`${ANIWORLD}/staffel-3/episode-12`, `${ANIWORLD}/`],
    ['https://s.to/serie/stream/hellbound/staffel-1/episode-3', 'https://s.to/serie/stream/hellbound/'],
    ['https://a.test/show/x/season_2/ep-5/', 'https://a.test/show/x/'],
    ['https://a.test/tv/x/S02E05', 'https://a.test/tv/x/'],
    ['https://a.test/tv/x/2x05', 'https://a.test/tv/x/'],
    ['https://a.test/anime/x/folge12.html', 'https://a.test/anime/x/'],
    ['https://a.test/watch/one-piece-episode-1000', 'https://a.test/watch/one-piece-'],
    // A season and an episode in one segment (deepseek's review).
    ['https://a.test/show/x/staffel-3-episode-12', 'https://a.test/show/x/'],
    ['https://a.test/watch/my-show-season-2-episode-5', 'https://a.test/watch/my-show-'],
  ])('tells the series of %s: %s', (page, series) => {
    expect(EpisodeLinks.seriesOf(page)).toBe(series);
  });

  it('tells none where the address names no season or episode', () => {
    expect(EpisodeLinks.seriesOf('https://a.test/watch/12345')).toBe(null);
    expect(EpisodeLinks.seriesOf('https://a.test/anime/stream/the-100-girlfriends')).toBe(null);
    expect(EpisodeLinks.seriesOf('not a url')).toBe(null);
  });

  it('keeps a link of the series, its other seasons too, and not another series', () => {
    const series = EpisodeLinks.seriesOf(`${ANIWORLD}/staffel-3/episode-12`);
    expect(EpisodeLinks.inSeries(series, `${ANIWORLD}/staffel-4/episode-1`)).toBe(true);
    expect(EpisodeLinks.inSeries(series, `${ANIWORLD}/staffel-3`)).toBe(true);
    expect(EpisodeLinks.inSeries(series, 'https://aniworld.cc/anime/stream/kaiju-girl-caramelise')).toBe(false);
    expect(EpisodeLinks.inSeries(series, 'https://aniworld.cc/anime/stream/the-100-girlfriends-2/staffel-1/episode-1'))
        .toBe(false);
    const onePiece = EpisodeLinks.seriesOf('https://a.test/watch/one-piece-episode-1000');
    expect(EpisodeLinks.inSeries(onePiece, 'https://a.test/watch/one-piece-episode-1001')).toBe(true);
    expect(EpisodeLinks.inSeries(onePiece, 'https://a.test/watch/naruto-episode-1')).toBe(false);
    // A sequel that only starts the same (deepseek's review).
    expect(EpisodeLinks.inSeries(onePiece, 'https://a.test/watch/one-piece-2/staffel-1/episode-1')).toBe(false);
    expect(EpisodeLinks.inSeries(onePiece, 'https://a.test/watch/one-piece-2-episode-1')).toBe(false);
    // A series that is a folder has its other parts in it (kimi's review); a sequel's folder not.
    expect(EpisodeLinks.inSeries(series, `${ANIWORLD}/ova/staffel-1/episode-1`)).toBe(true);
    expect(EpisodeLinks.inSeries(series, `${ANIWORLD}-2/staffel-1/episode-1`)).toBe(false);
    // No series told: any link may be the next.
    expect(EpisodeLinks.inSeries(null, 'https://a.test/anything')).toBe(true);
  });
});

describe('EpisodeLinks.nextSeason', () => {
  it('goes from a season\'s episode to the next season and its first episode', () => {
    expect(EpisodeLinks.nextSeason('https://s.to/serie/stream/x/staffel-3/episode-12?a=1#t')).toEqual({
      season: 'https://s.to/serie/stream/x/staffel-4',
      first: 'https://s.to/serie/stream/x/staffel-4/episode-1',
    });
    expect(EpisodeLinks.nextSeason('https://a.test/show/x/season-09/ep-012/').first).toBe('https://a.test/show/x/season-10/ep-001/');
  });

  it('goes on from an S03E12 or a 3x12 too, its episodes with two digits (deepseek\'s review)', () => {
    expect(EpisodeLinks.nextSeason('https://a.test/tv/x/S03E12')).toEqual({
      season: 'https://a.test/tv/x/S04',
      first: 'https://a.test/tv/x/S04E01',
    });
    expect(EpisodeLinks.nextSeason('https://a.test/tv/x/3x12.html').first).toBe('https://a.test/tv/x/4x01.html');
    expect(EpisodeLinks.seasonEpisode('https://a.test/tv/x/s03e14')).toMatchObject({show: 'https://a.test/tv/x/s', season: 3, episode: 14});
  });

  it('goes on where one segment names the season and the episode', () => {
    expect(EpisodeLinks.nextSeason('https://a.test/show/x/staffel-3-episode-12')).toEqual({
      season: 'https://a.test/show/x/staffel-4',
      first: 'https://a.test/show/x/staffel-4-episode-1',
    });
    expect(EpisodeLinks.nextSeason('https://a.test/watch/my-show-season-2-episode-5.html').first)
        .toBe('https://a.test/watch/my-show-season-3-episode-1.html');
  });

  it('has none for an address without a season', () => {
    expect(EpisodeLinks.nextSeason('https://a.test/watch/12')).toBe(null);
    expect(EpisodeLinks.nextSeason('https://a.test/watch/episode-12')).toBe(null);
  });
});
