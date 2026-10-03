import {describe, expect, it} from 'vitest';
import fc from 'fast-check';

import {URLUtils} from '../../chrome/player/utils/URLUtils.mjs';
import {PlayerModes} from '../../chrome/player/enums/PlayerModes.mjs';

// URLUtils decides whether a URL is a stream worth intercepting and which
// player handles it, mostly off strings a web page produced. The property
// tests pin what the code guarantees: every function answers instead of
// throwing, whatever string it is handed; mode detection is indifferent to an
// added query string or fragment, because strip_queryhash (line 47) cuts at
// the first ? or # before the extension is read; and the header string helpers
// round-trip the objects they are given.

const PLAYER_MODES = [
  PlayerModes.DIRECT,
  PlayerModes.ACCELERATED_MP4,
  PlayerModes.ACCELERATED_HLS,
  PlayerModes.ACCELERATED_DASH,
  PlayerModes.ACCELERATED_VM,
];

// The seven keys ModesMap is filled with (URLUtils.mjs lines 4-11).
const KNOWN_EXTENSIONS = ['webm', 'mp4', 'm3u8', 'm3u8v1', 'm3u', 'mpd', 'vmpatch'];

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

const word = (minLength, maxLength) =>
  fc.array(fc.constantFrom(...ALNUM), {minLength, maxLength}).map((chars) => chars.join(''));

describe('URLUtils never throws', () => {
  it('answers any arbitrary string with a value of the right type from every function', () => {
    // Every entry point either wraps its URL parsing in try/catch or does
    // plain string work (URLUtils.mjs lines 17-125).
    fc.assert(fc.property(fc.string(), fc.string(), (url, name) => {
      expect(typeof URLUtils.is_url(url)).toBe('boolean');
      expect(URLUtils.get_url_params(url)).toBeInstanceOf(Map);
      const param = URLUtils.get_param(url, name);
      expect(param === null || typeof param === 'string').toBe(true);
      expect(typeof URLUtils.strip_queryhash(url)).toBe('string');
      expect(typeof URLUtils.get_url_extension(url)).toBe('string');
      expect(typeof URLUtils.hostnameMatches(url, name)).toBe('boolean');
      expect(typeof URLUtils.validateHeadersString(url)).toBe('boolean');
      expect(typeof URLUtils.objToHeadersString({[name]: url})).toBe('string');
      expect(typeof URLUtils.headersStringToObj(url)).toBe('object');
      expect(URLUtils.getModeFromURL(url)).not.toBeUndefined();
      const mode = URLUtils.getModeFromExtension(url);
      expect(mode === undefined || PLAYER_MODES.includes(mode)).toBe(true);
    }), {numRuns: 200});
  });

  it('accepts every generated web URL and reads a generated query parameter back through both readers', () => {
    // Lines 17-46: new URL() in a try/catch, then URLSearchParams.
    fc.assert(fc.property(fc.webUrl(), word(1, 8), word(1, 8), (url, key, value) => {
      const withParam = URLUtils.strip_queryhash(url) + '?' + key + '=' + value;
      expect(URLUtils.is_url(withParam)).toBe(true);
      expect(URLUtils.get_param(withParam, key)).toBe(value);
      expect(URLUtils.get_url_params(withParam).get(key)).toBe(value);
    }), {numRuns: 200});
  });
});

describe('strip_queryhash', () => {
  it('cuts everything from the first ? or #, and appending a query or fragment never changes the cut', () => {
    // Lines 47-49: url.split(/[#?]/)[0]. The first separator of url + suffix is
    // either one already in url or the appended one; either way the same
    // prefix comes out.
    fc.assert(fc.property(fc.string(), (url) => {
      const stripped = URLUtils.strip_queryhash(url);
      expect(stripped.includes('?')).toBe(false);
      expect(stripped.includes('#')).toBe(false);
      expect(url.startsWith(stripped)).toBe(true);
      expect(URLUtils.strip_queryhash(url + '?a=1&b=2')).toBe(stripped);
      expect(URLUtils.strip_queryhash(url + '#fragment')).toBe(stripped);
      expect(URLUtils.strip_queryhash(url + '?a=1#fragment')).toBe(stripped);
    }), {numRuns: 200});
  });
});

describe('get_url_extension', () => {
  it('gives the lowercase extension of the last path segment, with no ? # / or . left in it', () => {
    // strip_queryhash first, then what follows the last dot of the last path segment,
    // trimmed and lowercased.
    fc.assert(fc.property(fc.string(), (url) => {
      const ext = URLUtils.get_url_extension(url);
      expect(ext).toBe(ext.toLowerCase());
      for (const c of ['?', '#', '/', '.']) {
        expect(ext.includes(c)).toBe(false);
      }
    }), {numRuns: 200});
  });

  it('reads nothing from the host of a web URL, whatever its dots', () => {
    fc.assert(fc.property(fc.webUrl({withQueryParameters: true, withFragments: true}), (url) => {
      const {origin} = new URL(url);
      expect(URLUtils.get_url_extension(origin)).toBe('');
      expect(URLUtils.get_url_extension(origin + '/')).toBe('');
    }), {numRuns: 200});
  });
});

