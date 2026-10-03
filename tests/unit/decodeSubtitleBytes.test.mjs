import fs from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';

import {RequestUtils} from '../../chrome/player/utils/RequestUtils.mjs';
import {SubtitleUtils} from '../../chrome/player/utils/SubtitleUtils.mjs';
import {installFakeDom} from './fakeCueDom.mjs';

// Subtitle files reach the player as bytes, from six places. Read the browser's way (UTF-8
// unless the file or the server says otherwise), an older SubRip file saved as
// Windows-1252 - most of them from Western Europe - showed U+FFFD for every accented
// letter. decodeSubtitleBytes reads such bytes as Windows-1252 instead, and every place
// that turns subtitle bytes into text goes through it.

installFakeDom();
const {SubtitleTrack} = await import('../../chrome/player/SubtitleTrack.mjs');

const char = (code) => String.fromCharCode(code);
// "Grüße, Fräulein! 5 €" and "ÄÖÜ äöü ß", as text and as Windows-1252 bytes.
const GERMAN = 'Gr' + char(0xfc) + char(0xdf) + 'e, Fr' + char(0xe4) + 'ulein! 5 ' + char(0x20ac);
const UMLAUTS = char(0xc4) + char(0xd6) + char(0xdc) + ' ' + char(0xe4) + char(0xf6) + char(0xfc) + ' ' + char(0xdf);
const SRT = '1\r\n00:00:01,000 --> 00:00:02,000\r\n' + GERMAN + '\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n' + UMLAUTS + '\r\n';

/**
 * Text as Windows-1252 bytes (every character of the texts above has one).
 * @param {string} text - The text.
 * @return {Uint8Array}
 */
function windows1252(text) {
  return Uint8Array.from(text, (c) => c === char(0x20ac) ? 0x80 : c.charCodeAt(0));
}

const utf8 = (text) => new TextEncoder().encode(text);
const concat = (...parts) => Uint8Array.from(parts.flatMap((part) => Array.from(part)));

describe('decodeSubtitleBytes', () => {
  it('reads a Windows-1252 SubRip file with umlauts as Windows-1252', () => {
    // As UTF-8 every one of these letters was U+FFFD.
    expect(SubtitleUtils.decodeSubtitleBytes(windows1252(SRT))).toBe(SRT);
    expect(SubtitleUtils.decodeSubtitleBytes(windows1252(SRT).buffer)).toBe(SRT);
  });

  it('leaves a valid UTF-8 file as it was', () => {
    const text = SRT + char(0x4e2d) + char(0x6587) + ' ' + String.fromCodePoint(0x1f600);
    expect(SubtitleUtils.decodeSubtitleBytes(utf8(text))).toBe(text);
    expect(SubtitleUtils.decodeSubtitleBytes(new ArrayBuffer(0))).toBe('');
  });

  it('drops a UTF-8 byte order mark and reads the rest as UTF-8, as before', () => {
    const bom = [0xef, 0xbb, 0xbf];
    expect(SubtitleUtils.decodeSubtitleBytes(concat(bom, utf8(SRT)))).toBe(SRT);
    // A file that says it is UTF-8 stays UTF-8, a bad byte in it the replacement mark.
    expect(SubtitleUtils.decodeSubtitleBytes(concat(bom, utf8('a'), [0xfc], utf8('b'))))
        .toBe('a' + char(0xfffd) + 'b');
  });

  it('reads a UTF-16 file by its byte order mark, as the browser\'s own reading did', () => {
    const le = [0xff, 0xfe, ...Array.from(SRT).flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])];
    const be = [0xfe, 0xff, ...Array.from(SRT).flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])];
    expect(SubtitleUtils.decodeSubtitleBytes(Uint8Array.from(le))).toBe(SRT);
    expect(SubtitleUtils.decodeSubtitleBytes(Uint8Array.from(be))).toBe(SRT);
  });

  it('follows a charset the server declared, unless it is UTF-8 and the bytes are not', () => {
    // windows-1251: the bytes of "Привет".
    const russian = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
    const privet = [0x41f, 0x440, 0x438, 0x432, 0x435, 0x442].map(char).join('');
    expect(SubtitleUtils.decodeSubtitleBytes(russian, 'text/plain; charset=windows-1251')).toBe(privet);
    expect(SubtitleUtils.decodeSubtitleBytes(russian, 'text/plain;charset="Windows-1251"')).toBe(privet);
    expect(SubtitleUtils.decodeSubtitleBytes(windows1252(SRT), 'text/srt; charset=utf-8')).toBe(SRT);
    expect(SubtitleUtils.decodeSubtitleBytes(windows1252(SRT), 'text/srt; charset=no-such-thing')).toBe(SRT);
    expect(SubtitleUtils.decodeSubtitleBytes(windows1252(SRT), null)).toBe(SRT);
    expect(SubtitleUtils.decodeSubtitleBytes(utf8(SRT), 'text/vtt; charset=utf-8')).toBe(SRT);
  });
});

