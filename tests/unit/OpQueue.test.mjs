import {describe, expect, it} from 'vitest';
import {OpQueue} from '../../chrome/player/network/OpQueue.mjs';

// OpQueue is the concurrency primitive opfs-worker.mjs uses to keep OPFS
// FileSystemSyncAccessHandle operations from overlapping - opening two sync
// handles on the same file throws, and unlike an IndexedDB transaction there
// is no free serialization to lean on. The worker itself can't be unit
// tested here (it touches navigator.storage/Worker at module scope, which
// this project's vitest.config.mjs deliberately keeps out of the Node-based
// unit suite - see its own comment), but the ordering guarantee the worker
// depends on is pure logic and belongs here.

/** Sleeps for `ms` real milliseconds - these tests want genuine interleaving, not fake timers. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('OpQueue', () => {
  it('runs tasks in push order even when earlier ones are slower', async () => {
    const queue = new OpQueue();
    const order = [];

    const first = queue.push(async () => {
      await sleep(20);
      order.push('first');
    });
    const second = queue.push(async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('never overlaps two tasks in time', async () => {
    const queue = new OpQueue();
    let running = 0;
    let maxConcurrent = 0;

    const task = () => queue.push(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await sleep(5);
      running--;
    });

    await Promise.all([task(), task(), task(), task()]);
    expect(maxConcurrent).toBe(1);
  });

  it('resolves each push() with that task\'s own return value', async () => {
    const queue = new OpQueue();
    const results = await Promise.all([
      queue.push(async () => 1),
      queue.push(async () => 2),
      queue.push(async () => 3),
    ]);
    expect(results).toEqual([1, 2, 3]);
  });

  it('a rejected task does not block tasks queued after it', async () => {
    const queue = new OpQueue();
    const order = [];

    const failing = queue.push(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const after = queue.push(async () => {
      order.push('after');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'after']);
  });

  it('a rejected task does not block a task queued after it from also running exclusively', async () => {
    const queue = new OpQueue();
    let running = 0;
    let sawOverlap = false;

    queue.push(async () => {
      running++;
      await sleep(5);
      sawOverlap = sawOverlap || running > 1;
      running--;
      throw new Error('boom');
    }).catch(() => {});

    await queue.push(async () => {
      running++;
      sawOverlap = sawOverlap || running > 1;
      running--;
    });

    expect(sawOverlap).toBe(false);
  });
});
