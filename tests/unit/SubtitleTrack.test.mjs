import {describe, expect, it} from 'vitest';

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
});
