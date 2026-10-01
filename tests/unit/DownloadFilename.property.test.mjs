import {describe, expect, it} from 'vitest';

import fc from 'fast-check';

import {sanitizeDownloadFilename} from '../../chrome/background/DownloadFilename.mjs';

// The filename sanitizer stands between player-provided strings and Firefox's
// download API: anything a web page hands over ends up here. Every property
// below was checked against DownloadFilename.mjs and cites the lines that
// guarantee it:
//   non-empty          -- lines 63-65 and 96-99 fall back to a real name
//   no refused chars   -- line 13 defines the class, line 49 replaces it
//   clean edges        -- lines 55-57 strip them, 91-93 after a length cut
//   no device names    -- lines 25 and 67-69 underscore such a name
//   <= 200 characters  -- line 27 defines the limit, lines 84-93 enforce it
//   idempotent         -- a result holds nothing lines 48-57 act on, and fits
//                         the limit, so every rule is a no-op on it

const MAX_LENGTH = 200; // line 27 of DownloadFilename.mjs

// The class line 13 refuses: quotes, colon, angle brackets, slashes, pipe,
// question mark, asterisk, and every control character (U+0000-U+001F and
// U+007F-U+009F). No /g flag: test() must be stateless.
const REFUSED = /["*:<>?|\/\\\p{Cc}]/u;

// Lines 24-25: Windows refuses these before the first dot, in any letter case.
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

// Every character class the sanitizer treats, plus device names and text, so
// all rules get hit often.
const UNIT_POOL = ['a', 'B', '9', '-', '_', 'txt', '.png', '.',
  ' ', '<', '>', ':', '"', '/', '\\', '|', '?', '*',
  '\u0000', '\u0009', '\u001F', '\u007F', '\u0085', '\u009F',
  '\u00AD', '\u200B', '\u200E', '\u202A', '\u2060', '\uFEFF',
  '\u00A0', '\u2003', '\u2028', '\u2029',
  'CON', 'con', 'Com1', 'lpt4', 'NUL'];

const arbitraryFilename = fc.oneof(
    fc.string({unit: 'binary', maxLength: 240}),
    fc.string({unit: 'binary', minLength: 180, maxLength: 400}), // long: the length cut runs
    fc.array(fc.constantFrom(...UNIT_POOL), {minLength: 0, maxLength: 80})
        .map((units) => units.join('')),
);

describe('sanitizeDownloadFilename', () => {
  it('returns the fallback download name for anything that is not a string', () => {
    // Lines 43-46: typeof check first.
    fc.assert(fc.property(fc.constantFrom(null, undefined, 42, true, {}, ['x']), (input) => {
      expect(sanitizeDownloadFilename(input)).toBe('download');
    }), {numRuns: 200});
  });

  it('never returns an empty name', () => {
    // Line 63-65 turns '' into the fallback; lines 96-99 re-fill a base the
    // length cut emptied.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      expect(sanitizeDownloadFilename(filename).length).toBeGreaterThan(0);
    }), {numRuns: 200});
  });

  it('never contains a character Firefox refuses: quotes, asterisks, colons, angle brackets, slashes, pipes, question marks or any control character', () => {
    // Line 49 replaces the whole class line 13 defines; nothing afterwards can
    // reintroduce one -- the remaining edits only delete (line 50), map
    // separators to a plain space (line 51), strip the edges (55-57), prefix
    // '_' (67-69) or cut and append already-clean text (84-101).
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      const result = sanitizeDownloadFilename(filename);
      expect(REFUSED.test(result)).toBe(false);
    }), {numRuns: 200});
  });

  it('neither starts nor ends with a dot or a space', () => {
    // Lines 55-57 strip both edges of the name; lines 91-93 re-strip the tail
    // a length cut can expose; a kept extension (isExtension, line 36, allows
    // no dot or space) always ends inside the extension text.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      const result = sanitizeDownloadFilename(filename);
      expect(/^[. ]/.test(result)).toBe(false);
      expect(/[. ]$/.test(result)).toBe(false);
    }), {numRuns: 200});
  });

  it('never leaves a reserved DOS device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, any case, with or without extension) before the first dot', () => {
    // Lines 67-69 underscore such a name before the extension split and the
    // length cut run. A cut keeps the leading characters (line 85 shortens
    // from the end, and leaves at least 189 of them -- line 36 caps a kept
    // extension at 10 characters plus its dot) and the extension is appended
    // after, so the result's first dot-separated segment is either the
    // underscored one or the same non-reserved one the check passed.
    // A device name alone, with an extension, or with edges the sanitizer strips first:
    // random text rarely is one.
    const deviceFilename = fc.tuple(
        fc.constantFrom('', ' ', '.', '..'),
        fc.constantFrom('CON', 'prn', 'Aux', 'nul', 'COM1', 'com9', 'LPT3', 'lpt1'),
        fc.constantFrom('', '.png', '.srt', '.tar.gz', ' ', '.', '. '),
    ).map((parts) => parts.join(''));
    fc.assert(fc.property(fc.oneof(arbitraryFilename, deviceFilename), (filename) => {
      const result = sanitizeDownloadFilename(filename);
      expect(DEVICE_NAME.test(result.split('.')[0])).toBe(false);
    }), {numRuns: 300});
  });

  it('never cuts a character in half: a long name of emoji and letters stays well-formed', () => {
    // The length cut counts UTF-16 units; one that falls inside a surrogate pair would
    // leave half an emoji, which Firefox refuses.
    const longName = fc.string({unit: fc.constantFrom('\u{1F600}', '\u{1D538}', 'a', '-'), minLength: 120, maxLength: 260});
    fc.assert(fc.property(longName, fc.constantFrom('', '.png', '.srt'), (base, extension) => {
      const result = sanitizeDownloadFilename(base + extension);
      expect(result.isWellFormed()).toBe(true);
    }), {numRuns: 300});
  });

  it('stays within the module\'s 200-character limit', () => {
    // Line 27 sets MAX_LENGTH; lines 84-89 shorten the base to base+extension
    // of at most MAX_LENGTH, and a kept extension is at most 11 characters.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      expect(sanitizeDownloadFilename(filename).length).toBeLessThanOrEqual(MAX_LENGTH);
    }), {numRuns: 200});
  });

  it('is idempotent: sanitizing a sanitized name changes nothing', () => {
    // A result contains no refused-character replacement target (line 49), no
    // format character (line 50), no unusual space but the ordinary one
    // (lines 51 and 22), no edge dot or space (55-57), a non-reserved
    // underscored-or-not base (67-69) and at most MAX_LENGTH characters
    // (84-93) -- so every rule, run a second time, is a no-op on it.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      const once = sanitizeDownloadFilename(filename);
      expect(sanitizeDownloadFilename(once)).toBe(once);
    }), {numRuns: 200});
  });
});
