import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The page's subtitle tracks that came as a URL. requestSimple answers a network error with
// no request at all (undefined); reading its status threw, and one dead track lost every
// track, the page's fullscreen state and the background's answer (main.mjs, 2026-10-05).
const requestSimple = vi.fn();
vi.mock('../../chrome/player/utils/RequestUtils.mjs', () => ({RequestUtils: {requestSimple}}));
vi.mock('../../chrome/player/utils/SubtitleUtils.mjs', () => ({
  SubtitleUtils: {decodeSubtitleBytes: (bytes) => `text of ${bytes}`},
}));
const {loadSubtitles} = await import('../../chrome/player/utils/SubtitleFetch.mjs');

const answer = (status, body) => ({status, response: body, getResponseHeader: () => 'text/vtt'});

describe('loadSubtitles', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', {runtime: {sendMessage: vi.fn(async () => {})}});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    requestSimple.mockReset();
  });

  it('keeps the tracks that load when another one cannot be fetched', async () => {
    requestSimple.mockImplementation(async ({url}) => url.includes('dead') ? undefined : answer(200, url));
    const subs = await loadSubtitles([
      {source: 'https://cdn.example/en.vtt', label: 'English'},
      {source: 'https://dead.example/de.vtt', label: 'Deutsch'},
      {source: 'https://cdn.example/fr.vtt', label: 'Français'},
    ]);
    expect(subs.map((sub) => sub.label)).toEqual(['English', 'Français']);
    expect(subs[0].data).toBe('text of https://cdn.example/en.vtt');
  });

  it('leaves out a track whose headers request fails, or that answers 404', async () => {
    chrome.runtime.sendMessage = vi.fn(async (message) => {
      if (message.url.includes('blocked')) throw new Error('Receiving end does not exist');
    });
    requestSimple.mockImplementation(async ({url}) => answer(url.includes('missing') ? 404 : 200, url));
    const subs = await loadSubtitles([
      {source: 'https://cdn.example/blocked.vtt', label: 'a'},
      {source: 'https://cdn.example/missing.vtt', label: 'b'},
      {source: 'https://cdn.example/ok.vtt', label: 'c', headers: [{name: 'Referer', value: 'https://site.example/'}, {value: 'no name'}]},
    ]);
    expect(subs.map((sub) => sub.label)).toEqual(['c']);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://cdn.example/ok.vtt',
      commands: [{operation: 'set', header: 'referer', value: 'https://site.example/'}],
    }));
  });

  it('keeps a track that came with its text, without fetching it', async () => {
    const subs = await loadSubtitles([{data: 'WEBVTT', label: 'inline'}]);
    expect(subs).toEqual([{data: 'WEBVTT', label: 'inline'}]);
    expect(requestSimple).not.toHaveBeenCalled();
  });
});
