import fs from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// What a keyboard or screen reader user gets from the player's controls (#270):
// - the volume block is a role="slider" with no value a screen reader could read;
// - Tab skipped the big play button;
// - the toolbar buttons had no focus ring of their own.
// And from #277: the pages did not say which language they are in, and the controls
// faded in and out (and the buttons being rearranged shook) whatever the system said.
// And from the review of 2026-11-13: Space did not press a control the keyboard went to, the
// menu buttons did not say whether their menu was open, and the seek bar was no slider.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {AudioContext: class {}});
const el = () => doc.body.appendChild(doc.createElement('div'));
globalThis.__playerA11yDom = {
  currentVolume: el(), muteBtn: el(), currentVolumeText: el(), volumeBanner: el(), volumeBlock: el(), volumeUnity: el(),
  languageButton: el(), languageMenu: el(), audioTracksBtn: el(), audioSourceList: el(), videoSource: el(), videoSourceList: el(),
};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__playerA11yDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key, subs) => `${key} ${subs}`, getLanguage: () => 'de'}}));

const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
vi.spyOn(Utils, 'setConfig').mockResolvedValue();
const {VolumeControls} = await import('../../chrome/player/ui/VolumeControls.mjs');
const {WebUtils} = await import('../../chrome/player/utils/WebUtils.mjs');
const {LanguageChanger} = await import('../../chrome/player/ui/menus/LanguageChanger.mjs');
const {AudioQualityChanger} = await import('../../chrome/player/ui/menus/AudioQualityChanger.mjs');
const {VideoQualityChanger} = await import('../../chrome/player/ui/menus/VideoQualityChanger.mjs');

describe('a control the keyboard went to', () => {
  /**
   * A control set up as the player's are; :focus-visible as Firefox has it (keyboard focus, not a click's).
   * @param {boolean} focusVisible
   */
  const control = (focusVisible) => {
    const element = {tabIndex: -1, role: '', clicks: 0, listeners: /** @type {Record<string, Function>} */ ({}),
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
      click() {
        this.clicks++;
      },
      matches: (selector) => selector === ':focus-visible' && focusVisible};
    WebUtils.setupTabIndex(/** @type {any} */ (element));
    return element;
  };
  const key = (name, extra = {}) => ({key: name, repeat: false, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra});

  it('is a button in the tab order, pressed by Enter and by Space as a <button> is', () => {
    const button = control(true);
    expect(button.tabIndex).toBe(0);
    expect(button.role).toBe('button');
    button.listeners.keydown(key('Enter'));
    const space = key(' ');
    button.listeners.keydown(space);
    expect(button.clicks).toBe(2);
    // Not the player's play/pause too, and no page scroll.
    expect(space.stopPropagation).toHaveBeenCalled();
    expect(space.preventDefault).toHaveBeenCalled();
  });

  it('leaves Space to play/pause after a mouse click, and when held or with a modifier', () => {
    // A control clicked with the mouse keeps the focus, without :focus-visible.
    const clicked = control(false);
    const space = key(' ');
    clicked.listeners.keydown(space);
    expect(clicked.clicks).toBe(0);
    expect(space.stopPropagation).not.toHaveBeenCalled();
    const focused = control(true);
    for (const extra of [{repeat: true}, {ctrlKey: true}, {shiftKey: true}, {altKey: true}, {metaKey: true}]) {
      focused.listeners.keydown(key(' ', extra));
    }
    expect(focused.clicks).toBe(0);
  });
});

