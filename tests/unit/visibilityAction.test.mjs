import fs from 'node:fs';
import {describe, expect, it} from 'vitest';

// The visibility actions (a play the browser blocks, picture-in-picture with no click behind
// it) rejected at every tab change with nothing to hear it (glm's review, 2026-10-22).
// InterfaceController cannot be imported in Node (its UI touches the DOM at module scope),
// so its source is read.
const source = fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8');

describe('InterfaceController, the visibility action', () => {
  it('runs only through visibilityChanged, which hears its failure', () => {
    const calls = [...source.matchAll(/this\.handleVisibilityChange\([^)]*\)/g)].map((match) => match[0]);
    expect(calls).toEqual(['this.handleVisibilityChange(isVisible)']);
    expect(source).toMatch(/visibilityChanged\(isVisible\) \{\s*this\.handleVisibilityChange\(isVisible\)\.catch\(/);
  });
});

describe('InterfaceController.handleVisibilityChange', () => {
  // VisChangeActions has no PIP (it is commented out there), so the switch's PIP case was a
  // `case undefined:` - an action that was not set entered picture-in-picture whenever the
  // page was hidden (the review of 2026-11-13). The method runs here as written in the
  // source, on a stand-in controller.
  const start = source.indexOf('  async handleVisibilityChange(isVisible) {');
  const end = source.indexOf('\n  }\n', start);
  const method = new Function('VisChangeActions', 'MiniplayerCooldown',
      `return {${source.slice(start, end)}\n  }}.handleVisibilityChange;`);

  /**
   * A controller whose page was visible, its player playing.
   * @param {*} action - options.visChangeAction.
   * @return {Object}
   */
  const controller = (action) => ({
    client: {needsUserInteraction: () => false, options: {visChangeAction: action}, state: {playing: true},
      player: {pause: async () => {}, play: async () => {}}},
    state: {fullscreen: false, miniplayer: false, windowedFullscreen: false},
    lastPageVisibility: true,
    isInPip: () => false,
    enterPip: async () => {
      throw new Error('picture-in-picture');
    },
    exitPip: async () => {},
    requestMiniplayer: () => {},
  });

  it('does nothing for an action that is not set, nor for one it does not know', async () => {
    // The options page's list, the web build's (no miniplayer there: its key is deleted).
    const VisChangeActions = {NOTHING: 'nothing', PLAY_PAUSE: 'playpause', MINI_PLAYER: 'miniplayer'};
    for (const action of [undefined, 'pip', null]) {
      const run = method(VisChangeActions, 0);
      await expect(run.call(controller(action), false), String(action)).resolves.toBe(undefined);
    }
  });
});
