import {describe, expect, it} from 'vitest';
import fc from 'fast-check';

import {LinkHosts, md, recordsOf, safeUrl} from '../../tools/firefox-api-watch.mjs';

// tools/firefox-api-watch.mjs posts text from Mozilla's release notes, Bugzilla and a blog feed
// into an issue of this repository. Whatever that text holds, the post must not mention anyone,
// reference this repository's issues, carry HTML or a link the text chose, or hide a marker the
// watcher would read back as "already reported". Random text rarely holds those, so the
// generator mixes in the pieces that make them.

const Pieces = ['@', '@owner', '#', '#12', 'GH-7', '<', '>', '<!--', '-->', '<img src=x>', '[', ']', '(', ')', '![x](y)',
  '[a](https://evil.example)', 'https://', 'http://x.y', 'www.', '&', '&#64;', '\\', '*', '_', '|', '~', '\n', String.fromCharCode(0x200b),
  String.fromCharCode(0x2028), 'ffw-item bug:1', '<!-- ffw-item bug:12 -->', '<!-- firefox-api-watch:release 161 -->', 'deadbeef12', ' '];
const piece = fc.oneof(fc.constantFrom(...Pieces), fc.string({maxLength: 6}));
const adversarial = fc.array(piece, {maxLength: 40}).map((parts) => parts.join(''));
const noBackticks = adversarial.map((s) => s.replace(/`/g, ''));

describe('md() on outside text', () => {
  it('never forges a marker the watcher would read back', () => {
    fc.assert(fc.property(fc.oneof(adversarial, fc.string()), (text) => {
      const {aliases, releases} = recordsOf([md(text)]);
      expect(aliases.size).toBe(0);
      expect(releases.size).toBe(0);
    }), {numRuns: 2000});
  });

  it('outside code: no HTML, mention, issue reference, chosen link or autolink', () => {
    fc.assert(fc.property(noBackticks, (text) => {
      const out = md(text);
      expect(out).not.toMatch(new RegExp('[<\\n' + String.fromCharCode(0x2028) + ']'));
      expect(out).not.toMatch(/@[\w-]/);
      expect(out).not.toMatch(/(?<!&)#\d/);
      expect(out).not.toMatch(/GH-\d/i);
      expect(out).not.toMatch(/:\/\//);
      expect(out).not.toMatch(/\bwww\./i);
      // Every bracket is escaped, so no [text](url) or ![image](url) can form.
      expect(out).not.toMatch(/(?<!\\)[[\]]/);
    }), {numRuns: 2000});
  });

  it('a code span stays one line of code and holds no comment opener', () => {
    fc.assert(fc.property(fc.string({maxLength: 100}).map((s) => '`' + s.replace(/[`\n]/g, '') + '`'), (span) => {
      const out = md(span);
      expect(out).not.toContain('<!--');
      expect(out).not.toMatch(/\n/);
    }), {numRuns: 1000});
  });

  it('answers for any input, within its limit', () => {
    fc.assert(fc.property(fc.string({maxLength: 3000}), fc.integer({min: 10, max: 600}), (text, limit) => {
      const out = md(text, limit);
      // Escapes and zero-width entities make it longer, never more than eight times.
      expect(out.length).toBeLessThanOrEqual(limit * 8 + 8);
    }), {numRuns: 500});
  });
});

describe('safeUrl()', () => {
  it('lets through only https links to the allowed hosts, with nothing that ends a Markdown link', () => {
    const url = fc.oneof(fc.webUrl(), fc.string(), fc.constantFrom('https://bugzil.la/1', 'https://developer.mozilla.org/a (b)', 'javascript:alert(1)',
        'https://user:pw@bugzil.la/', 'https://bugzil.la.evil.example/'));
    fc.assert(fc.property(url, (raw) => {
      const out = safeUrl(raw);
      if (out === '') return;
      const parsed = new URL(out);
      expect(parsed.protocol).toBe('https:');
      expect(LinkHosts.has(parsed.hostname)).toBe(true);
      expect(out).not.toMatch(/[()\s<>"'`\\]/);
    }), {numRuns: 2000});
  });
});
