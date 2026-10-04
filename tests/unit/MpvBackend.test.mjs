import {afterEach, describe, expect, it, vi} from 'vitest';
import {HostMaxMessageBytes, MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {MaxMessageBytes} from '../../native-host/faststream-mpv-host.mjs';

// The header filter decides which request headers are relayed to mpv.
// Deliberately narrow: only Referer/Origin (CDN checks use those) and
// User-Agent (mpv would otherwise identify itself as "libmpv", which UA-gated
// CDNs reject). Forwarding cookies or auth headers to an external process
// would leak credentials out of the browser.

describe('pickRelayHeaders', () => {
  // A value can come from a page (a player's source headers). The native host starts mpv
  // through PowerShell, which also ends a quoted string at the typographic quotes, and mpv
  // would send a CR/LF on as a second header: only printable ASCII is relayed.
  it.each([
    ['a typographic quote', 'x' + String.fromCodePoint(0x2019) + ';k=1'],
    ['CR LF', 'https://site.test/' + String.fromCharCode(13, 10) + 'X-Evil: 1'],
    ['a NUL', 'https://site.test/' + String.fromCharCode(0)],
    ['non-ASCII', 'https://site.test/vid' + String.fromCodePoint(0xE9) + 'o'],
    ['over 4096 characters', 'https://site.test/' + 'a'.repeat(4096)],
    ['a number', 5],
  ])('drops a value with %s', (what, value) => {
    expect(MpvBackend.pickRelayHeaders([{name: 'Referer', value}])).toBeUndefined();
  });

  it('returns undefined for a missing header list', () => {
    expect(MpvBackend.pickRelayHeaders(undefined)).toBeUndefined();
    expect(MpvBackend.pickRelayHeaders(null)).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(MpvBackend.pickRelayHeaders([])).toBeUndefined();
  });

  it('keeps Referer and Origin, case-insensitively', () => {
    const headers = [
      {name: 'Referer', value: 'https://example.com/page'},
      {name: 'Origin', value: 'https://example.com'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual(headers);
  });

  it('keeps lowercase variants', () => {
    const headers = [
      {name: 'referer', value: 'https://example.com/page'},
      {name: 'origin', value: 'https://example.com'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual(headers);
  });

  it('keeps User-Agent so CDNs do not see libmpv', () => {
    const headers = [
      {name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'},
    ]);
  });

  it('drops everything else, including cookies and auth', () => {
    const headers = [
      {name: 'Cookie', value: 'session=secret'},
      {name: 'Authorization', value: 'Bearer token'},
      {name: 'Accept', value: '*/*'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toBeUndefined();
  });

  it('keeps a comma in a value: the host appends headers one at a time', () => {
    const headers = [
      {name: 'Referer', value: 'https://example.com/?list=a,b'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'Referer', value: 'https://example.com/?list=a,b'},
    ]);
  });

  it('keeps only the first value when a header repeats', () => {
    const headers = [
      {name: 'Referer', value: 'https://example.com/first'},
      {name: 'referer', value: 'https://example.com/second'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'Referer', value: 'https://example.com/first'},
    ]);
  });

  it('keeps relayed headers and drops others in a mixed list', () => {
    const headers = [
      {name: 'Host', value: 'cdn.example.com'},
      {name: 'Referer', value: 'https://example.com/'},
      {name: 'Cookie', value: 'session=secret'},
    ];
    const picked = MpvBackend.pickRelayHeaders(headers);
    expect(picked).toEqual([{name: 'Referer', value: 'https://example.com/'}]);
  });

  it('drops headers with empty names or values', () => {
    const headers = [
      {name: '', value: 'https://example.com/'},
      {name: 'Origin', value: ''},
      {name: 'Origin', value: 'https://example.com'},
    ];
    expect(MpvBackend.pickRelayHeaders(headers)).toEqual([
      {name: 'Origin', value: 'https://example.com'},
    ]);
  });
});

// openStream records every URL it hands to the host so a page that reports the
// same source twice does not open two windows. That record must not survive a
// failed launch: the user fixes the cause (installs mpv, corrects the path)
// and retries the very same video, and a stale entry would make the retry
// report success while nothing plays.

/**
 * Installs a fake chrome.runtime whose sendNativeMessage replies with a fixed
 * response, and reports how many times it was called.
 * @param {Object|null} response - Reply handed to the callback.
 * @param {Object} [lastError] - chrome.runtime.lastError to simulate.
 * @return {{calls: () => number}} Call counter.
 */
function stubNativeHost(response, lastError) {
  let calls = 0;
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(name, message, callback) {
        calls++;
        globalThis.chrome.runtime.lastError = lastError;
        callback(response);
        globalThis.chrome.runtime.lastError = undefined;
      },
    },
  };
  return {calls: () => calls};
}

describe('openStream retry bookkeeping', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it('does not resend a URL the host already accepted', async () => {
    const host = stubNativeHost({ok: true, hostVersion: RequiredHostVersion});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true});
    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true});
    expect(host.calls()).toBe(1);
  });

  it('lets the same URL be retried after the host reports a launch failure', async () => {
    const host = stubNativeHost({ok: false, error: 'mpv executable not found'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    const first = await backend.openStream('https://cdn/a.m3u8', tab);
    expect(first.ok).toBe(false);
    expect(tab.mpvSentUrls.has('https://cdn/a.m3u8')).toBe(false);

    const second = await backend.openStream('https://cdn/a.m3u8', tab);
    expect(second.ok).toBe(false);
    expect(host.calls()).toBe(2);
  });

  it('lets the same URL be retried when the host is not installed', async () => {
    const host = stubNativeHost(undefined, {message: 'no such native application'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    await backend.openStream('https://cdn/a.m3u8', tab);
    await backend.openStream('https://cdn/a.m3u8', tab);
    expect(host.calls()).toBe(2);
  });

  // The player and the toolbar show the host's own reason, and "is the host
  // installed?" only when the host itself could not be reached.
  it('says when the host itself could not be reached', async () => {
    stubNativeHost(undefined, {message: 'no such native application'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'no such native application', noHost: true});
  });

  it('passes the host\'s own reason on, without noHost', async () => {
    stubNativeHost({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'mpv executable not found'});
  });

  // The host says how raising mpv's window went (host version 3): the result passes it
  // on, so the background can log an mpv that opened behind the browser (2026-10-04).
  it('passes on how raising mpv\'s window went, as the host sent it', async () => {
    stubNativeHost({ok: true, hostVersion: RequiredHostVersion, focus: 'True', foreground: 'False', reused: true});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toStrictEqual({ok: true, focus: 'True', foreground: 'False', reused: true});
    stubNativeHost({ok: true, hostVersion: RequiredHostVersion, focus: 'nowindow'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toStrictEqual({ok: true, focus: 'nowindow'});
  });

  it('passes on only fields of the expected type', async () => {
    stubNativeHost({ok: true, hostVersion: RequiredHostVersion, focus: 5, foreground: {x: 1}, reused: 'yes'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toStrictEqual({ok: true});
  });
});

// contentType is the MPV allowlist tag or the player's manual anime/movie
// override, threaded through to the native host message so it can append
// the #fs-content= marker gpu-toggles.lua reads on the mpv side.

describe('openStream contentType', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  /**
   * Installs a fake native host that captures the message it was sent.
   * @return {{message: () => Object}} The most recent message sent.
   */
  function captureNativeHost() {
    let lastMessage;
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          lastMessage = message;
          callback({ok: true});
        },
      },
    };
    return {message: () => lastMessage};
  }

  it('includes a valid contentType in the message', async () => {
    const host = captureNativeHost();
    const backend = new MpvBackend();
    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime');
    expect(host.message().contentType).toBe('anime');

    await backend.openStream('https://cdn/b.m3u8', undefined, undefined, 'movie');
    expect(host.message().contentType).toBe('movie');
  });

  it('omits contentType when unset or invalid', async () => {
    const host = captureNativeHost();
    const backend = new MpvBackend();

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, undefined);
    expect(host.message()).not.toHaveProperty('contentType');

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, null);
    expect(host.message()).not.toHaveProperty('contentType');

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'documentary');
    expect(host.message()).not.toHaveProperty('contentType');
  });

  it('relays an http(s) page URL for the resume key, and nothing else', async () => {
    const host = captureNativeHost();
    const backend = new MpvBackend();

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', 'https://site/ep-3');
    expect(host.message().pageUrl).toBe('https://site/ep-3');

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', undefined);
    expect(host.message()).not.toHaveProperty('pageUrl');

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', 'about:blank');
    expect(host.message()).not.toHaveProperty('pageUrl');
  });

  it('relays the tab\'s title for mpv to show, trimmed and bounded', async () => {
    const host = captureNativeHost();
    const backend = new MpvBackend();

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', 'https://site/ep-3', '  Show - Episode 3 ');
    expect(host.message().title).toBe('Show - Episode 3');

    await backend.openStream('https://cdn/b.m3u8', undefined, undefined, 'anime', 'https://site/ep-3', 'x'.repeat(400));
    expect(host.message().title).toHaveLength(300);

    for (const none of [undefined, '', '   ', 42]) {
      await backend.openStream('https://cdn/c.m3u8', undefined, undefined, 'anime', 'https://site/ep-3', none);
      expect(host.message()).not.toHaveProperty('title');
    }
  });

  it('relays where the player was and its subtitles (the player\'s button)', async () => {
    const host = captureNativeHost();
    const backend = new MpvBackend();
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello';

    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', undefined, undefined,
        {startTime: 754.5, subtitles: [{label: 'English', srt}, {label: 'empty', srt: '  '}, {srt: 5}]});
    expect(host.message().start).toBe(754.5);
    expect(host.message().subtitles).toEqual([{label: 'English', srt}]);

    await backend.openStream('https://cdn/b.m3u8', undefined, undefined, 'anime', undefined, undefined,
        {startTime: 0.4, subtitles: []});
    expect(host.message()).not.toHaveProperty('start');
    expect(host.message()).not.toHaveProperty('subtitles');

    await backend.openStream('https://cdn/c.m3u8');
    expect(host.message()).not.toHaveProperty('start');
    expect(host.message()).not.toHaveProperty('subtitles');
  });

  // The host reads no message over MaxMessageBytes: it quit without a word, and the
  // hand-off failed with "is the host installed?" (#151). Firefox sends the JSON as UTF-8.
  it('keeps the message under the host\'s limit, leaving out subtitles that do not fit', async () => {
    expect(HostMaxMessageBytes).toBe(MaxMessageBytes);
    const host = captureNativeHost();
    const backend = new MpvBackend();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // About 55 bytes per cue once in JSON, one of them past ASCII.
    const srtOf = (cues) => Array.from({length: cues}, (_, i) =>
      `${i + 1}\n00:00:01,000 --> 00:00:02,000\nLine ${i} ${String.fromCodePoint(0xFC)}\n\n`).join('');
    const bytes = (message) => new TextEncoder().encode(JSON.stringify(message)).length;

    // Each of the first three fits alone, the third no longer does after two; the small
    // fourth still does.
    const big = srtOf(7000);
    await backend.openStream('https://cdn/a.m3u8', undefined, [{name: 'Referer', value: 'https://site.test/'}],
        'anime', 'https://site.test/ep-1', 'Title', {subtitles: [
          {label: 'one', srt: big}, {label: 'two', srt: big}, {label: 'three', srt: big}, {label: 'four', srt: srtOf(10)},
        ]});
    expect(host.message().subtitles.map((s) => s.label)).toEqual(['one', 'two', 'four']);
    expect(bytes(host.message())).toBeLessThanOrEqual(HostMaxMessageBytes);
    expect(host.message().headers).toEqual([{name: 'Referer', value: 'https://site.test/'}]);

    // One that never fits: the stream goes without it.
    await backend.openStream('https://cdn/b.m3u8', undefined, undefined, 'anime', undefined, undefined,
        {subtitles: [{label: 'huge', srt: srtOf(25000)}]});
    expect(host.message().url).toBe('https://cdn/b.m3u8');
    expect(host.message()).not.toHaveProperty('subtitles');
  });
});

