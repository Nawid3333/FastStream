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

describe('a GIF recorded in a tab that goes to the background', () => {
  it('is dropped, and the video stops at its own speed: no frames come there to end it', () => {
    // glm's review, 2026-11-16: the recording ended only in an animation frame, which a
    // background tab does not get, and the video played on at 4x, over and over.
    const {menu, client, frames} = setup();
    const status = vi.fn();
    const gif = {abort: vi.fn(), addFrame: vi.fn(), on: vi.fn(), render: vi.fn()};
    Object.assign(client, {player: {getVideo: () => ({loop: true, addEventListener() {}})},
      paused: false, playbackRate: 4, pause: vi.fn(), setPlaybackRate: vi.fn(),
      interfaceController: {setStatusMessage: status}});
    Object.assign(menu, {gif, gifLoopRunning: true, recordingGif: true, loopWasEnabled: false, previousPlaybackRate: 1,
      toggleLoopButton: {classList: {add() {}, remove() {}}, textContent: ''}});
    vi.stubGlobal('document', {hidden: true});
    menu.timeupdateHandler();
    expect(menu.gifLoopRunning).toBe(false);
    expect(client.pause).toHaveBeenCalled();
    expect(client.setPlaybackRate).toHaveBeenCalledWith(1, true);
    expect(gif.abort).toHaveBeenCalled();
    expect(gif.render).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('save-gif', 'loop_menu_gif_abort', 'info', 5000);
    expect(frames).toEqual([]);
  });
});

describe('a GIF of a video whose frames cannot be read back', () => {
  it('is dropped, and the video stops at its own speed', () => {
    // A video that taints the canvas: reading a frame back throws, which stopped the frames
    // with the video playing on at 4x (glm's review, 2026-11-16).
    const {menu, client, frames, runFrames} = setup();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gif = {abort: vi.fn(), addFrame: vi.fn(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    }), on: vi.fn(), render: vi.fn()};
    Object.assign(client, {player: {currentTime: 2.5, getVideo: () => ({loop: true, addEventListener() {}})},
      paused: false, playbackRate: 4, pause: vi.fn(), setPlaybackRate: vi.fn(),
      interfaceController: {setStatusMessage: vi.fn()}});
    Object.assign(menu, {gif, gifLoopRunning: true, recordingGif: true, lastTimeRecorded: 2.3, loopWasEnabled: false,
      previousPlaybackRate: 1, gifCanvas: {width: 1, height: 1}, gifCtx: {drawImage() {}},
      toggleLoopButton: {classList: {add() {}, remove() {}}, textContent: ''}});
    menu.gifLoop();
    runFrames(3);
    expect(menu.gifLoopRunning).toBe(false);
    expect(client.setPlaybackRate).toHaveBeenCalledWith(1, true);
    expect(gif.abort).toHaveBeenCalled();
    expect(frames).toEqual([]);
  });
});

describe('the end of a GIF', () => {
  /**
   * A menu whose GIF recording is ending, its last frame drawn at `lastTimeRecorded`.
   * @param {?number} lastTimeRecorded
   * @return {{menu: Object, gif: Object, status: Function}}
   */
  function ending(lastTimeRecorded) {
    const {menu, client} = setup();
    const gif = {frames: [], addFrame: vi.fn((canvas, options) => gif.frames.push(options)), on: vi.fn(), abort: vi.fn(),
      render: vi.fn(() => {
        if (!gif.frames.length) throw new Error('Width and height must be set prior to rendering');
      })};
    const status = vi.fn();
    client.interfaceController = {setStatusMessage: status};
    Object.assign(menu, {gif, lastTimeRecorded, gifCanvas: {width: 1, height: 1}, gifCtx: {}});
    return {menu, gif, status};
  }

  it('has the last frame drawn, shown until the loop\'s end', () => {
    // Each frame was added when the next one was drawn: the last one never was.
    const {menu, gif} = ending(3.9);
    menu.finishGif();
    expect(gif.frames).toEqual([{delay: 100, copy: true}]);
    expect(gif.render).toHaveBeenCalledTimes(1);
  });

  it('shows the last frame until the loop\'s end when the loop was off before the GIF', () => {
    // Ending the recording turns such a loop off again, and with it its end.
    const {menu, gif} = ending(3.9);
    const video = {loop: true, addEventListener() {}, removeEventListener() {}};
    Object.assign(menu.client, {pause() {}, setPlaybackRate() {}, player: {getVideo: () => video}});
    Object.assign(menu, {gifLoopRunning: true, loopWasEnabled: false, previousPlaybackRate: 1, timeInputs: {},
      toggleLoopButton: {classList: {add() {}, remove() {}}}});
    menu.endGifLoop();
    expect(menu.loopEnd).toBe(null);
    expect(gif.frames).toEqual([{delay: 100, copy: true}]);
  });

  it('is dropped with no frame, rather than thrown on', () => {
    const {menu, gif, status} = ending(null);
    expect(() => menu.finishGif()).not.toThrow();
    expect(gif.render).not.toHaveBeenCalled();
    expect(menu.gif).toBe(null);
    expect(status).toHaveBeenCalledWith('save-gif', 'loop_menu_gif_abort', 'info', 5000);
  });
});
