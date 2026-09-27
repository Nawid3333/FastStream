// The subtitle toggle (C) after the track list has changed.
//
// Toggling subtitles off remembers which tracks were on, and toggling on again turns those
// back on. The memory outlived the tracks: when the list was cleared - new sources for
// another video (main.mjs), the menu's Clear button - or a remembered track was removed,
// the next press tried to turn on tracks that were gone, turned on nothing, and logged
// "Cannot activate track that is not loaded" for each; only a second press turned a track
// on. With no track at all, every press logged the same error for `undefined`.

import {browser, expect} from '@wdio/globals';

const pressC = () => browser.execute(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyC', key: 'c', bubbles: true, cancelable: true}));
});

const active = () => browser.execute(() => {
  return window.fastStream.interfaceController.subtitlesManager.activeTracks.map((track) => track.label);
});

describe('Subtitle toggle', function() {
  before(async function() {
    await browser.url('/player/index.html?t=' + Date.now() + '#' +
      globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/sample.mp4');
    await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.player),
        {timeout: 60000, timeoutMsg: 'the player never loaded'});
    await browser.execute(() => {
      window.__subtitleErrors = [];
      const error = console.error;
      console.error = (...args) => {
        if (String(args[0]).includes('Cannot activate track')) {
          window.__subtitleErrors.push(String(args[0]));
        }
        return error.apply(console, args);
      };
    });
  });

  /**
   * Loads a one-cue track into the player.
   * @param {string} label - The track's label.
   * @return {Promise<void>}
   */
  const addTrack = (label) => browser.executeAsync((label, done) => {
    import('/player/SubtitleTrack.mjs').then(({SubtitleTrack}) => {
      const track = new SubtitleTrack(label, 'en');
      track.loadText(`WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n${label}\n`);
      window.fastStream.loadSubtitleTrack(track);
      done();
    });
  }, label);

  it('does nothing, without an error, when there is no track', async function() {
    await pressC();
    expect(await active()).toEqual([]);
    expect(await browser.execute(() => window.__subtitleErrors)).toEqual([]);
  });

  it('turns the new video\'s track on at the first press after the list was cleared', async function() {
    await addTrack('First video');
    await pressC();
    expect(await active()).toEqual(['First video']);
    await pressC();
    expect(await active()).toEqual([]);

    // What happens when another source is set: the list is cleared, the new one loaded.
    await browser.execute(() => window.fastStream.clearSubtitles());
    await addTrack('Second video');

    await pressC();
    expect(await active()).toEqual(['Second video']);
    expect(await browser.execute(() => window.__subtitleErrors)).toEqual([]);
  });

  it('still turns back on exactly the tracks that were on', async function() {
    await browser.execute(() => window.fastStream.clearSubtitles());
    await addTrack('One');
    await addTrack('Two');
    await browser.execute(() => {
      const manager = window.fastStream.interfaceController.subtitlesManager;
      manager.activateTrack(manager.tracks.find((track) => track.label === 'Two'));
    });
    await pressC();
    expect(await active()).toEqual([]);
    await pressC();
    expect(await active()).toEqual(['Two']);
  });
});
