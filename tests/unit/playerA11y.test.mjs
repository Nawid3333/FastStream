import fs from 'node:fs';
import {describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// What a keyboard or screen reader user gets from the player's controls (#270):
// - the volume block is a role="slider" with no value a screen reader could read;
// - Tab skipped the big play button;
// - the toolbar buttons had no focus ring of their own.
// And from #277: the pages did not say which language they are in, and the controls
// faded in and out (and the buttons being rearranged shook) whatever the system said.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {AudioContext: class {}});
const el = () => doc.body.appendChild(doc.createElement('div'));
globalThis.__playerA11yDom = {
  currentVolume: el(), muteBtn: el(), currentVolumeText: el(), volumeBanner: el(), volumeBlock: el(), volumeUnity: el(),
};
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__playerA11yDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key, subs) => `${key} ${subs}`, getLanguage: () => 'de'}}));

const {Utils} = await import('../../chrome/player/utils/Utils.mjs');
vi.spyOn(Utils, 'setConfig').mockResolvedValue();
const {VolumeControls} = await import('../../chrome/player/ui/VolumeControls.mjs');

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

describe('the player\'s buttons', () => {
  const source = fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8');
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

  it('keep still for those who asked their system for less motion', () => {
    const css = fs.readFileSync(new URL('../../chrome/player/assets/fluidplayer/css/fluidplayer.css', import.meta.url), 'utf8');
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([^]*?)\n\}/.exec(css);
    expect(reduced).not.toBe(null);
    // The controls bar's own `transition: all 0.5s !important` needs a selector as specific.
    expect(reduced[1]).toContain('.fluid_video_wrapper.fluid_player_layout_default .fluid_controls_container');
    expect(reduced[1]).toMatch(/transition-duration: 0s !important;\s*animation-duration: 0s !important;/);
  });
});
