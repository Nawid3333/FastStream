// A subtitle cue with no text.
//
// A SubRip cue can have nothing under its timestamp; it becomes a WebVTT cue with empty
// text, for which vtt.js's convertCueToDOMTree returns null. renderSubtitles appended that
// null, and appendChild(null) throws: while such a cue was on screen, every timeUpdated()
// stopped there, so a track after it showed nothing and the skip segments were not updated.

import {browser, expect} from '@wdio/globals';

describe('A subtitle cue with no text', function() {
  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.player),
        {timeout: 60000, timeoutMsg: 'the player never loaded'});
    await browser.execute(() => {
      const client = window.fastStream;
      client.currentVideo.pause();
      client.currentTime = 1;
    });
    await browser.waitUntil(async () => browser.execute(() => {
      const time = window.fastStream.state.currentTime;
      return time > 0.5 && time < 4;
    }), {timeout: 20000, timeoutMsg: 'the player never got to 1 s'});
  });

  it('leaves the tracks after it and the rest of the time update running', async function() {
    const result = await browser.executeAsync((done) => {
      import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
        const client = window.fastStream;
        const ui = client.interfaceController;
        const manager = ui.subtitlesManager;
        const errors = [];
        const attempt = (step, fn) => {
          try {
            fn();
          } catch (e) {
            errors.push(`${step}: ${e}`);
          }
        };
        const load = (label, text) => {
          const track = new SubtitleTrack(label, 'en');
          track.loadText(text);
          client.loadSubtitleTrack(track);
          return track;
        };

        const empty = load('Empty cue', '1\n00:00:00,000 --> 00:00:05,000\n\n' +
          '2\n00:00:05,000 --> 00:00:06,000\nLater\n');
        const other = load('Other', 'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nShown\n');
        attempt('activate the empty cue\'s track', () => manager.activateTrack(empty));
        attempt('activate the other track', () => manager.activateTrack(other));

        let skipSegmentUpdates = 0;
        const updateSkipSegments = ui.updateSkipSegments;
        ui.updateSkipSegments = function(...args) {
          skipSegmentUpdates++;
          return updateSkipSegments.apply(this, args);
        };
        attempt('timeUpdated', () => ui.timeUpdated());
        ui.updateSkipSegments = updateSkipSegments;

        done({
          time: client.state.currentTime,
          cueTexts: empty.cues.map((cue) => cue.text),
          active: manager.activeTracks.map((track) => track.label),
          errors,
          skipSegmentUpdates,
          shown: document.querySelector('.mainplayer .fluid_subtitles_container').textContent,
        });
      }, (e) => done({errors: [String(e)]}));
    });
    console.log('      ', JSON.stringify(result));

    // The case is the one described: the first track's cue at this time has no text.
    expect(result.cueTexts).toEqual(['', 'Later']);
    expect(result.active).toEqual(['Empty cue', 'Other']);

    expect(result.errors).toEqual([]);
    expect(result.skipSegmentUpdates).toBe(1);
    expect(result.shown).toContain('Shown');
  });
});
