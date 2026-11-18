import {describe, expect, it} from 'vitest';

import fc from 'fast-check';

import {sanitizeDownloadFilename} from '../../chrome/background/DownloadFilename.mjs';

// Anything a web page hands over ends up in the sanitizer: non-empty, no refused characters, clean
// edges, no device names, <= 200 characters, idempotent.

const MAX_LENGTH = 200; // line 27 of DownloadFilename.mjs

// The refused class: quotes, colon, angle brackets, slashes, pipe, ?, * and control characters. No
// /g: test() stays stateless.
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
    // The refused class is replaced, and the later edits only delete, map separators to a space,
    // strip, prefix '_' or cut clean text.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      const result = sanitizeDownloadFilename(filename);
      expect(REFUSED.test(result)).toBe(false);
    }), {numRuns: 200});
  });

  it('neither starts nor ends with a dot or a space', () => {
    // Both edges are stripped, again after a length cut; a kept extension ends inside its own text.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      const result = sanitizeDownloadFilename(filename);
      expect(/^[. ]/.test(result)).toBe(false);
      expect(/[. ]$/.test(result)).toBe(false);
    }), {numRuns: 200});
  });

  it('never leaves a reserved DOS device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, any case, with or without extension) before the first dot', () => {
    // A device name is underscored before the extension split and the cut, which keeps the leading
    // characters.
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
    // A result holds nothing any rule acts on, and fits MAX_LENGTH: every rule run again is a
    // no-op.
    fc.assert(fc.property(arbitraryFilename, (filename) => {
      const once = sanitizeDownloadFilename(filename);
      expect(sanitizeDownloadFilename(once)).toBe(once);
    }), {numRuns: 200});
  });
});
