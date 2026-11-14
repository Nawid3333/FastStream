import fc from 'fast-check';
import {describe, expect, it} from 'vitest';

import {parseCustomSourcePatterns} from '../../chrome/background/CustomSourcePatterns.mjs';
import {contentTypeOf, modeFromContentType, modeFromMediaType} from '../../chrome/background/ManifestTypes.mjs';
import {MultiRegexMatcher} from '../../chrome/background/MultiRegexMatcher.mjs';
import {classifyResponse, isHtmlResponse, modeFromQuery, urlType} from '../../chrome/background/StreamDetection.mjs';
import {UrlMatchList} from '../../chrome/background/UrlMatchList.mjs';
import {relabelEsdsAacLayout, windowsAacLayout} from '../../chrome/player/players/mp4/AacLayout.mjs';
import {lengthFromAnswer, MAX_FILE_LENGTH} from '../../chrome/player/players/mp4/RangeAnswers.mjs';
import {startsLikeMp4} from '../../chrome/player/utils/ContainerSniff.mjs';
import {guessMediaInfo} from '../../chrome/player/utils/MediaTitle.mjs';

// What a server or a page decides, as the small parsers get it: a file's first bytes, an
// answer's headers, an address, a page's title. None of them may throw (the background's
// request listeners and the player's loaders call them with no catch of their own), none may
// take long, and what they answer has the shape their callers read.

const bytes = (max) => fc.uint8Array({maxLength: max});
const header = fc.record({
  name: fc.oneof(fc.constantFrom('Content-Type', 'content-type', 'Location', 'Content-Disposition', 'X-Any'), fc.string({maxLength: 12})),
  value: fc.oneof(fc.constant(undefined), fc.string({maxLength: 60}), fc.constantFrom('text/html; charset=utf-8', 'application/vnd.apple.mpegurl',
      'application/dash+xml', 'video/mp4', 'audio/mpeg', 'APPLICATION/X-MPEGURL', 'video/mp4;codecs="avc1"', ';', '/')),
}, {requiredKeys: ['name']});
const headers = fc.oneof(fc.constant(undefined), fc.array(header, {maxLength: 5}));
const address = fc.oneof(fc.webUrl({withQueryParameters: true, withFragments: true}), fc.string({maxLength: 80}),
    fc.constantFrom('https://cdn.test/v/master.m3u8?x=1', 'https://cdn.test/embed.php?file=https://cdn.test/a.mpd', 'blob:https://site.test/1',
        'data:video/mp4;base64,AAAA', 'https://[::1]/a.mp4', 'https://site.test/%E0%A4%A', 'about:blank', ''));
const MODES = fc.constantFrom('m3u8', 'mpd', 'mp4', 'vtt');