// The options page's "Test mpv connection" button: a ping that asks the host to find mpv.

describe('testConnection', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  /**
   * Installs a fake native host that answers a ping.
   * @param {function(Object): *} answer - The reply to a message, or a throw.
   * @return {{sent: () => Array<{name: string, message: Object}>}} What it was sent.
   */
  function pingHost(answer) {
    const sent = [];
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          sent.push({name, message});
          callback(answer(message));
        },
      },
    };
    return {sent: () => sent};
  }

  it('pings the host with the mpv path set in the options, and reports where mpv is', async () => {
    const host = pingHost(() => ({ok: true, mpv: true, path: 'D:/tools/mpv.exe', hostVersion: RequiredHostVersion}));
    const backend = new MpvBackend();
    backend.mpvPath = 'D:/tools/mpv.exe';
    expect(await backend.testConnection()).toEqual({ok: true, mpv: true, path: 'D:/tools/mpv.exe'});
    expect(host.sent()).toEqual([{name: 'com.faststream.mpv', message: {type: 'ping', mpvPath: 'D:/tools/mpv.exe'}}]);
  });

  it('sends no path when none is set, and says so when the host finds no mpv', async () => {
    const host = pingHost(() => ({ok: true, mpv: false, hostVersion: RequiredHostVersion}));
    expect(await new MpvBackend().testConnection()).toEqual({ok: true, mpv: false, path: undefined});
    expect(host.sent()[0].message).toEqual({type: 'ping'});
  });

  it('reports the host as unreachable when the browser could not start it', async () => {
    stubNativeHost(undefined, {message: 'no such native application'});
    expect(await new MpvBackend().testConnection()).toEqual({ok: false, error: 'no such native application'});
  });

  it('reports a throw from the browser instead of rejecting', async () => {
    globalThis.chrome = {
      runtime: {
        sendNativeMessage() {
          throw new Error('nativeMessaging permission missing');
        },
      },
    };
    expect(await new MpvBackend().testConnection())
        .toEqual({ok: false, error: 'Error: nativeMessaging permission missing'});
  });
});
