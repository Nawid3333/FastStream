// Regression coverage for the keybinds in the player.
//
// Most presses are synthetic: a KeyboardEvent on document, turned into a key string by
// WebUtils.getKeyString ('Shift+' while shiftKey is held, then e.code) and matched
// exactly against the keybinds, so no window focus is needed. A few go through the
// WebDriver keyboard instead, which is the path a real press takes. The video stays
// paused throughout; nothing here depends on playback, only on seeks and on the playback
// rate read back.
//
// Guarded:
//
// - Digit1..Digit9 jump to 10%..90% of the duration, and do nothing on a live stream,
//   whose duration is Infinity and which the currentTime setter would throw on.
// - The mpv-style speed presets: a preset key sets its speed, pressing the SAME key
//   again reverts to the rate that was active before it took effect, and that memory
//   is per key (Q, then Y, then Y lands on 3x, not 1x). The target is clamped to
//   options.maxPlaybackRate, which is 8.
// - The six moved defaults: plain KeyW is now the 3.5x preset, and Shift+KeyW is
//   windowed fullscreen and must not touch the rate.
// - The mpv seeks, on a 160 s video: Z/X 60 s, J/K 10 s, the arrows 5 s; a 60 s hop back
//   near the start stops at 0; Shift+Backspace undoes a seek and plain Z no longer does.
// - The mpv frame step on `,`/`.`, on a 24 fps video: it pauses, and the frame the browser
//   presents next is exactly one frame on or back, which the old fixed 1/30 s step was not.
// - Every default key reaches exactly one action in the running player.
// - Typing in a text field is not a command.
// - Options saved before the layout changed are migrated when the player loads them,
//   and a saved binding is never left firing two actions.

import {browser, expect} from '@wdio/globals';

const samplePath = (fixture = 'sample.mp4') => '/player/index.html?t=' + Date.now() + '#' +
  globalThis.__E2E_FIXTURES_ORIGIN__ + '/fixtures/' + fixture;

async function openPlayer(fixture) {
  await browser.url(samplePath(fixture));
  await browser.waitUntil(
      async () => browser.execute(() => {
        const video = document.querySelector('video');
        return !!(window.fastStream && video && video.readyState >= 2);
      }),
      {timeout: 60000, timeoutMsg: 'video never became ready'});
}

// Dispatches a synthetic keydown on document, where the KeybindManager listens.
// Dispatching on document itself means only the document listener handles the
// event, so each press acts exactly once. e.key only has to be plausible:
// WebUtils.getKeyString matches on e.code, so the digit for DigitN and the bare
// letter for KeyN are enough.
const pressKey = (code, {shift} = {}) => browser.execute((code, shift) => {
  let key;
  if (code.startsWith('Digit')) {
    key = code.slice(5);
  } else if (code === 'Space') {
    key = ' ';
  } else if (code.startsWith('Key')) {
    key = code.slice(3).toLowerCase();
  } else {
    key = code;
  }
  document.dispatchEvent(new KeyboardEvent('keydown', {
    code,
    key,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  }));
}, code, !!shift);

const rate = () => browser.execute(() => window.fastStream.playbackRate);
const time = () => browser.execute(() => window.fastStream.currentTime);

// A press acts synchronously, but a seek lands a moment later.
const settle = () => browser.pause(300);

// The preset handlers keep per-key revert memory for the session and the client may
// carry a rate over from an earlier test, so every test starts from a known 1x, at the
// start, on a paused video.
async function reset() {
  await browser.execute(() => {
    const video = document.querySelector('video');
    if (video && !video.paused) {
      video.pause();
    }
    window.fastStream.playbackRate = 1;
    window.fastStream.currentTime = 0;
  });
  await browser.waitUntil(async () => (await time()) < 0.5,
      {timeout: 10000, timeoutMsg: 'video never seeked back to the start'});
}

