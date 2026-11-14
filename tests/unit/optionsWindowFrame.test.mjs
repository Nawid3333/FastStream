import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The player's settings page, an iframe in every player, loaded with the player: its scripts
// ran beside the player's own as it started, and held the first frame of a video back by
// about 140 ms (tools/bench-ab.mjs, 2026-11-13: 945 -> 808 ms, 7 of 7 rounds). It loads once
// the player showed its first frame, when the page is idle, or at once when the settings
// window opens; a player with nothing to show loads it after a few seconds.

/** A stand-in element: its style, its listeners, and a dataset. */
function element(extra = {}) {
  return {style: {display: 'none'}, dataset: {}, addEventListener() {},
    getElementsByClassName: () => [{addEventListener() {}}], ...extra};
}

const frame = element({dataset: {src: './options/index.html'}, src: ''});
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({
  DOMElements: {optionsContainer: element(), optionsFrame: frame, settingsButton: element()},
}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {closeWindows() {}}}));
vi.mock('../../chrome/player/utils/WebUtils.mjs', () => ({WebUtils: {setupTabIndex() {}, setLabels() {}}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

const {OptionsWindow} = await import('../../chrome/player/ui/OptionsWindow.mjs');

describe('the player\'s settings page', () => {
  /** @type {Array<() => void>} */
  let idle;
  beforeEach(() => {
    vi.useFakeTimers();
    frame.src = '';
    idle = [];
    globalThis.requestIdleCallback = /** @type {any} */ ((callback) => idle.push(callback));
  });
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.requestIdleCallback;
  });

  it('is not loaded with the player', () => {
    const html = fs.readFileSync(path.resolve(import.meta.dirname, '../../chrome/player/index.html'), 'utf8');
    const tag = /<iframe class="options_frame"[^>]*>/.exec(html)?.[0] ?? '';
    expect(tag).toContain('data-src="./options/index.html"');
    expect(tag).not.toMatch(/\ssrc=/);
    new OptionsWindow();
    expect(frame.src).toBe('');
  });

  it('loads when the page is idle after the first frame', () => {
    const window = new OptionsWindow();
    window.loadFrameWhenIdle();
    expect(frame.src).toBe('');
    idle.forEach((callback) => callback());
    expect(frame.src).toBe('./options/index.html');
  });

  it('loads at once when the settings window opens, and once only', () => {
    const window = new OptionsWindow();
    window.openUI();
    expect(frame.src).toBe('./options/index.html');
    frame.src = 'kept';
    window.loadFrameWhenIdle();
    idle.forEach((callback) => callback());
    vi.advanceTimersByTime(60000);
    window.openUI();
    expect(frame.src).toBe('kept');
  });

  it('loads after a few seconds in a player that shows nothing', () => {
    new OptionsWindow();
    vi.advanceTimersByTime(4000);
    expect(frame.src).toBe('');
    vi.advanceTimersByTime(1500);
    idle.forEach((callback) => callback());
    expect(frame.src).toBe('./options/index.html');
  });
});
