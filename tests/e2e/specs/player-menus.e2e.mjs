// The player's menus and the small controls in them: the quality, audio and language
// menus' keys, the silence skipper's speed, the loop menu's GIF, and the dropdown and knob
// components.
//
// Each case opens the web player with no source and hands it one the way main.mjs does,
// with autoplay and remembered positions off.
import fs from 'node:fs';
import {browser, expect} from '@wdio/globals';

const de = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/de/messages.json', import.meta.url), 'utf8'));
const mp4Url = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/sample.mp4`;
const hlsUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/hls-audio/master.m3u8`;

/**
 * Opens the player with no source, autoplay and remembered positions off.
 * @return {Promise<void>}
 */
async function openEmptyPlayer() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  // main.mjs applies the stored options once the client exists, which would undo the
  // overrides below; it sets optionsApplied when it has.
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  await browser.execute(() => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
  });
}

/**
 * Hands the player a source, as main.mjs does for a URL in the page's hash.
 * @param {string} url - The source.
 * @return {Promise<void>}
 */
async function addSource(url) {
  const error = await browser.executeAsync((url, done) => {
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }, url);
  expect(error).toBe(null);
}

/**
 * Waits until the video the player shows has a frame to show.
 * @return {Promise<void>}
 */
async function waitForPicture() {
  await browser.waitUntil(async () => browser.execute(() => {
    const client = window.fastStream;
    return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }), {timeout: 30000, timeoutMsg: 'the video never loaded'});
}

/**
 * Focuses a menu's button, which opens its menu, then closes the menu as a click on the
 * button does; the button keeps the focus. Then presses ArrowDown on it.
 * @param {string} changer - The InterfaceController property of the menu.
 * @param {string} selector - The menu's button.
 * @return {Promise<{wasOpen: boolean, volume: number}>} Whether focusing opened the
 *     menu, and the volume after the press, which starts at 1.
 */
async function arrowDownOnClosedMenu(changer, selector) {
  return browser.execute((changer, selector) => {
    const client = window.fastStream;
    client.volume = 1;
    const menu = client.interfaceController[changer];
    const button = document.querySelector(selector);
    button.focus();
    const wasOpen = menu.isOpen();
    menu.closeUI();
    button.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true}));
    return {wasOpen, volume: client.volume};
  }, changer, selector);
}

/**
 * Reads a value until it passes a check or the time is up, and gives the last one read.
 * @param {function(): Promise<*>} read - Reads the value.
 * @param {function(*): boolean} check - Whether it is the one waited for.
 * @param {number} [timeout] - How long to wait, in ms.
 * @return {Promise<*>}
 */
async function settle(read, check, timeout = 10000) {
  let value;
  await browser.waitUntil(async () => check(value = await read()), {timeout, interval: 100}).catch(() => {});
  return value;
}