describe('Parsers of what a server or page sends', () => {
  it('ContainerSniff: any bytes are an MP4\'s start or not', () => {
    fc.assert(fc.property(bytes(64), (data) => {
      expect(typeof startsLikeMp4(data)).toBe('boolean');
    }), {numRuns: 2000});
  });

  it('AacLayout: any bytes come back as long as they were, or not at all', () => {
    fc.assert(fc.property(bytes(48), (data) => {
      const before = Uint8Array.from(data);
      const made = windowsAacLayout(data);
      expect(data).toEqual(before);
      if (made !== null) expect(made.length).toBe(before.length);

      const esd = Uint8Array.from(data);
      const changed = relabelEsdsAacLayout(esd);
      expect(esd.length).toBe(before.length);
      if (!changed) expect(esd).toEqual(before);
    }), {numRuns: 4000});
  });

  it('RangeAnswers: any first answer tells a length the player can make ranges of', () => {
    const answer = fc.record({
      status: fc.constantFrom(200, 206, 416, 0, 304),
      headers: fc.oneof(fc.constant(null), fc.dictionary(fc.constantFrom('content-range', 'content-length', 'x'),
          fc.oneof(fc.string({maxLength: 40}), fc.constantFrom('bytes 0-999999/123456789', 'bytes 0-1/*', 'bytes */9007199254740993',
              'bytes 0-9/1e30', 'bytes 0-9/-5', '0', '-1', '1e400', 'Infinity', '12abc')))),
      received: fc.nat({max: 2 ** 21}),
    });
    // The range is the player's own: its first, from the file's start or near it.
    const range = fc.nat({max: 2 ** 21}).chain((start) => fc.record({start: fc.constant(start), end: fc.integer({min: start + 1, max: start + 2 ** 21})}));
    fc.assert(fc.property(answer, range, (a, r) => {
      const told = lengthFromAnswer(a, r);
      expect(Number.isSafeInteger(told.length)).toBe(true);
      expect(told.length).toBeGreaterThanOrEqual(0);
      // Never more ranges than the player can make at once (MAX_FILE_LENGTH's reason).
      expect(told.length).toBeLessThanOrEqual(MAX_FILE_LENGTH);
      expect(typeof told.playDirectly).toBe('boolean');
      if (told.tooLong) expect(told).toMatchObject({length: 0, playDirectly: true});
    }), {numRuns: 4000});
  });

  it('ManifestTypes and StreamDetection: any answer is a stream in a known mode, a subtitle file or nothing', () => {
    const matcher = new MultiRegexMatcher();
    matcher.compile();
    const details = fc.record({
      url: address,
      requestId: fc.oneof(fc.nat(), fc.string({maxLength: 6})),
      statusCode: fc.constantFrom(200, 206, 204, 301, 302, 304, 403, 404, 500, 0),
      method: fc.constantFrom(undefined, 'GET', 'POST', 'HEAD', 'OPTIONS'),
      type: fc.constantFrom(undefined, 'media', 'main_frame', 'sub_frame', 'xmlhttprequest', 'other'),
      responseHeaders: headers,
    });
    fc.assert(fc.property(details, fc.oneof(fc.constant(null), address), (d, first) => {
      expect(typeof contentTypeOf(d.responseHeaders)).toBe('string');
      expect(contentTypeOf(d.responseHeaders)).toBe(contentTypeOf(d.responseHeaders).toLowerCase());
      expect(['string', 'undefined']).toContain(typeof modeFromContentType(d.responseHeaders));
      const media = modeFromMediaType(d.responseHeaders);
      expect(media === null || typeof media === 'string').toBe(true);
      expect(typeof isHtmlResponse(d.responseHeaders)).toBe('boolean');
      expect(typeof urlType(d.url, matcher)).toBe('string');
      const query = modeFromQuery(d.url, matcher);
      expect(query === null || typeof query === 'string').toBe(true);

      const kind = classifyResponse(/** @type {*} */ (d), first, matcher);
      expect(['ignore', 'subtitles', 'source']).toContain(kind.kind);
      if (kind.kind === 'source') expect(typeof kind.mode).toBe('string');
      // An error, a redirect, a preflight: never a stream, whatever else the answer says.
      if (d.statusCode >= 400 || d.statusCode === 204 || d.method === 'OPTIONS' || d.method === 'HEAD') {
        expect(kind.kind).toBe('ignore');
      }
    }), {numRuns: 4000});
  });

  it('CustomSourcePatterns and the matcher: any text of patterns makes a matcher that answers any address', () => {
    const line = fc.oneof(fc.string({maxLength: 30}), fc.tuple(MODES, fc.string({maxLength: 20})).map(([ext, regex]) => `${ext}: /${regex}/i`),
        fc.constantFrom('m3u8: /\\.php\\?stream=/', 'mp4: /(a+)+$/', 'mpd: /[/', '// comment', ''));
    fc.assert(fc.property(fc.array(line, {maxLength: 6}), address, (lines, url) => {
      const parsed = parseCustomSourcePatterns(lines.join('\n'));
      expect(Array.isArray(parsed.patterns)).toBe(true);
      const matcher = new MultiRegexMatcher();
      for (const pattern of parsed.patterns) matcher.addRegex(pattern.regex, pattern.flags, pattern.ext);
      matcher.compile();
      expect(typeof urlType(url, matcher)).toBe('string');
      const kind = classifyResponse({url, requestId: 1, statusCode: 200, type: 'xmlhttprequest', responseHeaders: []}, null, matcher);
      expect(['ignore', 'subtitles', 'source']).toContain(kind.kind);
    }), {numRuns: 2000});
  });

  it('UrlMatchList: any entry the user types and any address a tab has match or do not', () => {
    const entry = fc.oneof(fc.string({maxLength: 40}), address, fc.constantFrom('-site.test', '~^https://site\\.test/', '~(', '*.site.test', 'user@site.test',
        'https://site.test/*', 'xn--', 'münchen.test', '[::1]', '~^(a+)+$'));
    fc.assert(fc.property(fc.array(entry, {maxLength: 5}), address, (entries, url) => {
      for (const raw of entries) {
        const parsed = UrlMatchList.parseEntry(raw);
        if (parsed) expect(typeof UrlMatchList.entryMatches(parsed, url.toLowerCase())).toBe('boolean');
      }
    }), {numRuns: 3000});
  });

  it('MediaTitle: any page title tells a name, and a year, season and episode that are numbers or nothing', () => {
    const title = fc.oneof(fc.string({maxLength: 120}), fc.array(fc.constantFrom('S01E02', 'Season 1', 'Episode', '(2024)', '1080p', '-', '|', ' ', 'x264',
        'Watch', 'online', '2x05', '[', ']', '.', 'Staffel 2', 'Folge 3', '‮', '😀'), {maxLength: 30}).map((parts) => parts.join(' ')));
    fc.assert(fc.property(title, fc.oneof(fc.domain(), fc.string({maxLength: 20})), (text, host) => {
      const info = guessMediaInfo(text, host, 2026);
      expect(typeof info.name).toBe('string');
      for (const key of /** @type {const} */ (['year', 'season', 'episode'])) {
        expect(info[key] === null || Number.isFinite(info[key])).toBe(true);
      }
    }), {numRuns: 3000});
  });

  it('none of them takes long on the longest input a page can make', () => {
    // A title or address of 100,000 characters made to backtrack: each answer within a
    // second (they answer in a millisecond; a pattern that backtracks takes minutes).
    const long = [
      'a'.repeat(100000), ' '.repeat(100000) + 'x', 'S01E'.repeat(25000), '('.repeat(50000) + ')'.repeat(50000), '1 '.repeat(50000), '-'.repeat(100000) + '!',
      'https://site.test/' + '%'.repeat(100000), 'https://site.test/?' + 'a=b&'.repeat(25000), 'https://' + 'a.'.repeat(50000) + 'test/',
    ];
    const matcher = new MultiRegexMatcher();
    matcher.compile();
    for (const text of long) {
      const started = performance.now();
      guessMediaInfo(text, 'site.test', 2026);
      urlType(text, matcher);
      modeFromQuery(text, matcher);
      classifyResponse({url: text, requestId: 1, statusCode: 200, responseHeaders: [{name: 'Content-Type', value: text}]}, text, matcher);
      const parsed = UrlMatchList.parseEntry(text.slice(0, 2000));
      if (parsed) UrlMatchList.entryMatches(parsed, text);
      expect(performance.now() - started, text.slice(0, 30)).toBeLessThan(1000);
    }
  });
});
