import {afterEach, describe, expect, it, vi} from 'vitest';

import {installFakeDom} from './fakeCueDom.mjs';
import {response} from './backgroundHarness.mjs';

// The page's subtitles for mpv in MPV mode: each track read the player's way (its parser,
// its fetch with the page's Origin and Referer) and written as SubRip, as the player's mpv
// button writes the tracks it shows.

installFakeDom();
const {FETCH_TIMEOUT_MS, MAX_FILE_BYTES, MAX_TRACKS, MpvSubtitles} = await import('../../chrome/background/MpvSubtitles.mjs');

const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500 align:start\nHello\n\n00:01:03.000 --> 00:01:04.000\nWorld\n';
const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:01:03,000 --> 00:01:04,000\nWorld';
const PAGE_HEADERS = [
  {name: 'Referer', value: 'https://site.test/watch/1'},
  {name: 'Origin', value: 'https://site.test'},
  {name: 'Cookie', value: 'session=1'},
  {name: 'User-Agent', value: 'Firefox'},
];

afterEach(() => {
  vi.useRealTimers();
});

describe('MpvSubtitles.toSrt', () => {
  it('fetches a detected track with the page\'s Origin and Referer, and writes it as SubRip', async () => {
    const fetch = vi.fn(async () => response(VTT));
    const setHeaders = vi.fn(async () => {});
    const subs = new MpvSubtitles({fetch, setHeaders});
    const tracks = await subs.toSrt([{source: 'https://cdn.test/subs/episode-en.vtt', headers: PAGE_HEADERS, label: 'episode-en'}]);
    expect(tracks).toEqual([{label: 'episode-en', srt: SRT}]);
    // Only the two the player sets for its own subtitle requests; the cookie stays the page's.
    expect(setHeaders).toHaveBeenCalledWith('https://cdn.test/subs/episode-en.vtt', [
      {operation: 'set', header: 'referer', value: 'https://site.test/watch/1'},
      {operation: 'set', header: 'origin', value: 'https://site.test'},
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Not in the cache: the page may be in a private window, and this request is not.
    expect(fetch.mock.calls[0][1]).toMatchObject({credentials: 'omit', cache: 'no-store'});
  });

  it('takes a <track> element\'s text as the page read it, with no request of its own', async () => {
    const fetch = vi.fn(async () => response(VTT));
    const tracks = await new MpvSubtitles({fetch}).toSrt([
      {data: VTT, source: 'https://site.test/subs/de.vtt', label: 'Deutsch', language: 'de'},
      // No label: its language names it in mpv.
      {data: VTT.replace('Hello', 'Hallo'), source: 'https://site.test/subs/fr.vtt', label: '', language: 'fr'},
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(tracks.map((t) => t.label)).toEqual(['Deutsch', 'fr']);
    expect(tracks[1].srt).toContain('Hallo');
  });

  it('reads a SubRip file as the player does', async () => {
    const tracks = await new MpvSubtitles().toSrt([{data: SRT + '\n', source: 'https://site.test/a.srt', label: 'a'}]);
    expect(tracks).toEqual([{label: 'a', srt: SRT}]);
  });

  it('leaves out a track that fails, and sends the others', async () => {
    const fetch = vi.fn(async (url) => {
      if (url.endsWith('/missing.vtt')) return response('', 404);
      if (url.endsWith('/down.vtt')) throw new TypeError('NetworkError when attempting to fetch resource.');
      if (url.endsWith('/page.vtt')) return response('<html><body>Not found</body></html>');
      return response(VTT);
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracks = await new MpvSubtitles({fetch}).toSrt([
      {source: 'https://cdn.test/missing.vtt', label: 'missing'},
      {source: 'https://cdn.test/down.vtt', label: 'down'},
      {source: 'https://cdn.test/page.vtt', label: 'page'},
      {source: 'https://cdn.test/good.vtt', label: 'good'},
    ]);
    expect(tracks.map((t) => t.label)).toEqual(['good']);
  });

  it('reads each URL once, and sends at most what the host takes', async () => {
    const fetch = vi.fn(async () => response(VTT));
    const subs = [];
    for (let i = 0; i < 12; i++) {
      subs.push({source: `https://cdn.test/${i}.vtt`, label: String(i)});
    }
    subs.splice(1, 0, {source: 'https://cdn.test/0.vtt', label: 'again'});
    const tracks = await new MpvSubtitles({fetch}).toSrt(subs);
    expect(tracks.map((t) => t.label)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
    expect(tracks).toHaveLength(MAX_TRACKS);
  });

  it('leaves out a file larger than the host could take', async () => {
    const cue = '00:00:01.000 --> 00:00:02.000\nA line of a subtitle that goes on for a while\n\n';
    const huge = 'WEBVTT\n\n' + cue.repeat(Math.ceil(MAX_FILE_BYTES / cue.length) + 1);
    const fetch = vi.fn(async (url) => response(url.endsWith('/huge.vtt') ? huge : VTT));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracks = await new MpvSubtitles({fetch}).toSrt([
      {source: 'https://cdn.test/huge.vtt', label: 'huge'},
      {source: 'https://cdn.test/small.vtt', label: 'small'},
    ]);
    expect(tracks.map((t) => t.label)).toEqual(['small']);
  });

  it('leaves out a <track> element\'s text larger than the host could take, unread', async () => {
    // The page's own text came as it was, of any size (content.js reads the whole file), and
    // was parsed in the background, which held up every tab's detection meanwhile (glm's
    // second look, 2026-10-13). A fetched file was capped already.
    const cue = '00:00:01.000 --> 00:00:02.000\nA line of a subtitle that goes on for a while\n\n';
    const huge = 'WEBVTT\n\n' + cue.repeat(Math.ceil(MAX_FILE_BYTES / cue.length) + 1);
    const subs = new MpvSubtitles();
    const loadTrack = vi.spyOn(subs, 'loadTrack');
    const tracks = await subs.toSrt([
      {data: huge, source: 'https://site.test/huge.vtt', label: 'huge'},
      {data: VTT, source: 'https://site.test/small.vtt', label: 'small'},
    ]);
    expect(tracks.map((t) => t.label)).toEqual(['small']);
    expect(loadTrack).toHaveBeenCalledTimes(1);
  });

  it('fetches only http(s) files', async () => {
    const fetch = vi.fn(async () => response(VTT));
    const tracks = await new MpvSubtitles({fetch}).toSrt([
      {source: 'blob:https://site.test/0b6f', label: 'blob'},
      {source: 'data:text/vtt,WEBVTT', label: 'data'},
    ]);
    expect(tracks).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives up on a file that does not come in time: mpv waits for the tracks', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((url, init) => new Promise((resolve, reject) => {
      if (url.endsWith('/slow.vtt')) {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      } else {
        resolve(response(VTT));
      }
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const done = new MpvSubtitles({fetch}).toSrt([
      {source: 'https://cdn.test/slow.vtt', label: 'slow'},
      {source: 'https://cdn.test/fast.vtt', label: 'fast'},
    ]);
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    expect((await done).map((t) => t.label)).toEqual(['fast']);
  });

  it('sends the track without the page\'s headers when the rule for them is refused', async () => {
    const fetch = vi.fn(async () => response(VTT));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracks = await new MpvSubtitles({fetch, setHeaders: async () => {
      throw new Error('refused');
    }}).toSrt([{source: 'https://cdn.test/a.vtt', headers: PAGE_HEADERS, label: 'a'}]);
    expect(tracks).toEqual([{label: 'a', srt: SRT}]);
  });
});