describe('mode detection', () => {
  it('is stable for the known extensions under an added query, fragment, letter case and edge whitespace', () => {
    // strip_queryhash (line 47) cuts before the extension is read, and the
    // extension read (line 64) trims and lowercases, so every variant lands on
    // the same ModesMap entry.
    fc.assert(fc.property(
        fc.constantFrom(...KNOWN_EXTENSIONS),
        fc.string({maxLength: 10}),
        (ext, junk) => {
          const mode = URLUtils.getModeFromURL('https://e.com/v.' + ext);
          expect(URLUtils.getModeFromURL('https://e.com/v.' + ext + '?' + junk)).toBe(mode);
          expect(URLUtils.getModeFromURL('https://e.com/v.' + ext + '#' + junk)).toBe(mode);
          expect(URLUtils.getModeFromURL('https://e.com/v.' + ext + '?' + junk + '#' + junk)).toBe(mode);
          expect(URLUtils.getModeFromURL('https://e.com/v.' + ext.toUpperCase())).toBe(mode);
          expect(URLUtils.getModeFromURL('https://e.com/v.' + ext + '   ')).toBe(mode);
          expect(URLUtils.getModeFromURL(' https://e.com/v.' + ext + '?')).toBe(mode);
        },
    ), {numRuns: 200});
  });

  it('produces one of the player modes, never undefined, for an arbitrary extension', () => {
    // Line 73: the || PlayerModes.DIRECT fallback; the map itself only holds
    // modes from the list above (lines 4-11).
    fc.assert(fc.property(fc.string({maxLength: 12}), (ext) => {
      const mode = URLUtils.getModeFromURL('https://e.com/file.' + ext);
      expect(PLAYER_MODES.includes(mode)).toBe(true);
    }), {numRuns: 200});
  });
});

describe('hostnameMatches', () => {
  it('matches a generated URL against its own hostname, stays stable under an added query or fragment, and refuses an x-prefixed host', () => {
    // Lines 54-61: hostname === domain, or ends with '.' + domain. 'x' + host
    // can neither equal it nor end with '.' + host.
    fc.assert(fc.property(fc.webUrl(), (url) => {
      const hostname = new URL(url).hostname;
      expect(URLUtils.hostnameMatches(url, hostname)).toBe(true);
      expect(URLUtils.hostnameMatches(url + '?a=1', hostname)).toBe(true);
      expect(URLUtils.hostnameMatches(url + '#f', hostname)).toBe(true);
      expect(URLUtils.hostnameMatches(url, 'x' + hostname)).toBe(false);
    }), {numRuns: 200});
  });
});

describe('header strings', () => {
  // Lowercase names with digits and dashes; values that are non-empty, without
  // newlines and without edge whitespace -- everything lines 84-121 need.
  const keyArb = fc.tuple(
      fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
      fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {maxLength: 8}),
  ).map(([first, rest]) => first + rest.join(''));
  const valueArb = fc.tuple(
      fc.array(word(1, 8), {minLength: 1, maxLength: 3}),
      fc.boolean(),
  ).map(([words, withColon]) => {
    const text = words.join(' ');
    return withColon ? text + ': ' + text : text;
  });

  it('round-trips a generated object through objToHeadersString and headersStringToObj, validating as well-formed on the way', () => {
    // Lines 97-112 Pascal-case each name, lines 114-125 trim and lowercase it
    // back -- the identity holds for these lowercase keys; line 87's non-empty
    // name and value are satisfied by every generated line.
    fc.assert(fc.property(fc.array(fc.record({key: keyArb, value: valueArb}), {minLength: 1, maxLength: 5}), (entries) => {
      const obj = {};
      for (const {key, value} of entries) {
        obj[key] = value;
      }
      const str = URLUtils.objToHeadersString(obj);
      expect(URLUtils.headersStringToObj(str)).toEqual(obj);
      expect(URLUtils.validateHeadersString(str)).toBe(true);
    }), {numRuns: 200});
  });

  it('rejects a generated line with no colon, with an empty name or with an empty value', () => {
    // Lines 84-91: a split-less line, an empty name or an empty value refuses
    // the whole string.
    fc.assert(fc.property(keyArb, (name) => {
      expect(URLUtils.validateHeadersString(name)).toBe(false);
      expect(URLUtils.validateHeadersString(name + ':')).toBe(false);
      expect(URLUtils.validateHeadersString(':' + name)).toBe(false);
    }), {numRuns: 200});
  });
});
