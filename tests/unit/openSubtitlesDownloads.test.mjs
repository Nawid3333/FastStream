import {describe, expect, it, vi} from 'vitest';

// A search result says how often its subtitle was downloaded: "1 downloads" for one.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, subs) => key + (subs ? '(' + subs.join(',') + ')' : '')},
}));

const {OpenSubtitlesSearch} = await import('../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs');

describe('the downloads of a subtitle', () => {
  it('are one, or a number', () => {
    expect(OpenSubtitlesSearch.downloadsText(1)).toBe('player_opensubtitles_downloads_one');
    expect(OpenSubtitlesSearch.downloadsText(0)).toBe('player_opensubtitles_downloads(0)');
    expect(OpenSubtitlesSearch.downloadsText(2)).toBe('player_opensubtitles_downloads(2)');
  });
});