describe('Keybinds', function() {
  before(() => openPlayer());
  beforeEach(reset);

  it('Digit1 to Digit9 seek to 10% to 90% of the duration', async function() {
    const duration = await browser.execute(() => window.fastStream.duration);
    // Ten percent has to be well clear of the start the video is parked at, or a key that
    // did nothing would land inside the tolerance.
    expect(duration).toBeGreaterThan(5);

    for (let digit = 1; digit <= 9; digit++) {
      await reset();
      await pressKey(`Digit${digit}`);
      const target = duration * digit / 10;
      await browser.waitUntil(async () => Math.abs((await time()) - target) <= 0.25,
          {timeout: 10000, timeoutMsg: `Digit${digit} never seeked to ${target} s, ${digit * 10}% of ${duration} s`});
    }
  });

  it('a percent seek does nothing, and throws nothing, on a live stream', async function() {
    // A live stream's duration is Infinity both on the media element and on the client.
    await browser.execute(() => {
      window.__liveErrors = [];
      window.__onLiveError = (e) => window.__liveErrors.push(e.message);
      window.addEventListener('error', window.__onLiveError);
      Object.defineProperty(document.querySelector('video'), 'duration', {get: () => Infinity, configurable: true});
      Object.defineProperty(window.fastStream, 'duration', {get: () => Infinity, configurable: true});
      for (const digit of [1, 5, 9]) {
        try {
          document.dispatchEvent(new KeyboardEvent('keydown', {code: `Digit${digit}`, key: String(digit), bubbles: true, cancelable: true}));
        } catch (e) {
          window.__liveErrors.push(String(e));
        }
      }
    });
    await settle();
    const outcome = await browser.execute(() => {
      window.removeEventListener('error', window.__onLiveError);
      delete window.fastStream.duration;
      delete document.querySelector('video').duration;
      return {errors: window.__liveErrors, time: window.fastStream.currentTime};
    });
    expect(outcome.errors).toEqual([]);
    expect(outcome.time).toBeLessThan(0.5);
  });

  it('KeyQ sets the 3x preset and pressing it again reverts to 1x', async function() {
    await pressKey('KeyQ');
    expect(await rate()).toBe(3);
    await pressKey('KeyQ');
    expect(await rate()).toBe(1);
  });

  it('KeyY reverts to the rate KeyQ set, the preset memory is per key', async function() {
    await pressKey('KeyQ');
    expect(await rate()).toBe(3);
    await pressKey('KeyY');
    expect(await rate()).toBe(5);
    await pressKey('KeyY');
    expect(await rate()).toBe(3);
    // The 3x key still remembers the 1x it replaced, whatever the 5x key did in between.
    await pressKey('KeyQ');
    expect(await rate()).toBe(1);
  });

  it('every preset key sets its speed, and pressing it again puts the rate back', async function() {
    const max = await browser.execute(() => window.fastStream.options.maxPlaybackRate);
    const presets = {KeyG: 2, KeyB: 2.5, KeyQ: 3, KeyW: 3.5, KeyA: 4, KeyY: 5, KeyE: 8, KeyH: 16};
    for (const [code, speed] of Object.entries(presets)) {
      await reset();
      await pressKey(code);
      expect(await rate()).toBe(Math.min(speed, max));
      await pressKey(code);
      expect(await rate()).toBe(1);
    }

    // The 1x key at 1x has nothing to do, and from another speed it resets.
    await reset();
    await pressKey('KeyR');
    expect(await rate()).toBe(1);
    await browser.execute(() => {
      window.fastStream.playbackRate = 2;
    });
    await pressKey('KeyR');
    expect(await rate()).toBe(1);
    await pressKey('KeyR');
    expect(await rate()).toBe(2);
  });

  it('reverts to a rate set by hand, not only to 1x', async function() {
    await browser.execute(() => {
      window.fastStream.playbackRate = 1.7;
    });
    await pressKey('KeyY');
    expect(await rate()).toBe(5);
    await pressKey('KeyY');
    expect(await rate()).toBe(1.7);
  });

  it('clamps a preset to options.maxPlaybackRate, whatever the browser allows', async function() {
    // The real limit is 8, which the 8x and 16x keys both reach; forcing it lower shows the
    // clamp applies to every preset above it.
    const original = await browser.execute(() => {
      const before = window.fastStream.options.maxPlaybackRate;
      window.fastStream.options.maxPlaybackRate = 4;
      return before;
    });
    try {
      await pressKey('KeyH');
      expect(await rate()).toBe(4);
      await reset();
      await pressKey('KeyE');
      expect(await rate()).toBe(4);
      await reset();
      await pressKey('KeyG');
      expect(await rate()).toBe(2);
    } finally {
      await browser.execute((before) => {
        window.fastStream.options.maxPlaybackRate = before;
      }, original);
    }

    // And the limit the player ships with is Firefox's 8, which the 16x key stops at.
    expect(original).toBe(8);
    await reset();
    await pressKey('KeyH');
    expect(await rate()).toBe(8);
  });

  it('a preset is not left dead when the rate is put back to it by hand', async function() {
    await pressKey('KeyQ');
    await pressKey('KeyQ');
    await browser.execute(() => {
      window.fastStream.playbackRate = 3;
    });
    await pressKey('KeyQ');
    expect(await rate()).toBe(1);
  });

  it('KeyW sets 3.5x and Shift+KeyW leaves the playbackRate alone', async function() {
    await pressKey('KeyW');
    expect(await rate()).toBe(3.5);

    await pressKey('KeyW', {shift: true});
    expect(await rate()).toBe(3.5);
  });

  it('has each moved action on its Shift+<letter> key, and the plain letter on its preset', async function() {
    const reached = await browser.execute(() => {
      const manager = window.fastStream.keybindManager;
      const keys = ['Shift+KeyW', 'Shift+KeyA', 'Shift+KeyB', 'Shift+KeyE', 'Shift+KeyR', 'Shift+KeyQ',
        'KeyW', 'KeyA', 'KeyB', 'KeyE', 'KeyR', 'KeyQ'];
      return Object.fromEntries(keys.map((key) => [key, manager.keyStringToKeybinds(key)]));
    });
    expect(reached).toEqual({
      'Shift+KeyW': ['WindowedFullscreen'], 'Shift+KeyA': ['NextChapter'], 'Shift+KeyB': ['PreviousVideo'],
      'Shift+KeyE': ['FlipVideo'], 'Shift+KeyR': ['RotateVideo'], 'Shift+KeyQ': ['ToggleVisualFilters'],
      'KeyW': ['SpeedPreset3_5'], 'KeyA': ['SpeedPreset4'], 'KeyB': ['SpeedPreset2_5'],
      'KeyE': ['SpeedPreset8'], 'KeyR': ['SpeedPreset1'], 'KeyQ': ['SpeedPreset3'],
    });
  });

  it('reaches every default key in the running player, and each reaches exactly one action', async function() {
    const {bad, count} = await browser.execute(() => {
      const manager = window.fastStream.keybindManager;
      const bad = [];
      for (const [action, key] of manager.keybindMap) {
        if (key === 'None') continue;
        const reached = manager.keyStringToKeybinds(key);
        if (reached.length !== 1 || reached[0] !== action) bad.push({action, key, reached});
      }
      return {bad, count: manager.keybindMap.size};
    });
    expect(count).toBeGreaterThan(50);
    expect(bad).toEqual([]);
  });

  it('answers a press from the real keyboard the same way', async function() {
    await browser.keys('5');
    const duration = await browser.execute(() => window.fastStream.duration);
    await browser.waitUntil(async () => Math.abs((await time()) - duration / 2) <= 0.5,
        {timeout: 10000, timeoutMsg: 'the 5 key never seeked to the middle'});

    await browser.keys('q');
    expect(await rate()).toBe(3);
    await browser.keys('q');
    expect(await rate()).toBe(1);

    await browser.keys(['Shift', 'w']);
    expect(await rate()).toBe(1);
  });

  afterEach(async function() {
    // A failed typing test must not leave its field focused, or every later press goes into it.
    await browser.execute(() => {
      document.getElementById('e2e-typing')?.remove();
      document.activeElement?.blur();
    });
  });

  it('still lets Right Alt through while typing, since it hides the player', async function() {
    const seen = await browser.execute(() => {
      const manager = window.fastStream.keybindManager;
      const presses = [];
      manager.on('keybind', (actions) => presses.push(actions));

      const field = document.createElement('input');
      field.type = 'text';
      field.id = 'e2e-typing';
      document.body.appendChild(field);
      field.focus();

      const press = (init) => field.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}));
      press({code: 'KeyQ', key: 'q'});
      press({code: 'AltRight', key: 'Alt', altKey: true});
      // A second press shows the player again.
      press({code: 'AltRight', key: 'Alt', altKey: true});
      return presses;
    });
    expect(seen).toEqual([['HidePlayer'], ['HidePlayer']]);
  });

  for (const [tag, attributes] of [
    ['input', {type: 'text'}],
    ['input', {type: 'number'}],
    ['input', {type: 'search'}],
    ['textarea', {}],
  ]) {
    it(`does not treat typing in a ${tag}${attributes.type ? ` (${attributes.type})` : ''} as a command`, async function() {
      await browser.execute((tag, attributes) => {
        const field = document.createElement(tag);
        Object.assign(field, attributes);
        field.id = 'e2e-typing';
        document.body.appendChild(field);
        field.focus();
      }, tag, attributes);

      await browser.keys(['q', '5', 'w', 'y']);
      await settle();

      const typed = await browser.execute(() => document.getElementById('e2e-typing').value);
      expect(await rate()).toBe(1);
      expect(await time()).toBeLessThan(0.5);
      // A number box refuses the letters, so only the text-like fields hold what was typed.
      if (attributes.type !== 'number') {
        expect(typed).toBe('q5wy');
      }

      // Once the field is gone the same key is a command again.
      await browser.execute(() => {
        document.getElementById('e2e-typing').remove();
        document.activeElement?.blur();
      });
      await pressKey('KeyQ');
      expect(await rate()).toBe(3);
    });
  }
});

