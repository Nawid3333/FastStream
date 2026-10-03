import {describe, expect, it, vi} from 'vitest';

// The audio mixer's channel strips, on stand-in elements. The mute button's lit state was
// toggled from `channel.mute`, a field that does not exist: classList.toggle(name,
// undefined) flips, so it only matched while nothing else changed `muted`.

const {el} = vi.hoisted(() => {
  const el = () => {
    const classes = new Set();
    const listeners = {};
    return {
      listeners,
      style: {},
      dataset: {},
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
        toggle: (name, force) => {
          const on = force === undefined ? !classes.has(name) : !!force;
          if (on) classes.add(name); else classes.delete(name);
          return on;
        },
      },
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      appendChild() {},
      replaceChildren() {},
      getContext: () => ({}),
    };
  };
  return {el};
});

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {playerContainer: el()}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/WebUtils.mjs', () => ({WebUtils: {create: () => el(), setupTabIndex() {}, setLabels() {}}}));
vi.mock('../../chrome/player/ui/components/Knob.mjs', () => ({createKnob: () => ({container: el(), knob: {val() {}}})}));

const {AudioChannelMixer} = await import('../../chrome/player/ui/audio/AudioChannelMixer.mjs');
const {AudioChannelControl} = await import('../../chrome/player/ui/audio/config/AudioChannelControl.mjs');

describe('AudioChannelMixer: a channel strip', () => {
  it('lights the mute button when, and only when, the channel is muted', () => {
    const mixer = Object.create(AudioChannelMixer.prototype);
    mixer.updateNodes = vi.fn();
    const channel = AudioChannelControl.default(0);
    const els = mixer.createMixerChannel(channel);
    const click = () => els.muteButton.listeners.click.forEach((fn) => fn({}));

    click();
    expect(channel.muted).toBe(true);
    expect(els.muteButton.classList.contains('active')).toBe(true);

    // Unmuted elsewhere while the strip is shown, then muted with the button.
    channel.muted = false;
    click();
    expect(channel.muted).toBe(true);
    expect(els.muteButton.classList.contains('active')).toBe(true);
  });
});
