import {describe, expect, it, vi} from 'vitest';

// The crosstalk correction works on two channels and folds 5.1 down to them, and its panel
// gave no sign of it (#202): it now says so under its controls.

const {el} = vi.hoisted(() => {
  const el = () => ({
    children: [],
    classList: {toggle() {}, add() {}},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener() {},
  });
  return {el};
});

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => `[${key}]`}}));
vi.mock('../../chrome/player/ui/components/Knob.mjs', () => ({createKnob: () => ({container: el(), knob: {val() {}}})}));
vi.mock('../../chrome/player/utils/WebUtils.mjs', () => ({WebUtils: {
  create: (tag, style, className) => Object.assign(el(), {tag, className}),
  setupTabIndex() {},
}}));

const {AudioCrosstalk} = await import('../../chrome/player/ui/audio/AudioCrosstalk.mjs');

describe('AudioCrosstalk: the panel', () => {
  it('says that it mixes surround sound down to stereo', () => {
    // It reads the speaker and head distances the user last gave.
    vi.stubGlobal('localStorage', {getItem: () => null, setItem() {}});
    try {
      const crosstalk = new AudioCrosstalk();
      const panel = crosstalk.getElement();
      const note = panel.children.find((child) => child.className === 'crosstalk_note');
      expect(note?.textContent).toBe('[audiocrosstalk_stereo_note]');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
