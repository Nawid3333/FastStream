import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';

// The A-B loop's check (LoopMenu.checkLoopLoop) asked for the next animation frame whenever
// the loop was on, a paused video too: 60 to 144 calls a second for nothing, as the progress
// loop did until 2026-10-06 (docs/notes/player.md). It rests while the video is paused now:
// playing starts it again (InterfaceController.play), and a seek while paused is kept within
// the loop by the video's timeupdate (the review of 2026-11-13).
//
// LoopMenu imports gif.mjs, which the build generates (tools/sync-vendor.mjs): a stand-in here,
// as are the player's elements and its strings.
vi.mock('../../chrome/player/modules/gif/gif.mjs', () => ({GIF: class {}}));
vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));

const {LoopMenu} = await import('../../chrome/player/ui/menus/LoopMenu.mjs');

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A loop from 2 s to 4 s on a video at 3 s, paused, and the animation frames it asks for.
 * @return {{menu: Object, client: Object, frames: Function[], runFrames: (count: number) => number}}
 */
function setup() {
  const frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback) => frames.push(callback));
  vi.stubGlobal('document', {hidden: false});
  const client = {player: {}, currentTime: 3, paused: true, duration: 10};
  const menu = new LoopMenu(client);
  Object.assign(menu, {loopEnabled: true, loopRangeValid: true, loopStart: 2, loopEnd: 4});
  // The screen's frames: each runs the callbacks asked for before it. Gives how many it ran.
  const runFrames = (count) => {
    let ran = 0;
    for (let i = 0; i < count; i++) {
      const due = frames.splice(0);
      due.forEach((callback) => callback());
      ran += due.length;
    }
    return ran;
  };
  return {menu, client, frames, runFrames};
}

describe('the A-B loop\'s check', () => {
  it('rests while the video is paused', () => {
    const {menu, runFrames} = setup();
    menu.startLoopLoop();
    // A second of a 60 Hz screen.
    expect(runFrames(60)).toBeLessThan(5);
  });

  it('runs again when the video plays, and goes back to the start at the end point', () => {
    const {menu, client, runFrames} = setup();
    menu.startLoopLoop();
    runFrames(60);
    client.paused = false;
    menu.startLoopLoop();
    expect(runFrames(10)).toBe(10);
    client.currentTime = 4.02;
    runFrames(1);
    expect(client.currentTime).toBe(2);
  });

  it('keeps a seek made while paused within the loop', () => {
    const {menu, client} = setup();
    menu.startLoopLoop();
    client.currentTime = 7;
    menu.timeupdateHandler();
    expect(client.currentTime).toBe(2);
  });

  it('is started again by every play', () => {
    // InterfaceController imports coloris.mjs, which the build generates: read from the source.
    const ui = fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8');
    expect(ui).toMatch(/\n {2}play\(\) \{[^}]*this\.loopControls\.startLoopLoop\(\);/);
  });
});