describe('Keybinds saved before the layout changed', function() {
  // What a profile held before the percent seeks and speed presets, with a binding of the
  // user's own on a key that has since become a preset.
  const legacy = {
    keybinds: {
      WindowedFullscreen: 'KeyW', NextChapter: 'KeyA', PreviousVideo: 'KeyB',
      FlipVideo: 'KeyV', RotateVideo: 'KeyR', ToggleVisualFilters: 'KeyQ',
      ResetPlaybackRate: 'KeyY',
    },
  };

  before(async function() {
    await openPlayer();
    await browser.execute((options) => localStorage.setItem('options', JSON.stringify(options)), legacy);
    await openPlayer();
  });

  after(async function() {
    await browser.execute(() => localStorage.removeItem('options'));
  });

  beforeEach(reset);

  it('applies the new layout without touching the saved bindings', async function() {
    const map = await browser.execute(() => Object.fromEntries(window.fastStream.keybindManager.keybindMap));
    expect(map.WindowedFullscreen).toBe('Shift+KeyW');
    expect(map.NextChapter).toBe('Shift+KeyA');
    expect(map.PreviousVideo).toBe('Shift+KeyB');
    expect(map.RotateVideo).toBe('Shift+KeyR');
    expect(map.ToggleVisualFilters).toBe('Shift+KeyQ');
    // A binding on something other than the old default is not moved.
    expect(map.FlipVideo).toBe('KeyV');
    expect(map.SpeedPreset3).toBe('KeyQ');
    expect(map.SpeedPreset3_5).toBe('KeyW');
    expect(map.SeekPercent50).toBe('Digit5');
    // The user's own choice wins over the new default that wanted the same key.
    expect(map.ResetPlaybackRate).toBe('KeyY');
    expect(map.SpeedPreset5).toBe('None');
  });

  it('leaves no key that fires two actions', async function() {
    const bad = await browser.execute(() => {
      const manager = window.fastStream.keybindManager;
      const bad = [];
      for (const [action, key] of manager.keybindMap) {
        if (key === 'None') continue;
        const reached = manager.keyStringToKeybinds(key);
        if (reached.length !== 1) bad.push({action, key, reached});
      }
      return bad;
    });
    expect(bad).toEqual([]);
  });

  it('presses the migrated keys: Y resets the rate and does not jump to 5x, Q is the 3x preset', async function() {
    await browser.execute(() => {
      window.fastStream.playbackRate = 2;
    });
    await pressKey('KeyY');
    expect(await rate()).toBe(1);

    await pressKey('KeyQ');
    expect(await rate()).toBe(3);
  });

  it('does not rewrite what was saved just by loading it', async function() {
    const stored = await browser.execute(() => JSON.parse(localStorage.getItem('options')));
    expect(stored.keybinds.WindowedFullscreen).toBe('KeyW');
    expect(stored.keybindsVersion).toBeUndefined();
  });
});

