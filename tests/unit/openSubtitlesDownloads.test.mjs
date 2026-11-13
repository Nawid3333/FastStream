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
const {AlertPolyfill} = await import('../../chrome/player/utils/AlertPolyfill.mjs');
const {EnvUtils} = await import('../../chrome/player/utils/EnvUtils.mjs');
const {DOMElements} = await import('../../chrome/player/ui/DOMElements.mjs');

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

describe('opening a result on OpenSubtitles', () => {
  // After a failed download or at the quota, the player offers to open the result's page.
  // Its address is the API's answer, which the download itself treats as hostile
  // (isOpenSubtitlesDownloadLink); it went to tabs.create unchecked, which opens any site,
  // and an extension page of its own for a relative address (the review of 2026-11-13).
  const pages = ['/player/index.html#https://evil.example/stream.m3u8', 'https://evil.example/subtitles',
    'javascript:alert(1)', 'http://www.opensubtitles.com/en/subtitles/x', 'https://opensubtitles.com.evil.example/x'];
  const page = 'https://www.opensubtitles.com/en/subtitles/legacy/123';

  /**
   * Runs a download that ends with the offer, and says what was opened.
   * @param {string} url - The result's page, as the answer gave it.
   * @param {'quota'|'failure'} end
   * @return {Promise<string[]>}
   */
  const offer = async (url, end) => {
    const open = vi.spyOn(EnvUtils, 'openExternalURL').mockImplementation(() => {});
    AlertPolyfill.confirm.mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    if (end === 'quota') {
      RequestUtils.request.mockResolvedValueOnce({response: {remaining: 0, reset_time: 'soon'}});
    } else {
      DOMElements.subuiContainer.style.display = '';
      RequestUtils.request.mockRejectedValueOnce(new Error('offline'));
    }
    const item = {attributes: {files: [{file_id: 7}], url}};
    await OpenSubtitlesSearch.prototype.download.call({downloadGeneration: 0, version: '1', emit: vi.fn()}, item);
    DOMElements.subuiContainer.style.display = 'none';
    const opened = open.mock.calls.map((call) => call[0]);
    open.mockRestore();
    return opened;
  };

  it('opens only an https page on OpenSubtitles\' own hosts', async () => {
    for (const end of ['quota', 'failure']) {
      for (const url of pages) {
        expect(await offer(url, end), `${end}: ${url}`).toEqual([]);
      }
      expect(await offer(page, end), end).toEqual([page]);
    }
  });

  it('does not offer to open a page it would not open', async () => {
    AlertPolyfill.confirm.mockClear();
    await offer(pages[0], 'failure');
    await offer(pages[1], 'quota');
    expect(AlertPolyfill.confirm).not.toHaveBeenCalled();
    // The alert still says what went wrong.
    expect(AlertPolyfill.alert).toHaveBeenCalled();
  });
});
