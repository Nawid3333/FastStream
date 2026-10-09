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