describe('decodeSubtitleBytes at the places subtitle files come in', () => {
  const fetchBefore = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = fetchBefore;
  });

  it('reads a Windows-1252 file loaded by URL (a dropped file, an embedder\'s URL)', async () => {
    globalThis.fetch = async () => new Response(windows1252(SRT), {headers: {'Content-Type': 'application/x-subrip'}});
    const track = new SubtitleTrack('Test', 'de');
    await track.loadURL('blob:test');
    expect(track.cues.map((cue) => cue.text)).toEqual([GERMAN, UMLAUTS]);
  });

  it('gets the bytes of a URL typed in from requestSimple, which read responseText', async () => {
    // responseText throws for an 'arraybuffer' request, as it does in the browser.
    const xhrBefore = globalThis.XMLHttpRequest;
    globalThis.XMLHttpRequest = class {
      constructor() {
        this.listeners = {};
        this.responseType = '';
        this.status = 0;
      }
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      }
      open() {}
      setRequestHeader() {}
      getResponseHeader() {
        return null;
      }
      send() {
        this.status = 200;
        this.response = this.responseType === 'arraybuffer' ? windows1252(SRT).buffer : null;
        setTimeout(() => this.listeners.load(), 0);
      }
      get responseText() {
        if (this.responseType !== '' && this.responseType !== 'text') {
          throw new DOMException('responseText is only for text', 'InvalidStateError');
        }
        return '';
      }
    };
    try {
      let body = null;
      await RequestUtils.requestSimple({url: 'https://subs.example/de.srt', responseType: 'arraybuffer'}, (err, xhr, bytes) => {
        body = bytes;
      });
      expect(SubtitleUtils.decodeSubtitleBytes(body)).toBe(SRT);
    } finally {
      globalThis.XMLHttpRequest = xhrBefore;
    }
  });

  // The other five need a page to run in. Each is checked to decode with
  // decodeSubtitleBytes, and to no longer let the browser decode the bytes.
  const read = (path) => fs.readFileSync(new URL('../../chrome/' + path, import.meta.url), 'utf8');
  const CALL_SITES = {
    'player/SubtitleTrack.mjs': 'loadURL: dropped and opened files, an embedder\'s URLs',
    'player/ui/subtitles/SubtitlesManager.mjs': 'a file from disk; a URL typed in',
    'player/ui/subtitles/OpenSubtitlesSearch.mjs': 'an OpenSubtitles download',
    'player/main.mjs': 'subtitle files the page loaded',
    'content.js': 'the page\'s <track> elements',
  };

  for (const [path, what] of Object.entries(CALL_SITES)) {
    it(`${path} (${what}) decodes with decodeSubtitleBytes`, () => {
      const source = read(path);
      expect(source).toMatch(/decodeSubtitleBytes\(/);
      expect(source).not.toMatch(/\.responseText\b|readAsText\(|response\.text\(\)/);
    });
  }

  it('SubtitlesManager decodes both of its files that way', () => {
    expect(read('player/ui/subtitles/SubtitlesManager.mjs').match(/decodeSubtitleBytes\(/g)).toHaveLength(2);
  });

  it('content.js carries the same decodeSubtitleBytes', () => {
    // content.js is a classic script and cannot import SubtitleUtils, so it has a copy.
    const body = (source, signature) => {
      const start = source.indexOf(signature);
      expect(start, signature).toBeGreaterThan(-1);
      let depth = 0;
      for (let i = source.indexOf('{', start); i < source.length; i++) {
        depth += source[i] === '{' ? 1 : source[i] === '}' ? -1 : 0;
        if (depth === 0) {
          return source.slice(source.indexOf('{', start), i + 1).split('\n').map((line) => line.trim()).join('\n');
        }
      }
      throw new Error('unbalanced ' + signature);
    };
    const copy = body(read('content.js'), 'function decodeSubtitleBytes(data, contentType) {');
    const helper = body(read('player/utils/SubtitleUtils.mjs'), 'static decodeSubtitleBytes(data, contentType) {');
    expect(copy.split('\n').length).toBeGreaterThan(10);
    expect(copy).toBe(helper);
  });
});
