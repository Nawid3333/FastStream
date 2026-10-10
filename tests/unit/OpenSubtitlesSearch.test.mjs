import {afterEach, describe, expect, it, vi} from 'vitest';
import {RequestUtils} from '../../chrome/player/utils/RequestUtils.mjs';
import {OpenSubtitlesSearch} from '../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs';

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));

// The search took any "errors" field as a failure, an empty list too ([] is truthy): an
// answer with results and "errors": [] showed an empty error instead of them (audit,
// 2026-10-09).

afterEach(() => {
  vi.restoreAllMocks();
});

const answer = (response) => vi.spyOn(RequestUtils, 'request').mockResolvedValue({response});
const request = () => OpenSubtitlesSearch.prototype.request.call({version: '1.0'}, 'subtitles', {query: 'dune'});

describe('OpenSubtitlesSearch.request', () => {
  it('returns the results when the error list is empty', async () => {
    const response = {data: [{id: '1'}], errors: []};
    answer(response);
    await expect(request()).resolves.toBe(response);
  });

  it('fails with the API\'s errors when there are some', async () => {
    answer({errors: ['Throttle limit reached', 'Bad key']});
    await expect(request()).rejects.toThrow('Throttle limit reached, Bad key');
    answer({errors: 'Bad key'});
    await expect(request()).rejects.toThrow('Bad key');
  });
});

// "S2" or "Season 2" was no number, and the search went on as one for a movie (review,
// 2026-10-09). 0 is a season (specials), and stays one.
describe('OpenSubtitlesSearch.readInputs', () => {
  const read = (season, episode, year = '') => OpenSubtitlesSearch.prototype.readInputs.call({subui: {
    search: {value: ' Dune '}, languageInput: {value: 'en'}, yearInput: {value: year},
    seasonInput: {value: season}, episodeInput: {value: episode},
  }});

  it('takes the first number of a season or episode written with words', () => {
    expect(read('S2', 'Episode 5')).toMatchObject({query: 'Dune', season: 2, episode: 5});
    expect(read('Season 02', 'e07')).toMatchObject({season: 2, episode: 7});
  });

  it('keeps 0 and leaves empty or wordless fields out', () => {
    expect(read('0', '3')).toMatchObject({season: 0, episode: 3});
    expect(read('', 'none', 'abc')).toMatchObject({season: null, episode: null, year: null});
    // A sign is kept, and a negative left out: "-1" was read as 1.
    expect(read('-2', 'S-1', '-1999')).toMatchObject({season: null, episode: null, year: null});
  });
});
