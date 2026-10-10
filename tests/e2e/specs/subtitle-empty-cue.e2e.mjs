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
    await browser.execute(() => window.fastStream.currentVideo.pause());
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

        // Both cues span the whole 10 s video, so whatever time it is at, they are on.
        const empty = load('Empty cue', '1\n00:00:00,000 --> 00:00:10,000\n\n' +
          '2\n00:00:10,000 --> 00:00:11,000\nLater\n');
        const other = load('Other', 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nShown\n');
        attempt('activate the empty cue\'s track', () => manager.activateTrack(empty));
        attempt('activate the other track', () => manager.activateTrack(other));

        // The last thing timeUpdated does: it ran to the end.
        let bannerUpdates = 0;
        const updateNextVideoBanner = ui.progressBar.updateNextVideoBanner;
        ui.progressBar.updateNextVideoBanner = function(...args) {
          bannerUpdates++;
          return updateNextVideoBanner.apply(this, args);
        };
        attempt('timeUpdated', () => ui.timeUpdated());
        ui.progressBar.updateNextVideoBanner = updateNextVideoBanner;

        done({
          time: client.state.currentTime,
          cueTexts: empty.cues.map((cue) => cue.text),
          active: manager.activeTracks.map((track) => track.label),
          errors,
          bannerUpdates,
          shown: document.querySelector('.mainplayer .fluid_subtitles_container').textContent,
        });
      }, (e) => done({errors: [String(e)]}));
    });
    console.log('      ', JSON.stringify(result));

    // The case is the one described: the first track's cue at this time has no text.
    expect(result.cueTexts).toEqual(['', 'Later']);
    expect(result.active).toEqual(['Empty cue', 'Other']);

    expect(result.errors).toEqual([]);
    expect(result.bannerUpdates).toBe(1);
    expect(result.shown).toContain('Shown');
  });
});
