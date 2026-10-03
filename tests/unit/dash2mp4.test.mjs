import {describe, expect, it, vi} from 'vitest';

// DASH2MP4 hands a save to the merger, and what the merger cannot join to the remuxer,
// which starts again from the first fragment. Both are stand-ins here: the merger gets as
// far as a test says and gives up, the remuxer reports its progress.

vi.mock('../../chrome/player/modules/dash2mp4/mp4merger.mjs', async () => {
  const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
  return {
    MP4Merger: class extends EventEmitter {
      async convert() {
        for (const progress of [0.33, 0.66]) this.emit('progress', progress);
        throw new Error('Unsupported mdat count!');
      }
    },
  };
});

vi.mock('../../chrome/player/modules/remux/remuxer.mjs', async () => {
  const {EventEmitter} = await import('../../chrome/player/modules/eventemitter.mjs');
  return {
    Remuxer: class extends EventEmitter {
      async convert() {
        for (const progress of [0, 0.5, 1]) this.emit('progress', progress);
        return new Blob(['remuxed']);
      }
    },
  };
});

const {DASH2MP4} = await import('../../chrome/player/modules/dash2mp4/dash2mp4.mjs');

describe('DASH2MP4', () => {
  it('carries on from where the merger gave up instead of going back to 0 %', async () => {
    // A merger that failed at fragment 200 of 300 showed 66 % and then 0 %.
    const converter = new DASH2MP4();
    const shown = [];
    converter.on('progress', (progress) => shown.push(progress));
    const blob = await converter.convert('', 10, new ArrayBuffer(0), '', 0, null, []);

    expect(await blob.text()).toBe('remuxed');
    expect(shown.map((progress) => Math.round(progress * 100))).toEqual([33, 66, 66, 83, 100]);
  });
});
