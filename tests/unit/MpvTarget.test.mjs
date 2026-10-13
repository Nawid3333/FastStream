import crypto from 'node:crypto';
import {afterEach, describe, expect, it} from 'vitest';
import fc from 'fast-check';

import * as Host from '../../native-host/faststream-mpv-host.mjs';
import * as Target from '../../chrome/background/MpvTarget.mjs';
import {MaxPlayTargetChars, MaxPlayTitleChars, MpvBackend} from '../../chrome/background/MpvBackend.mjs';

// The thin helper (host 15, 2026-10-13): what mpv is given for a stream is built in the
// extension now (MpvTarget.mjs), no longer in the helper, so a change to it needs no helper
// reinstall. mpv's scripts read what the helper built until host 14 (stream-resume.lua keeps
// positions under the fs-id), so the extension's builders must give the same, byte for byte:
// each is checked here against the helper's own function of the same name.

const ch = (...codes) => String.fromCodePoint(...codes);
const CLAPPER = ch(0x1F3AC);
const FLAG = ch(0x1F1E9, 0x1F1EA);
const FAMILY = ch(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
const E_ACUTE = ch(0xE9);
const LONE = String.fromCharCode(0xD800);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const DEL = String.fromCharCode(127);
const NEL = String.fromCharCode(0x85);
const NBSP = String.fromCharCode(0xA0);
const BACKSLASH = String.fromCharCode(92);

const STREAMS = [
  'https://cdn.test/a.m3u8',
  'https://cdn.test/a.m3u8?token=abc,def&x=1',
  'https://cdn.test/a.m3u8#',
  'https://cdn.test/a.m3u8#t=10',
  'https://cdn.test/a.m3u8#fs-id=forged',
  'https://cdn.test/a.m3u8#t=10&fs-id=forged&FS-PAGE=x&fs-quality=y',
  'https://cdn.test/a.m3u8#fs-content=anime&fs-',
  'https://cdn.test/a.m3u8#&&fs-id=1&',
  'https://cdn.test/a#b#fs-id=1',
  'https://CDN.Test:8443/Path/A.m3u8',
  'https://cdn.test/a b.m3u8',
  'https://cdn.test/a' + TAB + 'b' + LF + '.m3u8',
  'https://cdn.test/' + E_ACUTE + 'pisode.m3u8?q=' + E_ACUTE + '#' + E_ACUTE,
  'https://b' + ch(0xFC) + 'cher.test/a.mp4',
  'https://user:pass@cdn.test/a.mp4',
  'http://cdn.test/a.mp4#%20x',
  'HTTPS://cdn.test/upper-scheme.mp4',
];

const PAGES = [
  undefined, '', 42, 'about:blank', 'ftp://site.test/', 'moz-extension://x/player.html',
  'https://site.test/ep-1',
  'HTTP://Site.test/Ep?x=1&y=2#frag',
  'https://site.test/' + CLAPPER + FLAG + '/' + E_ACUTE,
  'https://site.test/' + LONE + '/lone-surrogate',
  'https://site.test/a b?c=d e',
  'https://site.test/' + 'p'.repeat(3000),
];

const CONTENT_TYPES = [undefined, 'anime', 'movie', 'Anime', 'documentary', null];

const quality = (height, extra = {}) => ({url: `https://h.test/${height}.mp4`, label: `${height}p`, height, ...extra});
const QUALITY_LISTS = [
  undefined, 'not a list', [], [quality(720)],
  [quality(1080), quality(720)],
  [quality(1080, {label: 'Full' + TAB + 'HD' + LF + DEL + ' ' + CLAPPER}), quality(720, {label: '  ' + 'x'.repeat(39) + FLAG + 'tail'})],
  [quality(1080, {height: 1080.5}), quality(720, {height: -1}), quality(480, {height: 20000}), quality(360, {height: '360'})],
  [quality(1080, {url: 'file:///C:/x.mp4'}), quality(720, {url: 'https:' + BACKSLASH + BACKSLASH + 'host' + BACKSLASH + 'share'}),
    quality(480), quality(360, {url: 'https://h.test/360.mp4#frag'})],
  [quality(1080, {url: 'https://h.test/' + 'a'.repeat(2049 - 'https://h.test/'.length)}), quality(720),
    quality(480, {url: 'https://h.test/' + 'b'.repeat(2048 - 'https://h.test/'.length)})],
  [null, quality(1080, {label: 5}), quality(720, {label: undefined}), quality(480, {url: 'https://H.TEST/a b%2C.mp4'})],
  Array.from({length: 13}, (_, i) => quality(100 + i)),
];

const TITLES = [
  undefined, '', '   ', 42, null,
  'Show - Episode 3',
  ' a' + LF + 'b' + TAB + 'c  d ' + DEL + 'e' + NEL + 'f' + NBSP + 'g ',
  'x'.repeat(250),
  'x'.repeat(199) + CLAPPER + 'tail',
  'x'.repeat(199) + FLAG + 'tail',
  'x'.repeat(199) + FAMILY + 'tail',
  'e' + ch(0x301).repeat(50) + ' combining',
  LONE + ' lone',
  String.fromCharCode(0, 1, 31) + 'controls',
];

const HEADER_LISTS = [
  undefined, null, 'Referer: x', [],
  [{name: 'Referer', value: 'https://site.test/?list=a,b,,c'}, {name: 'Origin', value: 'https://site.test'},
    {name: 'User-Agent', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}],
  [{name: 'referer', value: 'https://site.test/'}, {name: 'REFERER', value: 'https://other.test/'}],
  [{name: 'Cookie', value: 'a=b'}, {name: 'Referer', value: 'https://site.test/' + E_ACUTE},
    {name: 'Origin', value: 'https://site.test' + LF + 'X: 1'}],
  [{name: 'Referer', value: 'https://site.test/' + BACKSLASH}, {name: 'User-Agent', value: 'UA'}],
  [{name: 'Referer', value: ''}, {name: 'Origin', value: 'o'.repeat(4097)}, {name: 'User-Agent', value: 'u'.repeat(4096)}],
  [null, {name: 5, value: 'x'}, {value: 'x'}, {name: 'Origin'}, {name: 'Origin', value: 7}],
];

const STARTS = [undefined, null, '754', 0, 0.999, 1, 1.0005, 2.3, 754.5, 1234567.8915, 1e7 - 0.0001, 1e7, -5, NaN, Infinity];

/**
 * What a function gives, or the kind of error it throws (both throw on a page URL with half
 * of a surrogate pair: encodeURIComponent cannot encode it).
 * @param {function(): *} fn
 * @return {Promise<*>}
 */
async function outcome(fn) {
  try {
    return {value: await fn()};
  } catch (e) {
    return {threw: e.name};
  }
}

describe('the builders, against the helper\'s own', () => {
  it('drop fs-* tags a stream URL brought', () => {
    for (const url of STREAMS) {
      expect(Target.withoutFsTags(url)).toBe(Host.withoutFsTags(url));
    }
  });

  it('tag the content type', () => {
    for (const url of STREAMS) {
      for (const type of CONTENT_TYPES) {
        expect(Target.withContentTypeFragment(url, type)).toBe(Host.withContentTypeFragment(url, type));
      }
    }
  });

  it('hash the page into the same resume key (fs-id), and encode it the same (fs-page)', async () => {
    for (const page of PAGES) {
      expect(await Target.resumeIdFor(page)).toBe(Host.resumeIdFor(page));
      expect(await outcome(() => Target.pageFragmentFor(page))).toEqual(await outcome(() => Host.pageFragmentFor(page)));
    }
    expect(await outcome(() => Target.pageFragmentFor(PAGES[9]))).toEqual({threw: 'URIError'});
    // The key itself: the first 16 hex digits of the page's SHA-256.
    expect(await Target.resumeIdFor('https://site.test/ep-1'))
        .toBe(crypto.createHash('sha256').update('https://site.test/ep-1').digest('hex').slice(0, 16));
  });

  it('list the page\'s qualities the same (fs-quality)', () => {
    for (const list of QUALITY_LISTS) {
      expect(Target.qualityFragmentFor(list)).toBe(Host.qualityFragmentFor(list));
    }
  });

  it('build the same target', async () => {
    for (const url of STREAMS) {
      for (const contentType of CONTENT_TYPES) {
        for (const pageUrl of PAGES) {
          const stream = {url, contentType, pageUrl, qualities: QUALITY_LISTS[5]};
          expect(await outcome(() => Target.mpvTargetUrl(stream))).toEqual(await outcome(() => Host.mpvTargetUrl(stream)));
        }
      }
      for (const qualities of QUALITY_LISTS) {
        const stream = {url, contentType: 'movie', pageUrl: PAGES[6], qualities};
        expect(await Target.mpvTargetUrl(stream)).toBe(Host.mpvTargetUrl(stream));
      }
    }
  });

  it('give the same title', () => {
    for (const url of ['https://cdn.test/a', 'https://CDN.TEST:8443/a', 'https://[::1]/a', 'not a url']) {
      for (const title of TITLES) {
        expect(Target.streamTitle({url, title})).toBe(Host.streamTitle({url, title}));
      }
    }
  });

  it('pick the same header fields', () => {
    for (const headers of HEADER_LISTS) {
      expect(Target.relayHeaderFields(headers)).toEqual(Host.relayHeaderFields(headers));
    }
  });

  it('start at the same place', () => {
    for (const start of STARTS) {
      expect(Target.startOf({start})).toBe(Host.startOf({start}));
    }
  });

  it('agree on what may go to mpv', () => {
    for (const url of [...STREAMS, 'file:///C:/x.mp4', 'https:' + BACKSLASH + BACKSLASH + 'h', 'ftp://x', 5, '', 'https://']) {
      expect(Target.isStreamUrl(url)).toBe(Host.isStreamUrl(url));
    }
  });

  describe('for any input (fast-check)', () => {
    const text = fc.string({unit: 'binary', maxLength: 80});
    const fragmentPart = fc.oneof(text, fc.constantFrom('fs-id=1', 'FS-page=x', 'fs-', 't=10', ''));
    const streamUrl = fc.tuple(text, fc.array(fragmentPart, {maxLength: 5}), fc.boolean())
        .map(([path, parts, hash]) => 'https://cdn.test/' + path + (hash ? '#' + parts.join('&') : ''))
        .filter((url) => Host.isStreamUrl(url));

    it('builds the same target', async () => {
      await fc.assert(fc.asyncProperty(streamUrl, fc.option(text), fc.constantFrom('anime', 'movie', undefined),
          async (url, page, contentType) => {
            const stream = {url, contentType, pageUrl: page === null ? undefined : 'https://site.test/' + page};
            expect(await Target.mpvTargetUrl(stream)).toBe(Host.mpvTargetUrl(stream));
          }), {numRuns: 300});
    });

    it('gives the same title and header fields', () => {
      fc.assert(fc.property(fc.string({unit: 'grapheme', maxLength: 260}), text, (title, value) => {
        expect(Target.streamTitle({url: 'https://cdn.test/a', title})).toBe(Host.streamTitle({url: 'https://cdn.test/a', title}));
        const headers = [{name: 'Referer', value}, {name: 'Origin', value: value + BACKSLASH}];
        expect(Target.relayHeaderFields(headers)).toEqual(Host.relayHeaderFields(headers));
      }), {numRuns: 300});
    });

    it('lists the same qualities', () => {
      const entry = fc.record({url: fc.oneof(text.map((t) => 'https://h.test/' + t), text), label: fc.oneof(text, fc.integer()),
        height: fc.oneof(fc.integer({min: -10, max: 20000}), fc.double())});
      fc.assert(fc.property(fc.array(entry, {maxLength: 14}), (list) => {
        expect(Target.qualityFragmentFor(list)).toBe(Host.qualityFragmentFor(list));
      }), {numRuns: 300});
    });
  });
});

describe('cutToLength', () => {
  it('keeps a text that fits, and cuts one that does not between whole characters', () => {
    expect(Target.cutToLength('abc', 3)).toBe('abc');
    // A flag is four UTF-16 units: whole, or not at all.
    expect(Target.cutToLength('ab' + FLAG, 5)).toBe('ab');
    expect(Target.cutToLength('ab' + FLAG, 6)).toBe('ab' + FLAG);
    expect(Target.cutToLength(('e' + ch(0x301).repeat(9)).repeat(3), 25)).toBe(('e' + ch(0x301).repeat(9)).repeat(2));
  });
});

// The same stream through both kinds of helper: the play message the thin one gets must make
// mpv see what the helper made of the open message an older one gets.
describe('a play message and an open message for the same stream', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  /**
   * Sends one stream through a fresh backend to a fake helper, and returns what it got.
   * @param {boolean} thin - The thin helper (host 15), or one before it.
   * @param {Array<*>} args - openStream's arguments.
   * @param {Object} [settings] - fullscreen, singleInstance, mpvPath.
   * @return {Promise<Object>} The message.
   */
  async function sent(thin, args, settings = {}) {
    let message;
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, m, callback) {
      message = m;
      callback(thin ? {ok: true, hostVersion: 15, capabilities: ['play', 'ipc', 'relay']} : {ok: true, hostVersion: 14});
    }}};
    const backend = Object.assign(new MpvBackend(), settings);
    // What each helper is, known from an answer before.
    backend.capabilities = thin ? ['play', 'ipc', 'relay'] : [];
    expect((await backend.openStream(...args)).ok).toBe(true);
    expect(message.type).toBe(thin ? 'play' : 'open');
    return message;
  }

  const SRT = '1' + LF + '00:00:01,000 --> 00:00:02,000' + LF + 'Hello';
  const CASES = [];
  for (const url of STREAMS) {
    CASES.push([url]);
  }
  for (let i = 0; i < PAGES.length; i++) {
    CASES.push([STREAMS[i % STREAMS.length], undefined, HEADER_LISTS[i % HEADER_LISTS.length], CONTENT_TYPES[i % CONTENT_TYPES.length],
      PAGES[i], TITLES[i % TITLES.length], {startTime: STARTS[i % STARTS.length], qualities: QUALITY_LISTS[i % QUALITY_LISTS.length]}]);
  }
  for (let i = 0; i < TITLES.length; i++) {
    CASES.push([STREAMS[(i * 3) % STREAMS.length], undefined, HEADER_LISTS[(i + 4) % HEADER_LISTS.length], 'anime',
      'https://site.test/ep-' + i, TITLES[i], {startTime: STARTS[(i + 5) % STARTS.length],
        qualities: QUALITY_LISTS[(i + 3) % QUALITY_LISTS.length],
        subtitles: [{label: 'English ' + FLAG, srt: SRT}, {label: 'y'.repeat(99) + CLAPPER + 'tail', srt: SRT}, {srt: '  '}]}]);
  }

  it.each(CASES.map((args, i) => [i, args]))('gives mpv the same (case %i)', async (i, args) => {
    const open = await sent(false, args);
    const play = await sent(true, args);
    expect(play.target).toBe(Host.mpvTargetUrl(open));
    expect(play.title).toBe(Host.streamTitle(open));
    const start = Host.startOf(open);
    expect(play.start).toBe(start === undefined ? undefined : String(start));
    // The helper's loadfile left a field ending in a backslash out (mpv joined the next one to
    // it); the thin helper refuses one, so it is not sent.
    const fields = Host.relayHeaderFields(open.headers);
    expect(play.headers || []).toEqual(fields.filter((field) => !field.endsWith(BACKSLASH)));
    expect(Host.perFileOptions(play.headers || [], 't')['http-header-fields'])
        .toBe(Host.perFileOptions(fields, 't')['http-header-fields']);
    expect(play.subtitles).toEqual(open.subtitles);
  });

  it('passes the thin helper\'s checks for any of them', async () => {
    // The protocol's checks (host 15 refuses the whole message past one).
    const controls = /[\x00-\x1f\x7f]/;
    for (const args of CASES) {
      for (const settings of [{}, {fullscreen: true, singleInstance: false, mpvPath: 'D:/mpv/mpv.exe'}]) {
        const play = await sent(true, args, settings);
        expect(Host.isStreamUrl(play.target)).toBe(true);
        expect(play.target.length).toBeLessThanOrEqual(MaxPlayTargetChars);
        expect(play.target).not.toMatch(controls);
        expect(typeof play.title).toBe('string');
        expect(play.title.length).toBeLessThanOrEqual(MaxPlayTitleChars);
        expect(play.title).not.toMatch(controls);
        if (play.start !== undefined) expect(play.start).toMatch(/^\d{1,7}(\.\d{1,3})?$/);
        if (play.headers !== undefined) {
          expect(play.headers.length).toBeLessThanOrEqual(8);
          for (const field of play.headers) {
            expect(field).toMatch(/^(referer|origin|user-agent): [ -~]{1,4096}$/i);
            expect(field.endsWith(BACKSLASH)).toBe(false);
          }
        }
        // Nothing the protocol does not name (mpvPath: the coordinator's refinement, 2026-10-13).
        expect(Object.keys(play).filter((key) =>
          !['type', 'target', 'title', 'start', 'headers', 'subtitles', 'mpvPath', 'fullscreen', 'newWindow'].includes(key))).toEqual([]);
        if (settings.mpvPath) expect(play.mpvPath).toBe(settings.mpvPath);
      }
    }
  });
});
