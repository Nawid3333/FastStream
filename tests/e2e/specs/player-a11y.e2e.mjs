// What the keyboard and a screen reader get from the player's controls, in the real player
// (the parts that need no page are in tests/unit/playerA11y.test.mjs):
// - the seek bar is a named slider in the tab order, its values follow the video, and the
//   arrows seek from it;
// - Space presses a control the keyboard went to, as a <button>; after a mouse click on one
//   it stays play/pause;
// - a menu button says whether its menu is open.
import {browser, expect} from '@wdio/globals';
import fs from 'node:fs';

const filmUrl = () => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/long-av.mp4`;
const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));

/**
 * Opens the player with no source, autoplay and remembered positions off, and hands it the
 * film (160 s) the way main.mjs does; waits until it shows a frame.
 * @return {Promise<void>}
 */
async function openFilm() {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream?.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  const error = await browser.execute((url) => new Promise((done) => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }), filmUrl());
  expect(error).toBe(null);
  await browser.waitUntil(async () => browser.execute(() => {
    const client = window.fastStream;
    return !!client.player && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }), {timeout: 30000, timeoutMsg: 'the film never loaded'});
}

/**
 * Presses Tab, as the keyboard does, until a control matching the selector has the focus.
 * @param {string} selector
 * @return {Promise<boolean>} Whether one got it within 80 presses.
 */
async function tabTo(selector) {
  for (let i = 0; i < 80; i++) {
    await browser.keys('Tab');
    if (await browser.execute((s) => !!document.activeElement?.matches(s), selector)) return true;
  }
  return false;
}

/**
 * Waits until a read passes a check, and returns the last read.
 * @param {() => Promise<any>} read
 * @param {(value: any) => boolean} check
 * @param {string} what
 * @return {Promise<any>}
 */
async function until(read, check, what) {
  let value;
  try {
    await browser.waitUntil(async () => check(value = await read()), {timeout: 10000, interval: 200});
  } catch (e) {
    throw new Error(`${what}; last: ${JSON.stringify(value)}`);
  }
  return value;
}

const seekBar = () => browser.execute(() => {
  const bar = document.querySelector('.mainplayer .fluid_controls_progress_container');
  return {role: bar.getAttribute('role'), label: bar.getAttribute('aria-label'), min: bar.getAttribute('aria-valuemin'),
    max: bar.getAttribute('aria-valuemax'), now: bar.getAttribute('aria-valuenow'), text: bar.getAttribute('aria-valuetext'),
    shown: document.querySelector('.mainplayer .fluid_control_duration').textContent,
    time: window.fastStream.currentTime, duration: window.fastStream.duration};
});

const rateMenu = () => browser.execute(() => ({
  expanded: document.querySelector('.mainplayer .fluid_button_playback_rate').getAttribute('aria-expanded'),
  paused: window.fastStream.currentVideo.paused,
}));

describe('the player\'s controls, for the keyboard and a screen reader', function() {
  afterEach(async function() {
    await browser.execute(() => window.fastStream?.pause?.());
  });

  it('has a seek bar that is a named slider in the tab order, its values following the video', async function() {
    await openFilm();
    let bar = await seekBar();
    expect(bar).toMatchObject({role: 'slider', label: en.player_seekbar_label.message, min: '0'});
    bar = await until(seekBar, (b) => b.max === String(Math.floor(b.duration)), 'the slider never got the duration');
    expect(bar.max).toBe('160');

    await browser.execute(() => {
      window.fastStream.currentTime = 42;
    });
    bar = await until(seekBar, (b) => b.now === '42', 'the slider\'s value never followed a seek');
    expect(bar.text).toBe(bar.shown);

    // Reached with Tab, the arrows seek from it (the player's own keys, 5 s a press).
    expect(await tabTo('.mainplayer .fluid_controls_progress_container')).toBe(true);
    await browser.keys('ArrowRight');
    bar = await until(seekBar, (b) => b.time >= 46, 'ArrowRight on the seek bar did not seek');
    expect(bar.time).toBeLessThan(50);
  });

  it('presses a control the keyboard went to with Space, and leaves Space to play/pause after a click', async function() {
    await openFilm();
    expect((await rateMenu()).paused).toBe(true);

    // The keyboard: the rate button's menu opens as it gets the focus, and Space presses the
    // button, which closes it. The video does not start.
    expect(await tabTo('.mainplayer .fluid_button_playback_rate')).toBe(true);
    await until(rateMenu, (s) => s.expanded === 'true', 'the rate menu did not open on the keyboard\'s focus');
    await browser.keys(' ');
    let state = await until(rateMenu, (s) => s.expanded === 'false', 'Space did not press the rate button');
    expect(state.paused).toBe(true);

    // The mouse: a click opens the menu; Space is then play/pause, and does not press the button
    // again (its focus is no keyboard focus). From no focus, as a control clicked that the
    // keyboard had not gone to: one it had keeps :focus-visible through a click, as a <button>
    // keeps Space then.
    await browser.execute(() => /** @type {HTMLElement} */ (document.activeElement)?.blur());
    await browser.$('.mainplayer').moveTo();
    await browser.$('.mainplayer .fluid_button_playback_rate').click();
    await until(rateMenu, (s) => s.expanded === 'true', 'a click did not open the rate menu');
    await browser.keys(' ');
    state = await until(rateMenu, (s) => !s.paused, 'Space after a click did not play');
    expect(state.expanded).toBe('true');
  });

  it('leaves Space to the options page\'s fields: a box ticked once, a space typed', async function() {
    // Its fields are set up as the player's controls are (WebUtils.setupTabIndex).
    await browser.url('/player/options/index.html?t=' + Date.now());
    await browser.waitUntil(async () => browser.execute(() => document.querySelectorAll('.keybind-container').length > 0),
        {timeout: 30000, timeoutMsg: 'the options page never rendered'});
    const checked = () => browser.execute(() => /** @type {HTMLInputElement} */ (document.getElementById('downloadall')).checked);
    const before = await checked();
    expect(await tabTo('#downloadall')).toBe(true);
    await browser.keys(' ');
    await browser.pause(200);
    expect(await checked()).toBe(!before);
    await browser.keys(' ');
    await browser.pause(200);
    expect(await checked()).toBe(before);

    expect(await tabTo('#maxspeed')).toBe(true);
    await browser.keys(['1', ' ', '2']);
    expect(await browser.execute(() => /** @type {HTMLInputElement} */ (document.getElementById('maxspeed')).value)).toBe('1 2');
    // Not kept: the field's own check turns it down when it is left (change); cleared first.
    await browser.execute(() => {
      /** @type {HTMLInputElement} */ (document.getElementById('maxspeed')).value = '';
    });
  });

  it('has menu buttons that say whether their menu is open', async function() {
    await openFilm();
    const subtitles = () => browser.execute(() => document.querySelector('.mainplayer .fluid_control_subtitles').getAttribute('aria-expanded'));
    expect(await subtitles()).toBe('false');
    await browser.$('.mainplayer').moveTo();
    await browser.$('.mainplayer .fluid_control_subtitles').click();
    await until(subtitles, (v) => v === 'true', 'the subtitles button did not say its menu opened');
    await browser.$('.mainplayer .fluid_control_subtitles').click();
    await until(subtitles, (v) => v === 'false', 'the subtitles button did not say its menu closed');
  });
});
