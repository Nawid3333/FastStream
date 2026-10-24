import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AudioOutputDevice, isPolicyRefusal} from '../../chrome/player/ui/audio/AudioOutputDevice.mjs';

// Where the player's sound goes: the default output, or a device the user chose (his wish,
// 2026-10-24). Firefox's parts stand in: an element for setSinkId, mediaDevices for
// selectAudioOutput, an AudioContext for the stream detour. Drafted by glm-5.3-flash, checked.

const STORAGE_KEY = 'audioOutputDevice';

const PHONES = {deviceId: 'phones', label: 'Headphones'};

/** @return {any} A hidden audio element stand-in that records what the module does with it. */
function makeFakeElement() {
  return {
    srcObject: null,
    setSinkId: vi.fn(() => Promise.resolve()),
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
  };
}

let contextTally = 0;

/** @return {any} An AudioContext stand-in whose destination and stream nodes are tellable apart. */
function makeFakeContext() {
  const number = contextTally += 1;
  const streamDestinations = [];
  return {
    destination: {channelCount: 2, name: 'output ' + number},
    streamDestinations,
    createMediaStreamDestination() {
      const node = {channelCount: 2, name: 'device stream ' + number, stream: {}};
      streamDestinations.push(node);
      return node;
    },
  };
}

/**
 * @typedef {Object} FakeOutput
 * @property {(target: any) => void} connect
 * @property {(target: any) => void} disconnect
 * @property {() => any[]} wired - The targets it is wired to now.
 * @property {Array<[string, any]>} journal - Everything it was told, in order.
 */

/** @return {FakeOutput} The player graph's last node, remembering its wiring. */
function makeFakeOutput() {
  const links = new Map();
  const journal = [];
  return {
    connect(target) {
      links.set(target, true);
      journal.push(['connect', target]);
    },
    disconnect(target) {
      links.set(target, false);
      journal.push(['disconnect', target]);
    },
    wired() {
      return [...links.entries()].filter(([, on]) => on).map(([target]) => target);
    },
    journal,
  };
}

/** Lets the pending microtasks run up to the next real wait. */
async function flushMicrotasks() {
  for (let step = 0; step < 20; step += 1) {
    await Promise.resolve();
  }
}

/**
 * @typedef {Object} TestKit
 * @property {AudioOutputDevice} device
 * @property {any} mediaDevices
 * @property {any[]} elements - The hidden elements the module made, in order.
 * @property {Error[]} sinkFailures - Failures to hand out to the next setSinkId calls.
 * @property {(key: string) => Promise<?string>} load
 * @property {(key: string, value: string) => Promise<void>} save
 * @property {Map<string, string>} storage
 * @property {() => void} freeFirstSink - Lets the first element's setSinkId finish.
 * @property {(e: Error) => void} failFirstSink - Lets it fail.
 */

/**
 * A device under test with everything it needs, and what it made.
 * @param {{storage?: Map<string, string>, gateFirstSink?: boolean, mediaDevices?: any}} [options]
 * @return {TestKit}
 */
function makeTest({
  storage = new Map(),
  gateFirstSink = false,
  mediaDevices = /** @type {any} */ ({selectAudioOutput: vi.fn()}),
} = {}) {
  const elements = [];
  const sinkFailures = [];
  /** @type {?(() => void)} */
  let openFirstSink = null;
  /** @type {?((e: Error) => void)} */
  let failFirstSink = null;
  const load = vi.fn(async (/** @type {string} */ key) => (storage.has(key) ? storage.get(key) : null));
  const save = vi.fn(async (/** @type {string} */ key, /** @type {string} */ value) => {
    storage.set(key, value);
  });
  const device = new AudioOutputDevice({
    mediaDevices,
    makeAudio: () => {
      const element = makeFakeElement();
      if (gateFirstSink && elements.length === 0) {
        // The first element's setSinkId waits until the test lets it go.
        element.setSinkId = vi.fn(() => new Promise((resolve, reject) => {
          openFirstSink = resolve;
          failFirstSink = reject;
        }));
      } else {
        element.setSinkId = vi.fn(() => {
          const failure = sinkFailures.shift();
          return failure ? Promise.reject(failure) : Promise.resolve();
        });
      }
      elements.push(element);
      return element;
    },
    load,
    save,
  });
  return {
    device,
    mediaDevices,
    elements,
    sinkFailures,
    load,
    save,
    storage,
    freeFirstSink: () => {
      if (openFirstSink) {
        openFirstSink();
      }
    },
    failFirstSink: (e) => failFirstSink?.(e),
  };
}

