import crypto from 'node:crypto';
import {afterEach, describe, expect, it} from 'vitest';
import fc from 'fast-check';

import * as Host from '../../native-host/faststream-mpv-host.mjs';
import * as Target from '../../chrome/background/MpvTarget.mjs';
import {MaxPlayTargetChars, MaxPlayTitleChars, MpvBackend, RequiredHostVersion} from '../../chrome/background/MpvBackend.mjs';

// What mpv is given for a stream is built in the extension (MpvTarget.mjs), so a change to it
// needs no helper reinstall. mpv's scripts read its fs-* tags (stream-resume.lua keeps positions
// under the fs-id, source-info.lua shows fs-page, faststream-quality.lua lists fs-quality): the
// values below are pinned, as the helper built them until host 15, byte for byte.

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
const CONTROLS = /[\x00-\x1f\x7f]/;

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

const CONTENT_TYPES = [undefined, 'anime', 'movie', 'native', 'Anime', 'documentary', null];

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

// fs-id of the page the resume positions are kept under: the first 16 hex digits of its SHA-256.
const PAGE = 'https://site.test/ep-1';
const PAGE_ID = '9f3b6dc7eb4ea165';
const PAGE_TAG = 'fs-page=https%3A%2F%2Fsite.test%2Fep-1';

describe('the fs-* tags a stream URL brought', () => {
  it('are dropped, the rest of its fragment kept', () => {
    expect(STREAMS.slice(2, 9).map(Target.withoutFsTags)).toEqual([
      'https://cdn.test/a.m3u8',
      'https://cdn.test/a.m3u8#t=10',
      'https://cdn.test/a.m3u8',
      'https://cdn.test/a.m3u8#t=10',
      'https://cdn.test/a.m3u8',
      'https://cdn.test/a.m3u8',
      // mpv's scripts split the fragment at '&' only: "b#fs-id=1" is no tag.
      'https://cdn.test/a#b#fs-id=1',
    ]);
    for (const url of [STREAMS[0], STREAMS[1], STREAMS[9], STREAMS[15]]) {
      expect(Target.withoutFsTags(url)).toBe(url);
    }
  });
});

describe('withContentTypeFragment', () => {
  it('appends a fragment marker when there is none yet', () => {
    for (const type of ['anime', 'movie', 'native']) {
      expect(Target.withContentTypeFragment('https://example.com/a.m3u8', type)).toBe(`https://example.com/a.m3u8#fs-content=${type}`);
    }
  });

  it('extends an existing fragment instead of adding a second #, and fills an empty one', () => {
    expect(Target.withContentTypeFragment('https://example.com/a.m3u8#t=30', 'anime')).toBe('https://example.com/a.m3u8#t=30&fs-content=anime');
    expect(Target.withContentTypeFragment('https://example.com/a.m3u8#', 'movie')).toBe('https://example.com/a.m3u8#fs-content=movie');
  });

  it('leaves the URL untouched for an unset or unknown content type', () => {
    for (const type of [undefined, null, 'documentary', 'Anime']) {
      expect(Target.withContentTypeFragment('https://example.com/a.m3u8', type)).toBe('https://example.com/a.m3u8');
    }
  });
});

// fs-id is a hash of the page URL: the stream URL changes with each visit's token, the episode
// page does not.
describe('resumeIdFor', () => {
  it('is the first 16 hex digits of the page\'s SHA-256, the same as ever', async () => {
    expect(await Target.resumeIdFor(PAGE)).toBe(PAGE_ID);
    expect(await Target.resumeIdFor('https://example.com/anime/show/episode-3')).toBe('43da78a684f9dfb1');
    for (const page of PAGES.slice(6, 9)) {
      expect(await Target.resumeIdFor(page)).toBe(crypto.createHash('sha256').update(page).digest('hex').slice(0, 16));
    }
  });

  it('is undefined for a missing or non-http(s) page URL', async () => {
    for (const page of PAGES.slice(0, 6)) {
      expect(await Target.resumeIdFor(page)).toBeUndefined();
    }
  });
});

