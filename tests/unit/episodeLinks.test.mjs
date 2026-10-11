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
