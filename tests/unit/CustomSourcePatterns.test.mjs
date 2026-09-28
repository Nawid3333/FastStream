import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseCustomSourcePatterns} from '../../chrome/background/CustomSourcePatterns.mjs';
import {MultiRegexMatcher} from '../../chrome/background/MultiRegexMatcher.mjs';

// "Custom source patterns" is a text option: `<type> /<regex>/<flags>` per line. The old
// parser in background.mjs took whatever sat between the first character and the last
// slash, so a malformed line became a pattern anyway. `hls` alone was the empty regex,
// which matches every URL: every response the browser got was detected as an HLS
// stream. Malformed lines are now left out, with the reason.

describe('parseCustomSourcePatterns', () => {
  it('parses well-formed lines', () => {
    const {patterns, errors} = parseCustomSourcePatterns([
      'hls /\\/live\\/\\d+/i',
      '  mp4   /video\\.cdn\\.example\\/[a-z]+/  ',
      'dash /manifest with spaces/ms',
    ].join('\n'));
    expect(errors).toEqual([]);
    expect(patterns).toEqual([
      {ext: 'hls', regex: '\\/live\\/\\d+', flags: 'i'},
      {ext: 'mp4', regex: 'video\\.cdn\\.example\\/[a-z]+', flags: ''},
      {ext: 'dash', regex: 'manifest with spaces', flags: 'ms'},
    ]);
  });

  it('skips blank lines, comments and @ commands', () => {
    const {patterns, errors} = parseCustomSourcePatterns('\n# comment\n// comment\n@command body\n   \n');
    expect(patterns).toEqual([]);
    expect(errors).toEqual([]);
  });

  it.each([
    ['hls', 'no regex at all'],
    ['hls live', 'a regex without slashes'],
    ['hls /', 'a lone slash'],
    ['hls //', 'the empty regex'],
    ['hls //i', 'the empty regex with a flag'],
    ['hls /live/z', 'an unknown flag'],
    ['hls /(unclosed/', 'an invalid regex'],
  ])('leaves out %s (%s), rather than matching every URL', (line) => {
    const {patterns, errors} = parseCustomSourcePatterns(line);
    expect(patterns).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(1);
  });

  it('keeps the good lines around a bad one, and names the bad one\'s line', () => {
    const {patterns, errors} = parseCustomSourcePatterns('hls /a/\nhls\nmp4 /b/');
    expect(patterns.map((p) => p.ext)).toEqual(['hls', 'mp4']);
    expect(errors.map((e) => e.line)).toEqual([2]);
  });

  it('never yields a pattern that matches an ordinary asset URL', () => {
    const matcher = new MultiRegexMatcher();
    for (const {regex, flags, ext} of parseCustomSourcePatterns('hls\nhls /\nhls //\nhls live\nmp4 /\\.mp4$/').patterns) {
      matcher.addRegex(regex, flags, ext);
    }
    matcher.compile();
    expect(matcher.match('https://example.com/app.js')).toBeNull();
    expect(matcher.match('https://example.com/clip.mp4')).toBe('mp4');
  });
});

describe('background.mjs', () => {
  it('reads custom source patterns through parseCustomSourcePatterns', () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../chrome/background/background.mjs'), 'utf8');
    expect(source).toMatch(/parseCustomSourcePatterns\(fileStr\)/);
    // The old inline parser's signature line.
    expect(source).not.toMatch(/regexStr\.substring\(1, regexStr\.lastIndexOf\('\/'\)\)/);
  });
});