describe('mpv seek keys', function() {
  // long-av.mp4 is 160 s, so a 60 s hop either way from the middle stays inside it.
  before(() => openPlayer('long-av.mp4'));
  beforeEach(reset);

  const seekTo = (seconds) => browser.execute((seconds) => {
    window.fastStream.currentTime = seconds;
  }, seconds);
  const landsOn = (target, what) => browser.waitUntil(async () => Math.abs((await time()) - target) <= 0.25,
      {timeout: 10000, timeoutMsg: `${what} never landed on ${target} s`});

  it('the video is long enough to tell the hops apart', async function() {
    expect(await browser.execute(() => window.fastStream.duration)).toBeGreaterThan(150);
    expect(await browser.execute(() => window.fastStream.options.seekStepSize)).toBe(5);
  });

  for (const [code, delta] of [
    ['KeyX', 60], ['KeyZ', -60],
    ['KeyK', 10], ['KeyJ', -10],
    ['ArrowRight', 5], ['ArrowLeft', -5],
  ]) {
    it(`${code} seeks ${delta > 0 ? '+' : ''}${delta} s`, async function() {
      await seekTo(80);
      await landsOn(80, 'the start position');
      await pressKey(code);
      await landsOn(80 + delta, code);
    });
  }

  it('Z near the start stops at 0 rather than handing on a negative time', async function() {
    await seekTo(20);
    await landsOn(20, 'the start position');
    // Read in the same turn as the press: a timeupdate would overwrite the state with the
    // media element's clamped time and hide a negative one.
    const state = await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {code: 'KeyZ', key: 'z', bubbles: true, cancelable: true}));
      return window.fastStream.state.currentTime;
    });
    expect(state).toBe(0);
    await landsOn(0, 'KeyZ');
  });

  it('Shift+Backspace undoes a seek, Shift+Z redoes it, and plain Z is a seek, not an undo', async function() {
    await pressKey('Digit5');
    await landsOn(80, 'Digit5');
    await pressKey('KeyX');
    await landsOn(140, 'KeyX');

    // The 60 s hop is not saved for undo, like the arrows: undo goes back past it to where
    // the percent seek started.
    await pressKey('Backspace', {shift: true});
    await landsOn(0, 'Shift+Backspace');
    await pressKey('KeyZ', {shift: true});
    await landsOn(140, 'Shift+KeyZ');
  });

  it('puts the screenshot on Shift+S, next to skip intro on S', async function() {
    const reached = await browser.execute(() => {
      const manager = window.fastStream.keybindManager;
      return [manager.keyStringToKeybinds('Shift+KeyS'), manager.keyStringToKeybinds('KeyS'), manager.keyStringToKeybinds('KeyX')];
    });
    expect(reached).toEqual([['Screenshot'], ['SkipIntroOutro'], ['SeekForward60s']]);
  });
});

