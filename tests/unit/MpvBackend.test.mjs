import crypto from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {HostMaxMessageBytes, MaxPlayTargetChars, MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
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

// What the thin helper (host 15) adds to every answer.
const Thin = {hostVersion: 15, capabilities: ['play', 'ipc', 'relay']};
// What a helper before it answers the thin helper's messages.
const Unknown = {ok: false, error: 'unknown message', hostVersion: 14};
const ThinMessages = ['play', 'ipc', 'relay'];

/**
 * Installs a fake chrome.runtime whose sendNativeMessage replies with a fixed
 * response, and reports how many times it was called.
 * @param {Object|null} response - Reply handed to the callback.
 * @param {Object} [lastError] - chrome.runtime.lastError to simulate.
 * @param {{thin?: boolean}} [kind] - thin: the thin helper (host 15), whose answers name its
 *   capabilities; else a helper before it, which answers "unknown message" to the thin
 *   helper's messages (not counted: it does nothing with them).
 * @return {{calls: () => number, sent: () => Array<Object>}} Call counter, and every message.
 */
function stubNativeHost(response, lastError, {thin = false} = {}) {
  let calls = 0;
  const sent = [];
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(name, message, callback) {
        sent.push(message);
        globalThis.chrome.runtime.lastError = lastError;
        if (!lastError && !thin && ThinMessages.includes(message.type)) {
          callback({...Unknown});
        } else {
          calls++;
          callback(thin && response ? {...Thin, ...response} : response);
        }
        globalThis.chrome.runtime.lastError = undefined;
      },
    },
  };
  return {calls: () => calls, sent: () => sent};
}

