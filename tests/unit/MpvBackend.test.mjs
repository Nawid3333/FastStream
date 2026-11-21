import crypto from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {HostMaxMessageBytes, MaxPlayTargetChars, MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';
import {MaxMessageBytes, checkPlayMessage} from '../../native-host/faststream-mpv-host.mjs';

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

// What the helper adds to every answer.
const Current = {hostVersion: RequiredHostVersion};

/**
 * Installs a fake chrome.runtime whose sendNativeMessage replies with a fixed
 * response, the current helper's version added, and counts the streams it was sent.
 * @param {Object|null} response - Reply handed to the callback.
 * @param {Object} [lastError] - chrome.runtime.lastError to simulate.
 * @return {{calls: () => number, sent: () => Array<Object>}} The play messages it got, and every message.
 */
function stubNativeHost(response, lastError) {
  const sent = [];
  globalThis.chrome = {
    runtime: {
      lastError: undefined,
      sendNativeMessage(name, message, callback) {
        sent.push(message);
        globalThis.chrome.runtime.lastError = lastError;
        callback(response && typeof response === 'object' && !('hostVersion' in response) ? {...response, ...Current} : response);
        globalThis.chrome.runtime.lastError = undefined;
      },
    },
  };
  return {calls: () => sent.filter((m) => m.type === 'play').length, sent: () => sent};
}

describe('openStream retry bookkeeping', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it('sends the stream as a play message, once a ping found the helper current', async () => {
    const host = stubNativeHost({ok: true});
    const backend = new MpvBackend();
    await backend.openStream('https://cdn/a.m3u8');
    await backend.openStream('https://cdn/b.m3u8');
    expect(host.sent().map((m) => m.type)).toEqual(['ping', 'play', 'play']);
  });

  it('does not resend a URL the host already accepted', async () => {
    const host = stubNativeHost({ok: true});
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

  it('gives a send made while the same one is on its way that one\'s answer', async () => {
    // not "ok" at once: the player does not say sent nor pause the page while the first send may
    // fail
    let answer;
    const streams = [];
    globalThis.chrome = {
      runtime: {
        lastError: undefined,
        sendNativeMessage(name, message, callback) {
          if (message.type === 'ping') {
            callback({ok: true, ...Current});
            return;
          }
          streams.push(message);
          answer = callback;
        },
      },
    };
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};
    const first = backend.openStream('https://cdn/a.m3u8', tab);
    const second = backend.openStream('https://cdn/a.m3u8', tab);
    // The message is built first (the page's hash for mpv's resume key is async).
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer({ok: false, error: 'mpv executable not found', ...Current});
    expect(await first).toEqual({ok: false, error: 'mpv executable not found'});
    expect(await second).toEqual({ok: false, error: 'mpv executable not found'});
    expect(streams).toHaveLength(1);
    // And it can be tried again.
    answer = null;
    const third = backend.openStream('https://cdn/a.m3u8', tab);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    answer({ok: true, ...Current});
    expect(await third).toEqual({ok: true});
    expect(streams).toHaveLength(2);
  });

  it('drops a send that waited behind another when its page or MPV went meanwhile', async () => {
    // The user left the tab or turned MPV off while the first stream was still starting mpv: the second one opened in
    // mpv all the same.
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
    let stillWanted = true;
    const first = backend.openStream('https://cdn/a.m3u8', tab);
    const second = backend.openStream('https://cdn/b.m3u8', tab, undefined, undefined, undefined, undefined, {},
        () => stillWanted);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    stillWanted = false;
    answer({ok: true, hostVersion: RequiredHostVersion});
    expect(await first).toEqual({ok: true});
    expect(await second).toEqual({ok: false, dropped: true});
    expect(streams).toHaveLength(1);
    // Not recorded as sent: the same stream can go later.
    expect(tab.mpvSentUrls.has('https://cdn/b.m3u8')).toBe(false);
  });

  it('lets the same URL be retried when the host is not installed', async () => {
    const host = stubNativeHost(undefined, {message: 'no such native application'});
    const backend = new MpvBackend();
    const tab = {mpvSentUrls: new Set()};

    await backend.openStream('https://cdn/a.m3u8', tab);
    await backend.openStream('https://cdn/a.m3u8', tab);
    // A ping each time: nothing was learned of the helper.
    expect(host.sent().map((m) => m.type)).toEqual(['ping', 'ping']);
    expect(tab.mpvSentUrls.size).toBe(0);
  });

  // The player and the toolbar show the host's own reason, and "is the host
  // installed?" only when the host itself could not be reached.
  it('says when the host itself could not be reached', async () => {
    stubNativeHost(undefined, {message: 'no such native application'});
    const backend = new MpvBackend();
    expect(await backend.openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'no such native application', noHost: true});
    // Nothing learned: still unknown.
    expect(backend.hostVersion).toBe(null);
  });

  it('passes the host\'s own reason on, without noHost', async () => {
    stubNativeHost({ok: false, error: 'mpv executable not found'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toEqual({ok: false, error: 'mpv executable not found'});
  });

  // The host says how raising mpv's window went: the result passes it on, so the background can
  // log an mpv that opened behind the browser.
  it('passes on how raising mpv\'s window went, as the host sent it', async () => {
    stubNativeHost({ok: true, focus: 'True', foreground: 'False', reused: true});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8'))
        .toStrictEqual({ok: true, focus: 'True', foreground: 'False', reused: true});
    stubNativeHost({ok: true, focus: 'nowindow'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toStrictEqual({ok: true, focus: 'nowindow'});
  });

  it('passes on only fields of the expected type', async () => {
    stubNativeHost({ok: true, focus: 5, foreground: {x: 1}, reused: 'yes'});
    expect(await new MpvBackend().openStream('https://cdn/a.m3u8')).toStrictEqual({ok: true});
  });
});

// The extension builds what mpv gets (MpvTarget.mjs) and sends it as a play message.
describe('the play message', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello';
  const PAGE = 'https://site.test/ep-1';
  const fsId = (page) => crypto.createHash('sha256').update(page).digest('hex').slice(0, 16);

  /**
   * A fake helper: its answer to each message (by default the current helper's ok), and what it
   * was sent besides pings.
   * @param {function(Object): *} [answer]
   * @return {Array<Object>} The messages.
   */
  function helper(answer = () => ({ok: true, ...Current})) {
    const sent = [];
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, message, callback) {
      if (message.type === 'ping') {
        callback({ok: true, mpv: true, ...Current});
        return;
      }
      sent.push(message);
      callback(answer(message));
    }}};
    return sent;
  }

  it('carries mpv\'s target, title, start, headers and subtitles built here', async () => {
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
    // Exactly the protocol's fields: the options page's mpv path, no single-instance flag (one window is the default;
    // newWindow asks for another).
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

  it('tags the content type only for one mpv\'s scripts know, and an http(s) page only', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    await backend.openStream('https://cdn.test/a.m3u8', undefined, undefined, 'movie');
    await backend.openStream('https://cdn.test/b.m3u8', undefined, undefined, 'native');
    await backend.openStream('https://cdn.test/c.m3u8', undefined, undefined, 'documentary');
    await backend.openStream('https://cdn.test/d.m3u8', undefined, undefined, null, 'about:blank');
    await backend.openStream('https://cdn.test/e.m3u8', undefined, undefined, undefined, 'https://site.test/ep-3');
    expect(sent.map((m) => m.target)).toEqual([
      'https://cdn.test/a.m3u8#fs-content=movie',
      'https://cdn.test/b.m3u8#fs-content=native',
      'https://cdn.test/c.m3u8',
      'https://cdn.test/d.m3u8',
      `https://cdn.test/e.m3u8#fs-id=${fsId('https://site.test/ep-3')}&fs-page=${encodeURIComponent('https://site.test/ep-3')}`,
    ]);
  });

  it('names the tab\'s title, trimmed and bounded, else the stream\'s host', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    await backend.openStream('https://cdn.test/a.m3u8', undefined, undefined, undefined, PAGE, '  Show - Episode 3 ');
    await backend.openStream('https://cdn.test/b.m3u8', undefined, undefined, undefined, PAGE, 'x'.repeat(400));
    for (const none of [undefined, '', '   ', 42]) {
      await backend.openStream('https://cdn.test/c.m3u8?' + String(none), undefined, undefined, undefined, PAGE, none);
    }
    expect(sent.map((m) => m.title)).toEqual(['Show - Episode 3', 'x'.repeat(200), 'cdn.test', 'cdn.test', 'cdn.test', 'cdn.test']);
  });

  it('cuts a title and a subtitle label between whole characters (#470)', async () => {
    // Cut in the middle of an emoji, a lone half of it reached mpv, which drew it as a broken
    // character at the end of the title or the track's name. A flag is two code points: never
    // cut between them either.
    for (const whole of ['\u{1F3AC}', '\u{1F1E9}\u{1F1EA}']) {
      const sent = helper();
      await new MpvBackend().openStream('https://cdn.test/a.m3u8', undefined, undefined, 'anime', PAGE,
          'x'.repeat(199) + whole + 'tail', {subtitles: [{label: 'y'.repeat(99) + whole + 'tail', srt: SRT}]});
      expect(sent[0].title).toBe('x'.repeat(199) + whole);
      expect(sent[0].subtitles[0].label).toBe('y'.repeat(99) + whole);
    }
  });

  it('carries where the player was and its subtitles (the player\'s button)', async () => {
    const sent = helper();
    const backend = new MpvBackend();
    await backend.openStream('https://cdn.test/a.m3u8', undefined, undefined, 'anime', undefined, undefined,
        {startTime: 754.5, subtitles: [{label: 'English', srt: SRT}, {label: 'empty', srt: '  '}, {srt: 5}]});
    expect(sent[0].start).toBe('754.5');
    expect(sent[0].subtitles).toEqual([{label: 'English', srt: SRT}]);

    await backend.openStream('https://cdn.test/b.m3u8', undefined, undefined, 'anime', undefined, undefined,
        {startTime: 0.4, subtitles: []});
    await backend.openStream('https://cdn.test/c.m3u8');
    for (const message of sent.slice(1)) {
      expect(message).not.toHaveProperty('start');
      expect(message).not.toHaveProperty('subtitles');
    }
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

  it('plays in the mpv window named, and passes on the one it played in', async () => {
    const Window = '0123456789abcdef';
    let sent = helper(() => ({ok: true, ...Current, window: Window}));
    const backend = new MpvBackend();
    expect(await backend.openStream('https://cdn.test/a.mp4', undefined, undefined, undefined, undefined, undefined,
        {window: Window})).toEqual({ok: true, window: Window});
    expect(sent[0].window).toBe(Window);
    expect(checkPlayMessage(sent[0])).toMatchObject({ok: true, play: {window: Window}});
    // The one on its own pipe needs no name.
    sent = helper(() => ({ok: true, ...Current, window: ''}));
    expect(await backend.openStream('https://cdn.test/b.mp4', undefined, undefined, undefined, undefined, undefined,
        {window: ''})).toEqual({ok: true, window: ''});
    expect(sent[0]).not.toHaveProperty('window');
    // Gone: the helper started nothing.
    helper(() => ({ok: false, closed: true, error: 'that mpv window was closed', ...Current}));
    expect(await backend.openStream('https://cdn.test/c.mp4', undefined, undefined, undefined, undefined, undefined,
        {window: Window})).toEqual({ok: false, closed: true, error: 'that mpv window was closed'});
    // A window per stream (the option) asks for a new one, never a named one.
    sent = helper(() => ({ok: true, ...Current, window: 'fedcba9876543210'}));
    backend.singleInstance = false;
    expect(await backend.openStream('https://cdn.test/e.mp4', undefined, undefined, undefined, undefined, undefined,
        {window: Window})).toEqual({ok: true, window: 'fedcba9876543210'});
    expect(sent[0]).toMatchObject({newWindow: true});
    expect(sent[0]).not.toHaveProperty('window');
    // An answer no helper gives names none.
    helper(() => ({ok: true, ...Current, window: '../other-pipe'}));
    expect(await backend.openStream('https://cdn.test/f.mp4')).toEqual({ok: true});
  });

  it('starts a new window that waits paused, not fullscreen', async () => {
    let sent = helper(() => ({ok: true, ...Current, window: 'fedcba9876543210'}));
    const backend = new MpvBackend();
    backend.fullscreen = true;
    expect(await backend.openStream('https://cdn.test/a.mp4', undefined, undefined, undefined, undefined, undefined,
        {newWindow: true, paused: true})).toEqual({ok: true, window: 'fedcba9876543210'});
    expect(sent[0]).toMatchObject({newWindow: true, paused: true});
    expect(sent[0]).not.toHaveProperty('fullscreen');
    expect(checkPlayMessage(sent[0])).toMatchObject({ok: true, play: {newWindow: true, paused: true, fullscreen: false}});
    // Not paused: as the option asks.
    sent = helper(() => ({ok: true, ...Current, window: 'fedcba9876543210'}));
    await backend.openStream('https://cdn.test/b.mp4', undefined, undefined, undefined, undefined, undefined,
        {newWindow: true});
    expect(sent[0]).toMatchObject({newWindow: true, fullscreen: true});
    expect(sent[0]).not.toHaveProperty('paused');
    expect(checkPlayMessage(sent[0]).ok).toBe(true);
  });

  it('raises a window', async () => {
    const sent = helper(() => ({ok: true, ...Current}));
    const backend = new MpvBackend();
    await backend.raise('0123456789abcdef');
    await backend.raise('');
    expect(sent).toEqual([{type: 'raise', window: '0123456789abcdef'}, {type: 'raise'}]);
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

  // The host reads no message over its MaxMessageBytes (it answers with an error, and nothing
  // plays). Firefox sends the JSON as UTF-8.
  it('keeps a play message under the host\'s limit, leaving out subtitles that do not fit', async () => {
    expect(HostMaxMessageBytes).toBe(MaxMessageBytes);
    const sent = helper();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Three bytes a character in UTF-8: five of these fit, a sixth no longer does; a small one still does.
    const srtOf = (chars) => '1\n00:00:01,000 --> 00:00:02,000\n' + '\u4E2D'.repeat(chars);
    const big = srtOf(1000000);
    await new MpvBackend().openStream('https://cdn.test/a.m3u8', undefined, undefined, undefined, PAGE, 'Title', {subtitles: [
      ...['one', 'two', 'three', 'four', 'five', 'six'].map((label) => ({label, srt: big})), {label: 'small', srt: srtOf(10)},
    ]});
    expect(sent[0].subtitles.map((s) => s.label)).toEqual(['one', 'two', 'three', 'four', 'five', 'small']);
    expect(new TextEncoder().encode(JSON.stringify(sent[0])).length).toBeLessThanOrEqual(HostMaxMessageBytes);
    expect(console.warn).toHaveBeenCalledWith('A subtitle track (six) is too large to send to mpv, left out');
  });

  // A track may be 1,048,576 units (the helper's MaxSubtitleChars): the helper refuses the whole play for a longer one.
  it('leaves out a subtitle track longer than the helper takes', async () => {
    const sent = helper();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hls = {files: [{name: '0.m3u8', text: '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nhttps://cdn.test/s0.ts\n#EXT-X-ENDLIST\n'}]};
    const cue = '1\n00:00:01,000 --> 00:00:02,000\n';
    const longest = cue + 'x'.repeat(1024 * 1024 - cue.length);
    await new MpvBackend().openStream('https://cdn.test/pl/7?token=k', undefined, undefined, undefined, PAGE, 'Title',
        {hls, subtitles: [{label: 'too long', srt: longest + 'x'}, {label: 'longest', srt: longest}, {label: 'English', srt: SRT}]});
    expect(sent[0].hls).toEqual(hls);
    expect(sent[0].subtitles.map((s) => s.label)).toEqual(['longest', 'English']);
    expect(console.warn).toHaveBeenCalledWith('A subtitle track (too long) is too large to send to mpv, left out');
    // The helper's own check of what was sent.
    expect(checkPlayMessage(sent[0])).toMatchObject({ok: true});
  });

  it('passes on the helper\'s own refusal of a play message, with no second try', async () => {
    const sent = helper(() => ({ok: false, error: 'headers refused', ...Current}));
    expect(await new MpvBackend().openStream('https://cdn.test/a.m3u8')).toEqual({ok: false, error: 'headers refused'});
    expect(sent.map((m) => m.type)).toEqual(['play']);
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
    // A send too, with no stream: the ping before it threw.
    expect(await new MpvBackend().openStream('https://cdn.test/a.m3u8'))
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

describe('streams sent at once', () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.restoreAllMocks();
  });

  it('go one after the other, the next once the last has its answer', async () => {
    // Two helper processes at once with no mpv running start one mpv, not two on the same pipe.
    const sent = [];
    const answers = [];
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, message, callback) {
      if (message.type === 'ping') {
        callback({ok: true, ...Current});
        return;
      }
      sent.push(message);
      answers.push(() => callback({ok: true, ...Current}));
    }}};
    const backend = new MpvBackend();
    const a = backend.openStream('https://cdn.test/a.m3u8');
    const b = backend.openStream('https://cdn.test/b.m3u8');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    answers[0]();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    answers[1]();
    expect(await a).toMatchObject({ok: true});
    expect(await b).toMatchObject({ok: true});
  });
});