describe('mpv frame step', function() {
  // frames-24fps.mp4: 96 frames, each starting at exactly n/24 s, every picture different.
  // The usual use is play, pause, then step, so the stepper learns the frame length from
  // the playback before the pause. What is on screen is checked on the picture itself: a
  // step must change it, and stepping back must bring back the exact earlier picture.
  const FPS = 24;
  before(async function() {
    await openPlayer('frames-24fps.mp4');
    await browser.execute(() => {
      const video = window.fastStream.player.getVideo();
      window.__presented = 0;
      const onFrame = () => {
        window.__presented++;
        video.requestVideoFrameCallback(onFrame);
      };
      video.requestVideoFrameCallback(onFrame);
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 36;
      window.__picture = () => {
        const context = canvas.getContext('2d', {willReadFrequently: true});
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data).join(',');
      };
    });
  });

  // Plays the video element and does not wait on the promise, as every other spec does:
  // window.fastStream.play() also waits for its AudioContext to resume, which on the Linux
  // CI runner (no sound device) never settled, so awaiting it hung the test.
  const startPlayback = () => browser.execute(() => {
    window.fastStream.player.getVideo().play().catch(() => {});
  });
  const frame = () => browser.execute((fps) => Math.floor(window.fastStream.currentTime * fps + 1e-6), FPS);
  const picture = () => browser.execute(() => window.__picture());
  const presented = () => browser.execute(() => window.__presented);
  // Presses a key and waits for the browser to present the frame it seeks to.
  const press = async (code, what) => {
    const count = await presented();
    await pressKey(code);
    await browser.waitUntil(async () => (await presented()) > count,
        {timeout: 10000, timeoutMsg: `${what}: no frame was presented`});
    await settle();
  };

  it('Firefox has requestVideoFrameCallback, which the step measures frames with', async function() {
    expect(await browser.execute(() => typeof HTMLVideoElement.prototype.requestVideoFrameCallback)).toBe('function');
  });

  it('after playing and pausing, steps exactly one frame on and back', async function() {
    await reset();
    await startPlayback();
    await browser.waitUntil(async () => (await time()) > 1, {timeout: 10000, timeoutMsg: 'never played to 1 s'});
    await browser.execute(() => window.fastStream.pause());
    expect(await browser.execute(() => window.fastStream.frameStepper.frameDuration)).toBeCloseTo(1 / FPS, 4);

    // Just after the start of frame 10, where the old fixed 1/30 s step stayed on frame 10.
    const count = await presented();
    await browser.execute((fps) => {
      window.fastStream.currentTime = 10 / fps + 0.001;
    }, FPS);
    await browser.waitUntil(async () => (await presented()) > count, {timeout: 10000, timeoutMsg: 'the seek presented no frame'});
    await settle();
    expect(await frame()).toBe(10);
    const frame10 = await picture();

    await press('Period', 'the first step on');
    expect(await frame()).toBe(11);
    const frame11 = await picture();
    expect(frame11).not.toBe(frame10);

    await press('Period', 'the second step on');
    expect(await frame()).toBe(12);
    expect(await picture()).not.toBe(frame11);

    await press('Comma', 'the first step back');
    expect(await frame()).toBe(11);
    expect(await picture()).toBe(frame11);

    await press('Comma', 'the second step back');
    expect(await frame()).toBe(10);
    expect(await picture()).toBe(frame10);
    expect(await browser.execute(() => window.fastStream.paused)).toBe(true);
  });

  it('pauses a playing video before stepping, like mpv', async function() {
    await reset();
    await startPlayback();
    await browser.waitUntil(async () => (await time()) > 0.5, {timeout: 10000, timeoutMsg: 'never played'});
    await pressKey('Period');
    await browser.waitUntil(async () => browser.execute(() => window.fastStream.paused),
        {timeout: 5000, timeoutMsg: 'the frame step did not pause'});
  });

  it('stays on the first frame stepping back from it', async function() {
    await reset();
    await pressKey('Comma');
    await settle();
    expect(await frame()).toBe(0);
  });
});