describe('Player menus', function() {
  it('lets the arrow keys through the quality button once its list is closed', async function() {
    // They moved a highlight in the hidden list, and Enter then switched the quality.
    await openEmptyPlayer();
    await addSource(hlsUrl());
    await waitForPicture();
    await browser.waitUntil(async () => browser.execute(
        () => document.querySelector('.mainplayer .fluid_video_sources_list').children.length > 0),
    {timeout: 10000, timeoutMsg: 'the quality list stayed empty'});
    const state = await arrowDownOnClosedMenu('videoQualityChanger', '.mainplayer .fluid_control_video_source');
    console.log('      quality button:', JSON.stringify(state));
    expect(state.wasOpen).toBe(true);
    expect(state.volume).toBeCloseTo(0.9, 5);
  });

  it('lets the arrow keys through the audio button once its list is closed', async function() {
    await openEmptyPlayer();
    await addSource(hlsUrl());
    await waitForPicture();
    await browser.waitUntil(async () => browser.execute(
        () => document.querySelector('.mainplayer .fluid_audio_sources_list').children.length > 0 &&
          window.fastStream.interfaceController.audioQualityChanger.enabled),
    {timeout: 10000, timeoutMsg: 'the audio list stayed empty'});
    const state = await arrowDownOnClosedMenu('audioQualityChanger', '.mainplayer .fluid_button_soundwave');
    console.log('      audio button:', JSON.stringify(state));
    expect(state.wasOpen).toBe(true);
    expect(state.volume).toBeCloseTo(0.9, 5);
  });

  it('keeps the language menu\'s keys to its own tracks, and lets them through once closed', async function() {
    // The highlight could rest on the empty cell of a language with no track of that
    // type, and the keys moved it while the menu was closed.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    const state = await browser.execute(() => {
      const client = window.fastStream;
      const languageChanger = client.interfaceController.languageChanger;
      // Video in de and en, audio in en and fr: de has no audio, fr no video.
      const levels = (list) => new Map(list.map((level) => [level.id, level]));
      languageChanger.updateLanguageTracks({
        getVideoLevels: () => levels([{id: 'v-de', language: 'de'}, {id: 'v-en', language: 'en'}]),
        getAudioLevels: () => levels([{id: 'a-en', language: 'en'}, {id: 'a-fr', language: 'fr'}]),
        getLevelManager: () => ({getCurrentVideoLevelID: () => 'v-en', getCurrentAudioLevelID: () => 'a-en'}),
      });
      return {found: !document.querySelector('.mainplayer .fluid_control_language').classList.contains('hidden')};
    });
    expect(state.found).toBe(true);
    const moves = await browser.execute(() => {
      const client = window.fastStream;
      client.volume = 1;
      const languageChanger = client.interfaceController.languageChanger;
      const button = document.querySelector('.mainplayer .fluid_control_language');
      const press = () => button.dispatchEvent(new KeyboardEvent('keydown',
          {key: 'ArrowDown', code: 'ArrowDown', bubbles: true, cancelable: true}));
      button.focus();
      const wasOpen = languageChanger.isOpen();
      const landedOn = [];
      for (let i = 0; i < 4; i++) {
        press();
        const candidate = document.querySelector('.mainplayer .language_track.candidate');
        landedOn.push(candidate ? (candidate.classList.contains('language_track_filler') ? 'filler' : candidate.dataset.type) : 'none');
      }
      languageChanger.closeUI();
      press();
      return {wasOpen, landedOn, volume: client.volume};
    });
    console.log('      language menu:', JSON.stringify(moves));
    expect(moves.wasOpen).toBe(true);
    // The two audio tracks, then the two video tracks: never the filler, and never
    // nowhere, as a filter that dropped every track would give.
    expect(moves.landedOn).toEqual(['audio', 'audio', 'video', 'video']);
    expect(moves.volume).toBeCloseTo(0.9, 5);
  });

  it('puts the regular speed back when the silence skipper is turned off in a silence', async function() {
    // The skip speed stayed, and so it did for the next video.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    // The skipper sets the speed on its own time, so each read waits for the one expected.
    const speedAfter = async (action, check) => {
      await browser.execute((action) => {
        const changer = window.fastStream.interfaceController.playbackRateChanger;
        if (action === 'on') {
          // The audio is silent here, as the analyzer would find it.
          changer.shouldSkipSilence = () => true;
          changer.enableSilenceSkipper();
        } else {
          changer.disableSilenceSkipper();
        }
      }, action);
      return settle(() => browser.execute(() => ({
        rate: window.fastStream.playbackRate,
        skipSpeed: window.fastStream.interfaceController.playbackRateChanger.silenceSkipSpeed,
      })), check);
    };
    const skipping = await speedAfter('on', (state) => state.rate > 1 && state.rate === state.skipSpeed);
    console.log('      skipping:', JSON.stringify(skipping));
    expect(skipping.rate).toBe(skipping.skipSpeed);
    expect(skipping.rate).toBeGreaterThan(1);
    const off = await speedAfter('off', (state) => state.rate === 1);
    console.log('      turned off:', JSON.stringify(off));
    expect(off.rate).toBe(1);

    // Skipping again, so the next video starts from a skip speed.
    const again = await speedAfter('on', (state) => state.rate > 1);
    expect(again.rate).toBeGreaterThan(1);
    await addSource(mp4Url() + '?next');
    await waitForPicture();
    const next = await browser.execute(() => window.fastStream.playbackRate);
    console.log('      next video:', next);
    expect(next).toBe(1);
  });

  it('records a GIF of the whole video when both loop times are emptied', async function() {
    // An emptied field was NaN, and the recording never started nor ended.
    await openEmptyPlayer();
    await addSource(mp4Url());
    await waitForPicture();
    await browser.execute(() => {
      const loopControls = window.fastStream.interfaceController.loopControls;
      // The finished GIF would be downloaded; count its frames instead.
      loopControls.finishGif = function() {
        window.__gif = {frames: this.gif ? this.gif.frames.length : -1};
        this.gif?.abort();
        this.gif = null;
        this.recordingGif = false;
        this.gifLoopRunning = false;
      };
      for (const name of ['start', 'end']) {
        const input = document.querySelector(`.mainplayer input[name="${name}"]`);
        input.value = '';
        input.dispatchEvent(new Event('input', {bubbles: true}));
      }
      document.querySelector('.mainplayer .loop_menu_gif_button').click();
    });
    let state;
    await browser.waitUntil(async () => {
      state = await browser.execute(() => ({
        gif: window.__gif || null,
        running: window.fastStream.interfaceController.loopControls.gifLoopRunning,
        rate: window.fastStream.playbackRate,
      }));
      return !!state.gif;
    }, {timeout: 15000, interval: 500}).catch(() => {});
    console.log('      gif:', JSON.stringify(state));
    expect(state.gif).not.toBe(null);
    expect(state.gif.frames).toBeGreaterThan(0);
    expect(state.running).toBe(false);
  });

  it('names a dropdown\'s new value when the keyboard changes it', async function() {
    // Only a click on an item renamed it, so a screen reader kept the old value.
    await openEmptyPlayer();
    const label = await browser.executeAsync((done) => {
      import('/player/ui/components/Dropdown.mjs').then(({createDropdown}) => {
        const dropdown = createDropdown('a', 'Mode', {a: 'Alpha', b: 'Beta'}, () => {});
        document.body.appendChild(dropdown);
        dropdown.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowDown', bubbles: true, cancelable: true}));
        done(dropdown.ariaLabel);
      }).catch((e) => done('failed: ' + e));
    });
    expect(label).toBe('Mode: Beta');
  });

  it('labels the subtitle search\'s fields in the player\'s language', async function() {
    // The type filter's label was the English "Type" in every language (the filter is gone
    // since 2026-10-09: a season or episode filled in makes an episode's search).
    await openEmptyPlayer();
    const shown = await browser.executeAsync((done) => {
      // The web player takes its language from the browser; the search is built again
      // with the browser in German.
      Object.defineProperty(navigator, 'language', {value: 'de', configurable: true});
      import('/player/ui/subtitles/OpenSubtitlesSearch.mjs').then(({OpenSubtitlesSearch}) => {
        const {subui} = new OpenSubtitlesSearch(window.fastStream.version);
        done({season: subui.seasonInput.ariaLabel, episode: subui.episodeInput.placeholder, year: subui.yearInput.placeholder});
      }).catch((e) => done({error: String(e)}));
    });
    console.log('      fields:', JSON.stringify(shown));
    expect(shown).toEqual({season: de.player_opensubtitles_seasonnum.message, episode: de.player_opensubtitles_episodenum.message,
      year: de.player_opensubtitles_year.message});
    expect(shown.season).not.toBe('Season #');
  });

  it('keeps a knob\'s value when its field is emptied and left', async function() {
    // parseFloat('') is NaN, and the knob handed NaN on to its setting.
    await openEmptyPlayer();
    const empty = (suggested) => browser.executeAsync((suggested, done) => {
      import('/player/ui/components/Knob.mjs').then(({createKnob}) => {
        const values = [];
        const knob = createKnob('Gain', 0, 20, (value) => values.push(value), 'dB');
        document.querySelector('.mainplayer').appendChild(knob.container);
        setTimeout(() => {
          knob.knob.val(5);
          if (suggested !== null) knob.setSuggestedValue(suggested);
          const field = knob.container.querySelector('.knob_value');
          field.focus();
          field.textContent = '';
          field.blur();
          // NaN comes back from the page as null.
          done({values, now: knob.knob.val(), shown: field.textContent});
        }, 50);
      }).catch((e) => done({error: String(e)}));
    }, suggested);
    const plain = await empty(null);
    console.log('      knob:', JSON.stringify(plain));
    expect(plain.values.includes(null)).toBe(false);
    expect(plain.now).toBe(5);
    expect(plain.shown).toBe('5.0 dB');
    // A knob with a suggested value goes to it, which is how its "auto" is chosen.
    const withSuggestion = await empty(12);
    console.log('      knob with a suggested value:', JSON.stringify(withSuggestion));
    expect(withSuggestion.now).toBe(12);
  });
});
