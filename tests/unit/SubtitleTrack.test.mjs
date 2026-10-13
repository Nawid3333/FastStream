import {describe, expect, it, vi} from 'vitest';

import {installFakeDom} from './fakeCueDom.mjs';

// SubtitleTrack.loadText is where every subtitle file ends up: from a URL, a file, the
// page (EmbedAPI, the content script's detected subtitles) and OpenSubtitles. The page
// paths hand it strings as they are, so it is the one place to make them parseable.

installFakeDom();
const {SubtitleTrack} = await import('../../chrome/player/SubtitleTrack.mjs');

const BOM = String.fromCharCode(0xfeff);

/**
 * Loads a file into a new track.
 * @param {string} text - The file.
 * @return {Array<Array>} Each cue's start, end and text.
 */
function load(text) {
  const track = new SubtitleTrack('Test', 'en');
  track.loadText(text);
  return track.cues.map((cue) => [cue.startTime, cue.endTime, cue.text]);
}

describe('SubtitleTrack.loadText', () => {
  it('reads a WebVTT file that starts with a byte order mark', () => {
    // It was taken for WebVTT (trim() drops U+FEFF) but the parser saw it before "WEBVTT":
    // "Malformed WebVTT signature" and no cue.
    expect(load(BOM + 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n')).toEqual([[0, 1, 'Hello']]);
  });

  it('reads a SubRip file that starts with a byte order mark', () => {
    expect(load(BOM + '1\n00:00:01,000 --> 00:00:02,000\nHello\n')).toEqual([[1, 2, 'Hello']]);
  });

  it('reads a file holding a lone surrogate instead of throwing "URI malformed"', () => {
    // The parser's decoder is decodeURIComponent(encodeURIComponent(text)), which throws
    // on a lone surrogate, before the parser's own error handling.
    const text = 'WEBVTT\n\n00:00.000 --> 00:01.000\nA' + String.fromCharCode(0xd800) + 'B\n';
    expect(load(text)).toEqual([[0, 1, 'A' + String.fromCharCode(0xfffd) + 'B']]);
  });

  it('keeps every cue of a track whose cues overlap, sorted by start', () => {
    const text = 'WEBVTT\n\n00:10.000 --> 00:12.000\nl1\n\n00:00.000 --> 01:40.000\nSIGN\n\n' +
      '00:11.000 --> 00:13.000\nl2\n';
    expect(load(text)).toEqual([[0, 100, 'SIGN'], [10, 12, 'l1'], [11, 13, 'l2']]);
  });

  // vtt.js accepts only HH:MM:SS.mmm with exactly three digits and drops a cue it cannot
  // read without a word, so a loose SubRip file lost cues silently. SubtitleUtils.test.mjs
  // pins each rule of the conversion; this runs a file with all of them through the
  // conversion and the parser the player uses, as loadText does. (Until 2026-10-13 this
  // was specs/subtitle-parsing.e2e.mjs: the conversion and vtt.js are plain JavaScript,
  // and the parser builds the same cues in Firefox, where subtitle-empty-cue.e2e.mjs and
  // subtitle-overlap.e2e.mjs load SubRip files through it.)
  it('keeps every cue of a loosely written SubRip file, with its times and text', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      'Comma separator',
      '',
      '2',
      '00:00:03.000 --> 00:00:04.000',
      'Full stop separator',
      '',
      '',
      '3',
      '00:00:05 --> 00:00:06',
      'No milliseconds after two blank lines',
      ' ',
      '4',
      '00:00:07,5 --> 00:00:08,25',
      'Short milliseconds after a blank line with a space',
      '',
      '00:00:09,000 --> 00:00:10,000',
      'No sequence number,',
      'two lines of text',
      '',
    ].join('\r\n');
    expect(load(srt)).toEqual([
      [1, 2, 'Comma separator'],
      [3, 4, 'Full stop separator'],
      [5, 6, 'No milliseconds after two blank lines'],
      [7.005, 8.025, 'Short milliseconds after a blank line with a space'],
      [9, 10, 'No sequence number,\ntwo lines of text'],
    ]);
  });
});

describe('SubtitleTrack.loadURL', () => {
  // An embedding page's subtitle link that answered 404 was read as a file without cues.
  it('says the server refused the file', async () => {
    vi.stubGlobal('fetch', async () => ({ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0),
      headers: {get: () => 'text/html'}}));
    try {
      await expect(new SubtitleTrack('a').loadURL('https://example.com/a.srt')).rejects.toThrow('Bad status code: 404');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