describe('the menu buttons', () => {
  it('say whether their menu is open', () => {
    const dom = globalThis.__playerA11yDom;
    const menus = [[new LanguageChanger(), dom.languageButton], [new AudioQualityChanger(), dom.audioTracksBtn],
      [new VideoQualityChanger(), dom.videoSource]];
    for (const [menu, button] of menus) {
      menu.openUI();
      expect(button.getAttribute('aria-haspopup')).toBe('true');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      menu.closeUI();
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('start out closed, every one of them, in the page', () => {
    const html = fs.readFileSync(new URL('../../chrome/player/index.html', import.meta.url), 'utf8');
    for (const label of ['player_audiotracks_label', 'player_subtitlesmenu_open_label', 'player_qualitymenu_label',
      'player_languagemenu_label', 'player_playbackrate_label', 'player_loop_label']) {
      expect(html).toContain(`aria-haspopup="true" aria-expanded="false" data-i18n-label="${label}"`);
    }
    // The other three say it in their openUI/closeUI too.
    for (const [file, button] of [['menus/LoopMenu.mjs', 'loopButton'], ['menus/PlaybackRateChanger.mjs', 'playbackRate'],
      ['subtitles/SubtitlesManager.mjs', 'subtitles']]) {
      const source = withoutCasts(fs.readFileSync(new URL(`../../chrome/player/ui/${file}`, import.meta.url), 'utf8'));
      expect(source).toContain(`WebUtils.setExpanded(DOMElements.${button}, true);`);
      expect(source).toContain(`WebUtils.setExpanded(DOMElements.${button}, false);`);
    }
  });
});

describe('the seek bar', () => {
  it('is a named slider in the tab order, its values written with the time\'s text', () => {
    const bar = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/ProgressBar.mjs', import.meta.url), 'utf8'));
    expect(bar).toContain('bar.tabIndex = 0;');
    expect(bar).toContain('bar.setAttribute(\'role\', \'slider\');');
    expect(bar).toContain('bar.setAttribute(\'aria-label\', Localize.getMessage(\'player_seekbar_label\'));');
    const ui = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8'));
    expect(ui).toMatch(/textContent !== timeText\) \{[^}]*aria-valuenow[^}]*aria-valuetext', timeText\);/);
  });
});

describe('the volume block', () => {
  it('gives a screen reader the slider\'s value and range', () => {
    const block = globalThis.__playerA11yDom.volumeBlock;
    const controls = new VolumeControls({});
    controls.setVolume(1.5);
    expect(block.getAttribute('aria-valuemin')).toBe('0');
    expect(block.getAttribute('aria-valuemax')).toBe('300');
    expect(block.getAttribute('aria-valuenow')).toBe('150');
    expect(block.getAttribute('aria-valuetext')).toBe('150%');
    controls.setVolume(0);
    expect(block.getAttribute('aria-valuenow')).toBe('0');
  });
});

// JSDoc casts (`/** @type {T} */ (x)`, for the type checker) are no code: the checks below
// read the source without them.
const withoutCasts = (text) => text.replace(/\/\*\* @type \{[^}]*\} \*\/ \(([^()]*)\)/g, '$1');

describe('the player\'s buttons', () => {
  const source = withoutCasts(fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8'));
  const css = fs.readFileSync(new URL('../../chrome/player/assets/fluidplayer/css/fluidplayer.css', import.meta.url), 'utf8');

  it('lets the keyboard reach and press the big play button', () => {
    // WebUtils.setupTabIndex puts an element in the tab order and makes Enter click it.
    expect(source).toContain('WebUtils.setupTabIndex(DOMElements.playPauseButtonBigCircle);');
  });

  it('shows where the keyboard is on every kind of button', () => {
    const rule = /([^{}]+)\{[^}]*\boutline:\s*2px solid var\(--menu-text-color\)/.exec(css);
    expect(rule).not.toBe(null);
    const selectors = rule[1].replace(/\/\*[^]*?\*\//g, '').split(',').map((selector) => selector.trim());
    expect(selectors).toEqual(expect.arrayContaining([
      '.fluid_button:focus-visible', '.next_video_button:focus-visible', '.fluid_control_playpause_big_circle:focus-visible',
    ]));
  });
});

describe('the extension\'s pages', () => {
  it('say they are in the UI language', async () => {
    const page = new FakeDocument('<html><body><p data-i18n="player_loading"></p></body></html>');
    vi.stubGlobal('document', page);
    await import('../../chrome/player/i18n.mjs');
    expect(page.documentElement.lang).toBe('de');
    vi.stubGlobal('document', doc);
  });

  it('keep still, for everyone', () => {
    // His wish (2026-10-13): no animations. It was only for those who asked their system for
    // less motion; for everyone else the controls faded in over half a second.
    const css = fs.readFileSync(new URL('../../chrome/player/assets/fluidplayer/css/fluidplayer.css', import.meta.url), 'utf8');
    expect(css).not.toContain('prefers-reduced-motion');
    // At the top level, and with the controls bar's own selector: its `transition: all 0.5s
    // !important` needs one as specific.
    const still = /\n\.fluid_video_wrapper\.fluid_player_layout_default \*,\n\.fluid_video_wrapper\.fluid_player_layout_default \.fluid_controls_container \{([^}]*)\}/.exec(css);
    expect(still).not.toBe(null);
    expect(still[1]).toMatch(/transition-duration: 0s !important;\s*animation-duration: 0s !important;/);
  });
});
