import {describe, expect, it, vi} from 'vitest';

// A search result says how often its subtitle was downloaded: "1 downloads" for one.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {subuiContainer: {style: {display: 'none'}}}}));
vi.mock('../../chrome/player/modules/vtt.mjs', () => ({WebVTT: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, subs) => key + (subs ? '(' + subs.join(',') + ')' : '')},
}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({
  AlertPolyfill: {toast: vi.fn(async () => {}), alert: vi.fn(async () => {}), confirm: vi.fn(async () => false)},
}));
vi.mock('../../chrome/player/utils/RequestUtils.mjs', () => ({RequestUtils: {request: vi.fn()}}));

const {OpenSubtitlesSearch} = await import('../../chrome/player/ui/subtitles/OpenSubtitlesSearch.mjs');
const {RequestUtils} = await import('../../chrome/player/utils/RequestUtils.mjs');

describe('the downloads of a subtitle', () => {
  it('are one, or a number', () => {
    expect(OpenSubtitlesSearch.downloadsText(1)).toBe('player_opensubtitles_downloads_one');
    expect(OpenSubtitlesSearch.downloadsText(0)).toBe('player_opensubtitles_downloads(0)');
    expect(OpenSubtitlesSearch.downloadsText(2)).toBe('player_opensubtitles_downloads(2)');
  });
});

describe('downloading a subtitle', () => {
  it('asks for a new link after the kept one expired', async () => {
    // OpenSubtitles' download links expire: the dead one was kept and tried again on every
    // click (glm's second look, 2026-10-13).
    const item = {
      attributes: {files: [{file_id: 7}], url: 'https://www.opensubtitles.com/en/subtitles/x'},
      cached_download_link: 'https://www.opensubtitles.com/download/expired/sub.vtt',
    };
    RequestUtils.request.mockResolvedValueOnce({status: 410, response: null, getResponseHeader: () => null});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await OpenSubtitlesSearch.prototype.download.call({downloadGeneration: 0, version: '1', emit: vi.fn()}, item);

    expect(item.cached_download_link).toBeFalsy();
    expect(item.downloading).toBe(false);
  });
});