describe.each([['an older helper', false], ['the thin helper', true]])('openStream retry bookkeeping, %s', (what, thin) => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  const stubNativeHostOfKind = (response, lastError) => stubNativeHost(response, lastError, {thin});

  it('sends the stream as the helper knows it', async () => {
    const host = stubNativeHostOfKind({ok: true, hostVersion: RequiredHostVersion});
    await new MpvBackend().openStream('https://cdn/a.m3u8');
    expect(host.sent().at(-1).type).toBe(thin ? 'play' : 'open');
  });

  it('does not resend a URL the host already accepted', async () => {
    const host = stubNativeHostOfKind({ok: true, hostVersion: RequiredHostVersion});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true});
    expect(await backend.openStream('https://cdn/a.m3u8', tab)).toEqual({ok: true});
    expect(host.calls()).toBe(1);
  });

  it('lets the same URL be retried after the host reports a launch failure', async () => {
    const host = stubNativeHostOfKind({ok: false, error: 'mpv executable not found'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    const first = await backend.openStream('https://cdn/a.m3u8', tab);
    expect(first.ok).toBe(false);
    expect(tab.mpvSentUrls.has('https://cdn/a.m3u8')).toBe(false);

    const second = await backend.openStream('https://cdn/a.m3u8', tab);
    expect(second.ok).toBe(false);
    expect(host.calls()).toBe(2);
  });

  it('gives a send made while the same one is on its way that one\'s answer', async () => {
    // It was told "ok" at once: the first then failed, and the player said it was sent to
    // mpv and paused the page for nothing (glm's look at a noted edge case, 2026-10-13).
    let answer;
    const streams = [];
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          if (!thin && message.type === 'play') {
            callback({...Unknown});
            return;
          }
          streams.push(message);
          answer = (response) => callback(thin ? {...Thin, ...response} : response);
        },
      },
    };
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};
    const first = backend.openStream('https://cdn/a.m3u8', tab);
    const second = backend.openStream('https://cdn/a.m3u8', tab);
    // The message is built first (the page's hash for mpv's resume key is async).
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion});
    expect(await first).toEqual({ok: false, error: 'mpv executable not found'});
    expect(await second).toEqual({ok: false, error: 'mpv executable not found'});
    expect(streams).toHaveLength(1);
    // And it can be tried again.
    answer = null;
    const third = backend.openStream('https://cdn/a.m3u8', tab);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer({ok: true, hostVersion: RequiredHostVersion});
    expect(await third).toEqual({ok: true});
    expect(streams).toHaveLength(2);
  });

  it('lets the same URL be retried when the host is not installed', async () => {
    const host = stubNativeHostOfKind(undefined, {message: 'no such native application'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    await backend.openStream('https://cdn/a.m3u8', tab);
    await backend.openStream('https://cdn/a.m3u8', tab);
    expect(host.calls()).toBe(2);
  });

  // The player and the toolbar show the host's own reason, and "is the host
  // installed?" only when the host itself could not be reached.
  it('says when the host itself could not be reached', async () => {
    stubNativeHostOfKind(undefined, {message: 'no such native application'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'no such native application', noHost: true});
  });

  it('passes the host\'s own reason on, without noHost', async () => {
    stubNativeHostOfKind({ok: false, error: 'mpv executable not found', hostVersion: RequiredHostVersion});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'mpv executable not found'});
  });

  // The host says how raising mpv's window went (host version 3): the result passes it
  // on, so the background can log an mpv that opened behind the browser (2026-10-04).
  it('passes on how raising mpv\'s window went, as the host sent it', async () => {
    stubNativeHostOfKind({ok: true, hostVersion: RequiredHostVersion, focus: 'True', foreground: 'False', reused: true});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toStrictEqual({ok: true, focus: 'True', foreground: 'False', reused: true});
    stubNativeHostOfKind({ok: true, hostVersion: RequiredHostVersion, focus: 'nowindow'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toStrictEqual({ok: true, focus: 'nowindow'});
  });

  it('passes on only fields of the expected type', async () => {
    stubNativeHostOfKind({ok: true, hostVersion: RequiredHostVersion, focus: 5, foreground: {x: 1}, reused: 'yes'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toStrictEqual({ok: true});
  });
});

// contentType is the MPV allowlist tag or the player's manual anime/movie
// override, threaded through to the native host message so it can append
// the #fs-content= marker gpu-toggles.lua reads on the mpv side.
// These are the open message a helper before host 15 gets; the thin helper's play message
// is built from the same (MpvTarget.test.mjs, and 'the thin helper' below).

describe('openStream contentType', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  /**
   * Installs a fake native host from before host 15 that captures the open message it was
   * sent (it answers the thin helper's play message "unknown message").
   * @return {{message: () => Object}} The most recent message sent.
   */
  function captureNativeHost() {
    let lastMessage;
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          if (message.type === 'play') {
            callback({...Unknown});
            return;
          }
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

  it('cuts a title and a subtitle label between whole characters (#470)', async () => {
    // Cut in the middle of an emoji, a lone half of it reached mpv, which drew it as a broken
    // character at the end of the title or the track's name.
    const host = captureNativeHost();
    const backend = new MpvBackend();
    const clapper = '\u{1F3AC}';
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello';
    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', 'https://site/ep-3',
        'x'.repeat(299) + clapper + 'tail', {subtitles: [{label: 'y'.repeat(99) + clapper + 'tail', srt}]});
    expect(host.message().title).toBe('x'.repeat(299) + clapper);
    expect(host.message().subtitles[0].label).toBe('y'.repeat(99) + clapper);
  });

  it('cuts a title and a subtitle label between whole characters as read', async () => {
    // A flag is two code points: cut between them, one letter of it reached mpv (glm's review
    // of #470's fix, 2026-10-13).
    const host = captureNativeHost();
    const backend = new MpvBackend();
    const flag = '\u{1F1E9}\u{1F1EA}';
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello';
    await backend.openStream('https://cdn/a.m3u8', undefined, undefined, 'anime', 'https://site/ep-3',
        'x'.repeat(299) + flag + 'tail', {subtitles: [{label: 'y'.repeat(99) + flag + 'tail', srt}]});
    expect(host.message().title).toBe('x'.repeat(299) + flag);
    expect(host.message().subtitles[0].label).toBe('y'.repeat(99) + flag);
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

  it('sends nothing, and says why, when the stream\'s address alone is over the host\'s limit', async () => {
    // The host quit unread, and the hand-off said the helper was not installed (glm's review,
    // 2026-10-13). Firefox takes URLs up to 1 MB.
    const host = captureNativeHost();
    const backend = new MpvBackend();
    // Known as a helper before host 15 (its answer names no capabilities): the open message.
    await backend.testConnection();
    expect(backend.capabilities).toEqual([]);
    const ping = host.message();
    const tab = {mpvSentUrls: new Set()};
    const url = 'https://cdn/a.m3u8?pad=' + 'x'.repeat(HostMaxMessageBytes);
    const result = await backend.openStream(url, tab);
    expect(host.message()).toBe(ping);
    // (This fake answers as a host from before versions: hostOutdated too.)
    expect(result).toMatchObject({ok: false, error: 'the stream\'s address is too long to send to mpv'});
    // Not recorded as sent: nothing went.
    expect(tab.mpvSentUrls.has(url)).toBe(false);
  });
});

// The thin helper (host 15, 2026-10-13): the extension builds what mpv gets (MpvTarget.mjs)
// and sends it as a play message; a helper before it answers "unknown message", and gets the
// open message from then on. What the helper can do is remembered from every answer.
describe('the thin helper', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello';
  const PAGE = 'https://site.test/ep-1';
  const fsId = (page) => crypto.createHash('sha256').update(page).digest('hex').slice(0, 16);

  /**
   * A fake helper: its answer to each message (by default the thin helper's ok), and what it
   * was sent.
   * @param {function(Object): *} [answer]
   * @return {Array<Object>} The messages.
   */
  function helper(answer = () => ({ok: true, ...Thin})) {
    const sent = [];
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, message, callback) {
      sent.push(message);
      callback(answer(message));
    }}};
    return sent;
  }

  it('sends a play message with mpv\'s target, title, start, headers and subtitles built here', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    backend.mpvPath = 'D:/tools/mpv.exe';
    const result = await backend.openStream('https://cdn.test/a.m3u8', undefined,
        [{name: 'Referer', value: 'https://site.test/'}, {name: 'Cookie', value: 'secret'},
          {name: 'User-Agent', value: 'Mozilla/5.0 (X11; Linux x86_64)'}],
        'anime', PAGE, '  Show - Episode 1 ', {startTime: 754.5, subtitles: [{label: 'English', srt: SRT}, {srt: ' '}],
          qualities: [{url: 'https://cdn.test/1080.mp4', label: '1080p', height: 1080}, {url: 'https://cdn.test/720.mp4', label: '720p', height: 720}]});
    expect(result).toEqual({ok: true});
    const qualities = encodeURIComponent(JSON.stringify([{label: '1080p', height: 1080, url: 'https://cdn.test/1080.mp4'},
      {label: '720p', height: 720, url: 'https://cdn.test/720.mp4'}]));
    // Exactly the protocol's fields: the options page's mpv path as in the open message, no
    // single-instance flag (one window is the default; newWindow asks for another).
    expect(sent).toStrictEqual([{
      type: 'play',
      target: `https://cdn.test/a.m3u8#fs-content=anime&fs-id=${fsId(PAGE)}&fs-page=${encodeURIComponent(PAGE)}&fs-quality=${qualities}`,
      title: 'Show - Episode 1',
      start: '754.5',
      headers: ['Referer: https://site.test/', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)'],
      mpvPath: 'D:/tools/mpv.exe',
      subtitles: [{label: 'English', srt: SRT}],
    }]);
  });

  it('names the stream\'s host without a title, asks for fullscreen and a window of its own as set', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    backend.fullscreen = true;
    backend.singleInstance = false;
    await backend.openStream('https://CDN.test/a.mp4');
    // No mpv path set: none sent.
    expect(sent).toStrictEqual([{type: 'play', target: 'https://cdn.test/a.mp4', title: 'cdn.test', fullscreen: true, newWindow: true}]);
  });

  it('leaves out what the helper would refuse the whole message for', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    // A header field ending in a backslash (mpv joined the next one to it), a title over
    // 1000 units (a letter with a pile of combining marks is one character of 200).
    const heavy = 'e' + String.fromCharCode(0x301).repeat(20);
    await backend.openStream('https://cdn.test/a.mp4', undefined,
        [{name: 'Referer', value: 'https://site.test/\\'}, {name: 'Origin', value: 'https://site.test'}],
        undefined, undefined, heavy.repeat(100), {startTime: 0.5});
    expect(sent[0].headers).toEqual(['Origin: https://site.test']);
    expect(sent[0].title).toBe(heavy.repeat(47));
    expect(sent[0]).not.toHaveProperty('start');
  });

  it('drops the page\'s qualities from a target too long for the helper, then sends nothing', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    const qualities = Array.from({length: 12}, (_, i) => ({url: `https://cdn.test/${i}.mp4?` + '%41'.repeat(600), label: `${i}`, height: i + 1}));
    const fits = 'https://cdn.test/a.mp4?pad=' + 'x'.repeat(MaxPlayTargetChars - 100);
    expect((await backend.openStream(fits, undefined, undefined, undefined, undefined, undefined, {qualities})).ok).toBe(true);
    expect(sent[0].target).toBe(fits);
    const tab = {mpvSentUrls: new Set()};
    const tooLong = fits + 'x'.repeat(200);
    expect(await backend.openStream(tooLong, tab)).toEqual({ok: false, error: 'the stream\'s address is too long to send to mpv'});
    expect(sent).toHaveLength(1);
    expect(tab.mpvSentUrls.has(tooLong)).toBe(false);
  });

  it('keeps a play message under the host\'s limit, leaving out subtitles that do not fit', async () => {
    const sent = helper();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const srtOf = (cues) => Array.from({length: cues}, (_, i) =>
      `${i + 1}\n00:00:01,000 --> 00:00:02,000\nLine ${i} ${String.fromCodePoint(0xFC)}\n\n`).join('');
    const big = srtOf(7000);
    await new MpvBackend().openStream('https://cdn.test/a.m3u8', undefined, undefined, undefined, PAGE, 'Title', {subtitles: [
      {label: 'one', srt: big}, {label: 'two', srt: big}, {label: 'three', srt: big}, {label: 'four', srt: srtOf(10)},
    ]});
    expect(sent[0].subtitles.map((s) => s.label)).toEqual(['one', 'two', 'four']);
    expect(new TextEncoder().encode(JSON.stringify(sent[0])).length).toBeLessThanOrEqual(HostMaxMessageBytes);
  });

  it('sends an older helper\'s answer of "unknown message" the open message, and that from then on', async () => {
    const sent = helper((message) => message.type === 'play' ? {...Unknown} : {ok: true, hostVersion: 14, focus: 'True'});
    const backend = new MpvBackend();
    backend.mpvPath = 'D:/tools/mpv.exe';
    const tab = {mpvSentUrls: new Set()};
    // (Outdated or not, by RequiredHostVersion: the open's answer says, as before.)
    expect(await backend.openStream('https://cdn.test/a.m3u8', tab, [{name: 'Referer', value: 'https://site.test/'}],
        'movie', PAGE, 'Title', {startTime: 12})).toMatchObject({ok: true, focus: 'True'});
    expect(sent.map((m) => m.type)).toEqual(['play', 'open']);
    expect(sent[1]).toStrictEqual({type: 'open', url: 'https://cdn.test/a.m3u8', contentType: 'movie', pageUrl: PAGE,
      title: 'Title', start: 12, mpvPath: 'D:/tools/mpv.exe', singleInstance: true,
      headers: [{name: 'Referer', value: 'https://site.test/'}]});
    expect(backend.capabilities).toEqual([]);
    await backend.openStream('https://cdn.test/b.m3u8', tab);
    expect(sent.map((m) => m.type)).toEqual(['play', 'open', 'open']);
  });

  it('remembers what the helper can do from any answer, and notices one installed again', async () => {
    // A ping of the thin helper: the stream goes as a play message at once.
    let thin = true;
    const sent = helper(() => thin ? {ok: true, mpv: true, ...Thin} : {ok: true, mpv: true, hostVersion: 14});
    const backend = new MpvBackend();
    await backend.testConnection();
    expect(backend.capabilities).toEqual(['play', 'ipc', 'relay']);
    await backend.openStream('https://cdn.test/a.m3u8');
    expect(sent.map((m) => m.type)).toEqual(['ping', 'play']);
    // An older helper's ping (no capabilities): the open message at once.
    thin = false;
    await backend.testConnection();
    expect(backend.capabilities).toEqual([]);
    await backend.openStream('https://cdn.test/b.m3u8');
    expect(sent.map((m) => m.type)).toEqual(['ping', 'play', 'ping', 'open']);
    // The thin helper installed meanwhile: its answer to that open names its capabilities.
    thin = true;
    await backend.openStream('https://cdn.test/c.m3u8');
    await backend.openStream('https://cdn.test/d.m3u8');
    expect(sent.map((m) => m.type)).toEqual(['ping', 'play', 'ping', 'open', 'open', 'play']);
  });

  it('passes on the helper\'s own refusal of a play message, without trying the open message', async () => {
    const sent = helper(() => ({ok: false, error: 'unknown message', ...Thin}));
    expect(await new MpvBackend().openStream('https://cdn.test/a.m3u8')).toEqual({ok: false, error: 'unknown message'});
    expect(sent.map((m) => m.type)).toEqual(['play']);
    const refused = helper(() => ({ok: false, error: 'headers refused', ...Thin}));
    expect(await new MpvBackend().openStream('https://cdn.test/a.m3u8')).toEqual({ok: false, error: 'headers refused'});
    expect(refused.map((m) => m.type)).toEqual(['play']);
  });

  it('says a helper that is not installed is not, with no second try', async () => {
    const sent = [];
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, message, callback) {
      sent.push(message);
      globalThis.chrome.runtime.lastError = {message: 'no such native application'};
      callback(undefined);
      globalThis.chrome.runtime.lastError = undefined;
    }}};
    const backend = new MpvBackend();
    expect(await backend.openStream('https://cdn.test/a.m3u8'))
        .toEqual({ok: false, error: 'no such native application', noHost: true});
    expect(sent.map((m) => m.type)).toEqual(['play']);
    // Nothing learned: still unknown.
    expect(backend.capabilities).toBe(null);
  });

  it('answers a send whose message could not be built, and lets it be sent again', async () => {
    const sent = helper();
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValueOnce(new Error('no digest'));
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};
    expect(await backend.openStream('https://cdn.test/a.m3u8', tab, undefined, undefined, PAGE))
        .toEqual({ok: false, error: 'Error: no digest'});
    expect(tab.mpvSentUrls.size).toBe(0);
    expect(tab.mpvSending.size).toBe(0);
    expect((await backend.openStream('https://cdn.test/a.m3u8', tab, undefined, undefined, PAGE)).ok).toBe(true);
    expect(sent).toHaveLength(1);
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

// The page's qualities as the host gets them. The host checks the list again
// (qualityFragmentFor), but only once the whole message has arrived: what makes the message
// too big has to go here.
describe('relayQualities', () => {
  const entry = (height) => ({url: `https://h.test/${height}.mp4`, label: `${height}p`, height});

  it('takes no file longer than 2048 characters', () => {
    const origin = 'https://h.test/';
    const long = {url: origin + 'a'.repeat(2049 - origin.length), label: 'long', height: 720};
    expect(MpvBackend.relayQualities([long, entry(360)])).toBeNull();
    const longest = {...long, url: long.url.slice(0, 2048)};
    expect(MpvBackend.relayQualities([longest, entry(360)]).map((q) => q.url))
        .toEqual([longest.url, entry(360).url]);
  });

  it('cuts a label between characters', () => {
    // The 40th character an emoji (two UTF-16 units): whole, not half of it.
    const clapper = String.fromCodePoint(0x1F3AC);
    const [first] = MpvBackend.relayQualities([{...entry(1080), label: 'x'.repeat(39) + clapper + 'tail'}, entry(720)]);
    expect(first.label).toBe('x'.repeat(39) + clapper);
  });

  it('takes http(s) files only, at most 12, and no list of fewer than two', () => {
    const many = Array.from({length: 13}, (_, i) => entry(100 + i));
    expect(MpvBackend.relayQualities(many)).toHaveLength(12);
    expect(MpvBackend.relayQualities([entry(720), {url: 'file:///C:/x.mp4', label: 'x', height: 1}])).toBeNull();
    expect(MpvBackend.relayQualities([entry(720)])).toBeNull();
    expect(MpvBackend.relayQualities('not a list')).toBeNull();
  });
});