describe('pageFragmentFor (source-info.lua reads fs-page)', () => {
  it('encodes the page whole, the characters that would break the fragment (&, ?, #) too', () => {
    const messy = 'https://example.com/watch?v=1&q=a&x#top';
    expect(Target.pageFragmentFor(messy)).toBe('https%3A%2F%2Fexample.com%2Fwatch%3Fv%3D1%26q%3Da%26x%23top');
    expect(decodeURIComponent(Target.pageFragmentFor(messy))).toBe(messy);
  });

  it('is undefined for a missing or non-http(s) page URL, and throws on half a surrogate pair', () => {
    for (const page of PAGES.slice(0, 6)) {
      expect(Target.pageFragmentFor(page)).toBeUndefined();
    }
    // MpvBackend.sentPageUrl sends no page then.
    expect(() => Target.pageFragmentFor(PAGES[9])).toThrow(URIError);
  });
});

describe('mpvTargetUrl', () => {
  it('appends fs-content, fs-id and fs-page in one fragment, in that order', async () => {
    expect(await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8?token=1', contentType: 'anime', pageUrl: PAGE}))
        .toBe(`https://cdn.test/a.m3u8?token=1#fs-content=anime&fs-id=${PAGE_ID}&${PAGE_TAG}`);
    expect(await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8', pageUrl: PAGE}))
        .toBe(`https://cdn.test/a.m3u8#fs-id=${PAGE_ID}&${PAGE_TAG}`);
    expect(await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8', contentType: 'movie'})).toBe('https://cdn.test/a.m3u8#fs-content=movie');
    expect(await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8', pageUrl: 'about:blank'})).toBe('https://cdn.test/a.m3u8');
  });

  it('gives the same key for a new stream token on the same page', async () => {
    const first = await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8?token=1', pageUrl: PAGE});
    const second = await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8?token=2', pageUrl: PAGE});
    expect(first.split('#')[1]).toBe(second.split('#')[1]);
  });

  it('hands mpv the URL as the parser writes it, its own tags replaced by the extension\'s (#154)', async () => {
    const tags = `fs-content=movie&fs-id=${PAGE_ID}&${PAGE_TAG}`;
    const targets = [];
    for (const url of STREAMS.slice(2)) {
      targets.push(await Target.mpvTargetUrl({url, contentType: 'movie', pageUrl: PAGE}));
    }
    expect(targets).toEqual([
      `https://cdn.test/a.m3u8#${tags}`,
      `https://cdn.test/a.m3u8#t=10&${tags}`,
      `https://cdn.test/a.m3u8#${tags}`,
      `https://cdn.test/a.m3u8#t=10&${tags}`,
      `https://cdn.test/a.m3u8#${tags}`,
      `https://cdn.test/a.m3u8#${tags}`,
      `https://cdn.test/a#b#fs-id=1&${tags}`,
      `https://cdn.test:8443/Path/A.m3u8#${tags}`,
      `https://cdn.test/a%20b.m3u8#${tags}`,
      // The parser drops a tab or newline the raw string still has.
      `https://cdn.test/ab.m3u8#${tags}`,
      `https://cdn.test/%C3%A9pisode.m3u8?q=%C3%A9#%C3%A9&${tags}`,
      `https://xn--bcher-kva.test/a.mp4#${tags}`,
      `https://user:pass@cdn.test/a.mp4#${tags}`,
      `http://cdn.test/a.mp4#%20x&${tags}`,
      `https://cdn.test/upper-scheme.mp4#${tags}`,
    ]);
    expect(await Target.mpvTargetUrl({url: 'https://cdn.test/v.m3u8\n--foo bar\t?t=1 2'})).toBe('https://cdn.test/v.m3u8--foo%20bar?t=1%202');
    // An already clean URL, as a site gives one, stays as it is.
    const signed = 'https://cdn.test/hls/a%2Fb/index.m3u8?sig=AbC%3D%3D&exp=1&x=a,b;c';
    expect(await Target.mpvTargetUrl({url: signed})).toBe(signed);
  });
});

describe('fs-quality (faststream-quality.lua reads it)', () => {
  // The qualities the page's player offers the video in (page-qualities.js): mpv's quality
  // menu switches between them, each loaded with the same fragment tags.
  const qualities = [
    {url: 'https://h.test/get_file/1_360p.mp4/', label: '360p', height: 360},
    {url: 'https://h.test/get_file/1.mp4/', label: '1080p', height: 1080},
  ];

  /**
   * The list the tag carries, as the mpv script reads it: the last fs-quality= item, decoded.
   * @param {string} target - mpvTargetUrl's.
   * @return {*}
   */
  function tagged(target) {
    const items = target.slice(target.indexOf('#') + 1).split('&').filter((item) => item.startsWith('fs-quality='));
    return items.length ? JSON.parse(decodeURIComponent(items.at(-1).slice('fs-quality='.length))) : undefined;
  }

  it('goes last, after fs-id and fs-page, and decodes to the list', async () => {
    const target = await Target.mpvTargetUrl({url: qualities[1].url, pageUrl: 'https://site.test/watch?v=1&x=2', qualities});
    expect(target.startsWith(qualities[1].url + '#fs-id=')).toBe(true);
    expect(target.indexOf('&fs-page=')).toBeLessThan(target.indexOf('&fs-quality='));
    expect(tagged(target)).toEqual(qualities);
    // The stream is one of them, as the script finds it: its URL without the fragment.
    expect(tagged(target).some((entry) => entry.url === target.slice(0, target.indexOf('#')))).toBe(true);
  });

  it('keeps only http(s) files of at most 2048 characters, short plain labels, whole heights, of the first 12', () => {
    const lists = QUALITY_LISTS.map((list) => {
      const fragment = Target.qualityFragmentFor(list);
      return fragment === undefined ? undefined : JSON.parse(decodeURIComponent(fragment));
    });
    expect(lists.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(lists[4]).toEqual([quality(1080), quality(720)]);
    // Controls become spaces, then trimmed; the 40th character a flag: whole.
    expect(lists[5].map((entry) => entry.label)).toEqual(['Full HD   ' + CLAPPER, 'x'.repeat(39) + FLAG]);
    expect(lists[6].map((entry) => entry.height)).toEqual([0, 0, 0, 0]);
    // No file:, no UNC path; a file's own fragment is cut off (mpv's path match ends at '#').
    expect(lists[7].map((entry) => entry.url)).toEqual(['https://h.test/480.mp4', 'https://h.test/360.mp4']);
    expect(lists[8].map((entry) => entry.height)).toEqual([720, 480]);
    expect(lists[9]).toEqual([{url: 'https://h.test/1080.mp4', label: '', height: 1080}, {url: 'https://h.test/720.mp4', label: '', height: 720},
      {url: 'https://h.test/a%20b%2C.mp4', label: '480p', height: 480}]);
    expect(lists[10].map((entry) => entry.height)).toEqual(Array.from({length: 12}, (_, i) => 100 + i));
  });

  it('adds nothing for fewer than two usable files', async () => {
    expect(Target.qualityFragmentFor([qualities[0], {url: 'javascript:alert(1)', label: 'x', height: 1}])).toBeUndefined();
    expect(await Target.mpvTargetUrl({url: qualities[0].url, qualities: [qualities[0]]})).toBe(qualities[0].url);
  });

  it('writes the stream\'s entry as the stream\'s URL up to its fragment, an empty one too', async () => {
    for (const url of ['https://h.test/1.mp4#t=30', 'https://h.test/1.mp4#']) {
      const target = await Target.mpvTargetUrl({url, qualities: [{url, label: '1080p', height: 1080}, qualities[0]]});
      expect(tagged(target)[0].url).toBe('https://h.test/1.mp4');
      expect(target.startsWith('https://h.test/1.mp4#')).toBe(true);
    }
  });
});

describe('streamTitle', () => {
  it('is the tab\'s title, one line, trimmed, at most 200 characters cut between whole ones (#470)', () => {
    expect(TITLES.slice(5, 12).map((title) => Target.streamTitle({url: 'https://cdn.test/a', title}))).toEqual([
      'Show - Episode 3',
      // NEL is no space to \s; NBSP is.
      'a b c d e' + NEL + 'f g',
      'x'.repeat(200),
      'x'.repeat(199) + CLAPPER,
      'x'.repeat(199) + FLAG,
      'x'.repeat(199) + FAMILY,
      'e' + ch(0x301).repeat(50) + ' combining',
    ]);
    expect(Target.streamTitle({url: 'https://cdn.test/a', title: String.fromCharCode(0, 1, 31) + 'controls'})).toBe('controls');
  });

  it('is the stream\'s host name without a usable title', () => {
    for (const title of TITLES.slice(0, 5)) {
      expect(Target.streamTitle({url: 'https://CDN.TEST:8443/a', title})).toBe('cdn.test');
    }
    expect(Target.streamTitle({url: 'https://[::1]/a'})).toBe('[::1]');
    expect(Target.streamTitle({url: 'not a url'})).toBe('FastStream');
  });
});

describe('startOf', () => {
  it('takes a start of a second or more and under 10^7, to the millisecond, cut not rounded', () => {
    expect(STARTS.map((start) => Target.startOf({start}))).toEqual([undefined, undefined, undefined, undefined, undefined,
      1, 1, 2.3, 754.5, 1234567.891, 9999999.999, undefined, undefined, undefined, undefined]);
  });
});

describe('isStreamUrl', () => {
  it('agrees with the helper\'s on what may go to mpv', () => {
    for (const url of [...STREAMS, 'file:///C:/x.mp4', 'https:' + BACKSLASH + BACKSLASH + 'h', 'ftp://x', 5, '', 'https://']) {
      expect(Target.isStreamUrl(url)).toBe(Host.isStreamUrl(url));
    }
  });
});

describe('for any input (fast-check)', () => {
  const text = fc.string({unit: 'binary', maxLength: 80});
  const fragmentPart = fc.oneof(text, fc.constantFrom('fs-id=1', 'FS-page=x', 'fs-', 't=10', ''));
  const streamUrl = fc.tuple(text, fc.array(fragmentPart, {maxLength: 5}), fc.boolean())
      .map(([path, parts, hash]) => 'https://cdn.test/' + path + (hash ? '#' + parts.join('&') : ''))
      .filter((url) => Host.isStreamUrl(url));

  it('tags the target with the extension\'s fs-* tags only, which read back as the page', async () => {
    await fc.assert(fc.asyncProperty(streamUrl, fc.option(text), fc.constantFrom('anime', 'movie', undefined),
        async (url, page, contentType) => {
          const pageUrl = page === null ? undefined : 'https://site.test/' + page;
          const target = await Target.mpvTargetUrl({url, contentType, pageUrl});
          expect(Host.isStreamUrl(target)).toBe(true);
          const tags = target.includes('#') ? target.slice(target.indexOf('#') + 1).split('&').filter((part) => /^fs-/i.test(part)) : [];
          const expected = [];
          if (contentType) expected.push(`fs-content=${contentType}`);
          if (pageUrl) expected.push(`fs-id=${await Target.resumeIdFor(pageUrl)}`, `fs-page=${encodeURIComponent(pageUrl)}`);
          expect(tags).toEqual(expected);
          if (pageUrl) expect(decodeURIComponent(tags.at(-1).slice('fs-page='.length))).toBe(pageUrl);
        }), {numRuns: 300});
  });

  it('gives a title and header fields the helper takes', () => {
    fc.assert(fc.property(fc.string({unit: 'grapheme', maxLength: 260}), text, (title, value) => {
      const clean = Target.streamTitle({url: 'https://cdn.test/a', title});
      expect([...new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(clean)].length).toBeLessThanOrEqual(200);
      const headers = Target.relayHeaderFields([{name: 'Referer', value}, {name: 'Origin', value: value + BACKSLASH}])
          .filter((field) => !field.endsWith(BACKSLASH));
      expect(Host.checkPlayMessage({target: 'https://cdn.test/a', title: Target.cutToLength(clean, MaxPlayTitleChars), headers}))
          .toMatchObject({ok: true});
    }), {numRuns: 300});
  });

  it('lists at most 12 qualities, each an http(s) file without a fragment, a plain label and a whole height', () => {
    const entry = fc.record({url: fc.oneof(text.map((t) => 'https://h.test/' + t), text), label: fc.oneof(text, fc.integer()),
      height: fc.oneof(fc.integer({min: -10, max: 20000}), fc.double())});
    fc.assert(fc.property(fc.array(entry, {maxLength: 14}), (list) => {
      const fragment = Target.qualityFragmentFor(list);
      if (fragment === undefined) return;
      const listed = JSON.parse(decodeURIComponent(fragment));
      expect(listed.length).toBeGreaterThanOrEqual(2);
      expect(listed.length).toBeLessThanOrEqual(12);
      for (const {url, label, height} of listed) {
        expect(Host.isStreamUrl(url) && !url.includes('#') && url.length <= 2048).toBe(true);
        expect(typeof label === 'string' && !CONTROLS.test(label) && label === label.trim()).toBe(true);
        expect(Number.isInteger(height) && height >= 0 && height <= 10000).toBe(true);
      }
    }), {numRuns: 300});
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

describe('the play message for a stream', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  /**
   * Sends one stream through a fresh backend to a fake current helper, and returns the play message it got.
   * @param {Array<*>} args - openStream's arguments.
   * @param {Object} [settings] - fullscreen, singleInstance, mpvPath.
   * @return {Promise<Object>} The message.
   */
  async function sent(args, settings = {}) {
    let message;
    globalThis.chrome = {runtime: {lastError: undefined, sendNativeMessage(name, m, callback) {
      if (m.type === 'play') message = m;
      callback({ok: true, hostVersion: RequiredHostVersion});
    }}};
    const backend = Object.assign(new MpvBackend(), settings);
    expect((await backend.openStream(...args)).ok).toBe(true);
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

  it('carries the target, title, start, header fields and subtitles', async () => {
    const play = await sent(['https://cdn.test/a.m3u8?t=1', undefined,
      [{name: 'Referer', value: PAGE}, {name: 'Cookie', value: 'a=b'}, {name: 'Origin', value: 'https://site.test/' + BACKSLASH}],
      'anime', PAGE, ' Show - Episode 3 ', {startTime: 754.5, qualities: QUALITY_LISTS[4], subtitles: [{label: 'English', srt: SRT}]}]);
    expect(play).toEqual({
      type: 'play',
      target: `https://cdn.test/a.m3u8?t=1#fs-content=anime&fs-id=${PAGE_ID}&${PAGE_TAG}&fs-quality=` +
        encodeURIComponent(JSON.stringify([1080, 720].map((height) => ({label: `${height}p`, height, url: `https://h.test/${height}.mp4`})))),
      title: 'Show - Episode 3',
      start: '754.5',
      // Cookie is never sent; a field ending in a backslash would swallow the next one in mpv's list.
      headers: ['Referer: ' + PAGE],
      subtitles: [{label: 'English', srt: SRT}],
    });
  });

  it('passes the helper\'s checks for any of them', async () => {
    // The helper refuses the whole message past one.
    for (const args of CASES) {
      for (const settings of [{}, {fullscreen: true, singleInstance: false, mpvPath: 'D:/mpv/mpv.exe'}]) {
        const play = await sent(args, settings);
        expect(Host.checkPlayMessage(play)).toMatchObject({ok: true});
        expect(play.target.length).toBeLessThanOrEqual(MaxPlayTargetChars);
        expect(play.title.length).toBeLessThanOrEqual(MaxPlayTitleChars);
        expect(play.title).not.toMatch(CONTROLS);
        // nothing the protocol does not name
        expect(Object.keys(play).filter((key) =>
          !['type', 'target', 'title', 'start', 'headers', 'subtitles', 'mpvPath', 'fullscreen', 'newWindow'].includes(key))).toEqual([]);
        if (settings.mpvPath) expect(play.mpvPath).toBe(settings.mpvPath);
      }
    }
  });
});

describe('a private window\'s stream', () => {
  it('carries fs-private=1 after its resume key, which it keeps, and nothing else changes', async () => {
    const stream = {url: 'https://cdn.test/a.m3u8?t=1', contentType: 'anime', pageUrl: 'https://site.test/ep-1',
      qualities: [{url: 'https://cdn.test/720.mp4', label: '720p', height: 720}, {url: 'https://cdn.test/1080.mp4', label: '1080p', height: 1080}]};
    const normal = await Target.mpvTargetUrl(stream);
    const hidden = await Target.mpvTargetUrl({...stream, private: true});
    expect(normal).not.toContain('fs-private');
    expect(hidden).toBe(normal.replace('&fs-page=', '&fs-private=1&fs-page='));
    expect(await Target.mpvTargetUrl({...stream, private: 'yes'})).toBe(normal);
    // Without a page (no fs-id, no fs-page) it still says so.
    expect(await Target.mpvTargetUrl({url: 'https://cdn.test/a.m3u8', private: true})).toBe('https://cdn.test/a.m3u8#fs-private=1');
  });
});