describe('AudioOutputDevice', () => {
  beforeEach(() => {
    vi.stubGlobal(
        'HTMLMediaElement',
        class {
          setSinkId() {}
        },
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('plays through the default output when nothing has been chosen, and makes no hidden element', async () => {
    const t = makeTest();
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();

    const result = await t.device.attach(audioContext, output);

    expect(result).toEqual({failed: null});
    expect(output.journal).toEqual([['connect', audioContext.destination]]);
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.elements).toEqual([]);
    expect(t.device.playing).toBe(null);
    expect(t.device.graph).toEqual({audioContext, output});
  });

  it('applies a kept device to the next video: the hidden element plays on it and the sound moves over for good', async () => {
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();

    const result = await t.device.attach(audioContext, output);

    const element = t.elements[0];
    const streamDestination = t.device.streamDestination;
    expect(result).toEqual({failed: null});
    expect(t.device.choice).toEqual(PHONES);
    expect(element.setSinkId).toHaveBeenCalledWith('phones');
    expect(element.play).toHaveBeenCalled();
    expect(element.srcObject).toBe(streamDestination.stream);
    // As many channels as the context's own output was given.
    expect(streamDestination.channelCount).toBe(audioContext.destination.channelCount);
    // Wired in before the old line was cut: at the end it runs on the stream alone.
    expect(output.journal).toEqual([
      ['connect', audioContext.destination],
      ['connect', streamDestination],
      ['disconnect', audioContext.destination],
    ]);
    expect(output.wired()).toEqual([streamDestination]);
    expect(t.device.playing).toEqual(PHONES);
  });

  it('when the kept device cannot play, the sound stays on the default output and the failure is reported', async () => {
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    t.sinkFailures.push(new Error('The device is gone'));
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();

    const result = await t.device.attach(audioContext, output);

    expect(result).toEqual({failed: PHONES});
    expect(console.warn).toHaveBeenCalled();
    const element = t.elements[0];
    expect(element.setSinkId).toHaveBeenCalledWith('phones');
    expect(element.play).not.toHaveBeenCalled();
    expect(output.journal).toEqual([['connect', audioContext.destination]]);
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.device.playing).toBe(null);
    // The choice itself is kept, so the next video can try the device again.
    expect(t.device.choice).toEqual(PHONES);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('moves the running sound to a chosen device and keeps the choice for later videos', async () => {
    const t = makeTest();
    t.mediaDevices.selectAudioOutput.mockResolvedValue({...PHONES});
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);

    const choice = await t.device.choose();

    const element = t.elements[0];
    const streamDestination = t.device.streamDestination;
    expect(choice).toEqual(PHONES);
    expect(t.mediaDevices.selectAudioOutput).toHaveBeenCalledWith({});
    expect(element.setSinkId).toHaveBeenCalledWith('phones');
    expect(element.play).toHaveBeenCalled();
    expect(element.srcObject).toBe(streamDestination.stream);
    expect(output.wired()).toEqual([streamDestination]);
    expect(t.device.choice).toEqual(PHONES);
    expect(t.device.playing).toEqual(PHONES);
    expect(t.save).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(PHONES));
    expect(t.storage.get(STORAGE_KEY)).toBe(JSON.stringify(PHONES));
  });

  it('leaves everything as it was when the chooser is closed without a choice', async () => {
    const t = makeTest();
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);

    const closed = Object.assign(new Error('The chooser was closed'), {name: 'NotAllowedError'});
    expect(isPolicyRefusal(closed)).toBe(false);
    t.mediaDevices.selectAudioOutput.mockRejectedValueOnce(closed);
    expect(await t.device.choose()).toBe(null);

    const aborted = Object.assign(new Error('No device was chosen'), {name: 'AbortError'});
    t.mediaDevices.selectAudioOutput.mockRejectedValueOnce(aborted);
    expect(await t.device.choose()).toBe(null);

    expect(t.elements).toEqual([]);
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.device.choice).toBe(null);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('surfaces a permissions policy refusal as an error', async () => {
    const t = makeTest();
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);
    const refusal = Object.assign(
        new Error('Document\'s Permissions Policy does not allow selectAudioOutput()'),
        {name: 'NotAllowedError'},
    );
    t.mediaDevices.selectAudioOutput.mockRejectedValue(refusal);

    await expect(t.device.choose()).rejects.toBe(refusal);

    expect(isPolicyRefusal(refusal)).toBe(true);
    expect(t.elements).toEqual([]);
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.device.choice).toBe(null);
    expect(t.save).not.toHaveBeenCalled();
  });

  it('moves the sound back to the default output and forgets the device', async () => {
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);
    const element = t.elements[0];
    const streamDestination = t.device.streamDestination;

    await t.device.useDefault();

    expect(t.device.choice).toBe(null);
    expect(t.device.playing).toBe(null);
    expect(t.device.element).toBe(null);
    expect(t.device.streamDestination).toBe(null);
    expect(element.pause).toHaveBeenCalled();
    expect(element.srcObject).toBe(null);
    // Wired back before the line to the device was cut: at the end on the destination alone.
    expect(output.journal).toEqual([
      ['connect', audioContext.destination],
      ['connect', streamDestination],
      ['disconnect', audioContext.destination],
      ['connect', audioContext.destination],
      ['disconnect', streamDestination],
    ]);
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.save).toHaveBeenCalledWith(STORAGE_KEY, '');
    expect(t.storage.get(STORAGE_KEY)).toBe('');
  });

  it('keeps the next video where it is when the previous video is still finding its device, whatever the late answer says', async () => {
    const t = makeTest({gateFirstSink: true});
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    const firstAttach = t.device.attach(audioContext, output);
    await flushMicrotasks();

    const firstElement = t.elements[0];
    expect(firstElement.setSinkId).toHaveBeenCalledWith('phones');
    expect(t.device.playing).toBe(null);
    expect(output.wired()).toEqual([audioContext.destination]);

    const nextContext = makeFakeContext();
    const nextOutput = makeFakeOutput();
    expect(await t.device.attach(nextContext, nextOutput)).toEqual({failed: null});

    const nextElement = t.elements[1];
    const nextStream = t.device.streamDestination;
    expect(nextElement.setSinkId).toHaveBeenCalledWith('phones');
    expect(nextElement.srcObject).toBe(nextStream.stream);
    expect(nextOutput.wired()).toEqual([nextStream]);
    expect(t.device.element).toBe(nextElement);

    t.freeFirstSink();
    expect(await firstAttach).toEqual({failed: null});

    // The late answer moved nothing: the old video stayed on the default output, the new one
    // stayed on the device.
    expect(firstElement.srcObject).toBe(null);
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(nextOutput.wired()).toEqual([nextStream]);
    expect(t.device.playing).toEqual(PHONES);
    expect(t.device.element).toBe(nextElement);
  });

  it('stops the hidden element and leaves the wiring alone when a video goes away', async () => {
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);
    const element = t.elements[0];
    const streamDestination = t.device.streamDestination;
    expect(output.wired()).toEqual([streamDestination]);

    t.device.release();

    expect(element.pause).toHaveBeenCalled();
    expect(element.srcObject).toBe(null);
    expect(t.device.element).toBe(null);
    expect(t.device.streamDestination).toBe(null);
    expect(t.device.playing).toBe(null);
    expect(t.device.graph).toBe(null);
    // The wiring is left exactly as it was; the caller's context close ends it.
    expect(output.journal).toEqual([
      ['connect', audioContext.destination],
      ['connect', streamDestination],
      ['disconnect', audioContext.destination],
    ]);
    expect(output.wired()).toEqual([streamDestination]);
    expect(t.device.choice).toEqual(PHONES);
  });

  it('reports no support when Firefox has no chooser of output devices', () => {
    const withoutChooser = makeTest({mediaDevices: {}});
    expect(withoutChooser.device.isSupported()).toBe(false);

    const withChooser = makeTest();
    expect(withChooser.device.isSupported()).toBe(true);
  });

  it('tells a policy refusal apart by its name and its message', () => {
    expect(isPolicyRefusal(Object.assign(
        new Error('Document\'s Permissions Policy does not allow selectAudioOutput()'),
        {name: 'NotAllowedError'},
    ))).toBe(true);
    expect(isPolicyRefusal(Object.assign(
        new Error('Document\'s Permissions Policy does not allow setSinkId()'),
        {name: 'NotAllowedError'},
    ))).toBe(true);
    expect(isPolicyRefusal(Object.assign(
        new Error('The chooser was closed'),
        {name: 'NotAllowedError'},
    ))).toBe(false);
    expect(isPolicyRefusal(new Error('Permissions Policy does not allow it'))).toBe(false);
    expect(isPolicyRefusal(null)).toBe(false);
  });

  // glm's review of the module (2026-10-24): each of these failed on its first version.

  it('gives the next video the default output once the user went back to it', async () => {
    // The kept choice was read once and handed to every later video: back on the headphones.
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    await t.device.attach(makeFakeContext(), makeFakeOutput());
    await t.device.useDefault();
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    expect(await t.device.attach(audioContext, output)).toEqual({failed: null});
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.device.playing).toBe(null);
  });

  it('gives the next video the device chosen while no video played', async () => {
    const t = makeTest();
    t.mediaDevices.selectAudioOutput.mockResolvedValue({...PHONES});
    await t.device.loadChoice();
    expect(await t.device.choose()).toEqual(PHONES);
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);
    expect(output.wired()).toEqual([t.device.streamDestination]);
    expect(t.device.playing).toEqual(PHONES);
  });

  it('keeps the default output the user went back to while a device was still being set up', async () => {
    const t = makeTest({gateFirstSink: true});
    t.mediaDevices.selectAudioOutput.mockResolvedValue({...PHONES});
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);
    const chosen = t.device.choose();
    await flushMicrotasks();
    await t.device.useDefault();
    t.freeFirstSink();
    expect(await chosen).toBe(null);
    expect(t.device.choice).toBe(null);
    expect(t.storage.get(STORAGE_KEY)).toBe('');
    expect(output.wired()).toEqual([audioContext.destination]);
  });

  it('says nothing failed when the video changed while its device was being set up', async () => {
    const t = makeTest({gateFirstSink: true});
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const first = t.device.attach(makeFakeContext(), makeFakeOutput());
    await flushMicrotasks();
    expect(t.elements[0].setSinkId).toHaveBeenCalled();
    // The next video, before the first's setSinkId has answered; then it fails.
    t.device.release();
    t.failFirstSink(Object.assign(new Error('superseded'), {name: 'AbortError'}));
    expect(await first).toEqual({failed: null});
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('touches no graph whose context closed while its device was being set up', async () => {
    const t = makeTest({gateFirstSink: true});
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    const attached = t.device.attach(audioContext, output);
    await flushMicrotasks();
    audioContext.state = 'closed';
    t.freeFirstSink();
    expect(await attached).toEqual({failed: null});
    expect(output.journal).toEqual([['connect', audioContext.destination]]);
  });

  it('carries as many channels as the video\'s output has, also when they are counted later', async () => {
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    t.device.setChannelCount(6);
    await t.device.attach(makeFakeContext(), makeFakeOutput());
    expect(t.device.streamDestination.channelCount).toBe(6);
    t.device.setChannelCount(2);
    expect(t.device.streamDestination.channelCount).toBe(2);
  });

  it('goes back to the default output, and says so, when the device is unplugged', async () => {
    const listeners = [];
    let present = [{kind: 'audiooutput', deviceId: 'phones'}];
    const mediaDevices = {
      selectAudioOutput: vi.fn(),
      addEventListener: (type, fn) => listeners.push(fn),
      enumerateDevices: async () => present,
    };
    const t = makeTest({mediaDevices});
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    const gone = vi.fn();
    t.device.onGone = gone;
    const audioContext = makeFakeContext();
    const output = makeFakeOutput();
    await t.device.attach(audioContext, output);
    expect(listeners).toHaveLength(1);

    // Another device came: the headphones still play.
    present = [...present, {kind: 'audioinput', deviceId: 'mic'}];
    await listeners[0]();
    expect(t.device.playing).toEqual(PHONES);

    present = [];
    await listeners[0]();
    expect(output.wired()).toEqual([audioContext.destination]);
    expect(t.device.playing).toBe(null);
    expect(gone).toHaveBeenCalledWith(PHONES);
    // Kept: plugged in again, the next video plays on it.
    expect(t.device.choice).toEqual(PHONES);
  });

  it('opens the chooser again with nothing picked when the device it was asked for is gone', async () => {
    // A click on "play it on ..." after the device was unplugged did nothing (glm's review).
    const t = makeTest();
    t.storage.set(STORAGE_KEY, JSON.stringify(PHONES));
    await t.device.loadChoice();
    const speakers = {deviceId: 'speakers', label: 'Speakers'};
    t.mediaDevices.selectAudioOutput
        .mockRejectedValueOnce(Object.assign(new Error('gone'), {name: 'NotFoundError'}))
        .mockResolvedValueOnce(speakers);
    expect(await t.device.choose()).toEqual(speakers);
    expect(t.mediaDevices.selectAudioOutput.mock.calls).toEqual([[{deviceId: 'phones'}], [{}]]);
  });

  it('tells the player when the user chose, so a notice about the output can go', async () => {
    const t = makeTest();
    t.mediaDevices.selectAudioOutput.mockResolvedValue({...PHONES});
    const changed = vi.fn();
    t.device.onChange = changed;
    await t.device.attach(makeFakeContext(), makeFakeOutput());
    await t.device.choose();
    expect(changed).toHaveBeenCalledTimes(1);
    await t.device.useDefault();
    expect(changed).toHaveBeenCalledTimes(2);
    // A chooser closed without a choice changes nothing.
    t.mediaDevices.selectAudioOutput.mockRejectedValueOnce(Object.assign(new Error('closed'), {name: 'AbortError'}));
    await t.device.choose();
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
