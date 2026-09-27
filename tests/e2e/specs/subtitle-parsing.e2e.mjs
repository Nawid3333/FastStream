// SubRip files as they come, through the real WebVTT parser.
//
// Every subtitle the player loads - a dropped file, an OpenSubtitles download, a track the
// page carries - goes through SubtitleTrack.loadText(), which converts SubRip to WebVTT and
// hands it to vtt.js. vtt.js accepts only HH:MM:SS.mmm with exactly three digits and drops
// a cue it cannot read without a word, so a loose SubRip file lost cues silently: a full
// stop as the millisecond separator, no milliseconds, fewer than three digits, two blank
// lines between cues, a blank line holding a space, and a cue without a sequence number
// whose text runs over two lines. tests/unit/SubtitleUtils.test.mjs pins the conversion;
// this checks what the parser the player uses makes of it.

import {browser, expect} from '@wdio/globals';

const SRT = [
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

describe('SubRip parsing through vtt.js', function() {
  it('keeps every cue of a loosely written SubRip file, with its times and text', async function() {
    await browser.url('/player/index.html?t=' + Date.now());
    await browser.execute((srt) => {
      window.__cues = undefined;
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const track = new SubtitleTrack('test', 'en');
        track.loadText(srt);
        window.__cues = track.cues.map((cue) => ({start: cue.startTime, end: cue.endTime, text: cue.text}));
      }).catch((e) => {
        window.__cues = {error: String(e)};
      });
    }, SRT);
    await browser.waitUntil(async () => browser.execute(() => window.__cues !== undefined),
        {timeout: 15000, timeoutMsg: 'the track never loaded'});
    const cues = await browser.execute(() => window.__cues);
    console.log('      cues:', JSON.stringify(cues));

    expect(cues).toEqual([
      {start: 1, end: 2, text: 'Comma separator'},
      {start: 3, end: 4, text: 'Full stop separator'},
      {start: 5, end: 6, text: 'No milliseconds after two blank lines'},
      {start: 7.005, end: 8.025, text: 'Short milliseconds after a blank line with a space'},
      {start: 9, end: 10, text: 'No sequence number,\ntwo lines of text'},
    ]);
  });
});
