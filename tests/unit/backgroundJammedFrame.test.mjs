import {afterEach, describe, expect, it} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// A content script shares its page's event loop: a page that never lets go of it never
// answers the background. Three questions waited for that answer with no limit, and held a
// player for good - its start (PLAYER_LOADED is answered before it plays), or its
// fullscreen, windowed fullscreen or miniplayer request (glm's review, 2026-11-16). They
// now give up, as the background's other questions to a frame do (askFrame).

const PAGE = 'https://site.test/watch/1';
const player = (opener) => `moz-extension://bg-test/player/index.html?opener=${opener}`;
const NEVER = new Promise(() => {});

let bg;
/** @type {Set<string>} The messages the page's frames never answer. */
let jammed;

afterEach(() => {
  bg?.unload();
  bg = null;
});

async function load() {
  jammed = new Set();
  bg = await loadBackground({
    tabs: [{id: 1, url: PAGE}],
    onTabMessage: ({message}) => (jammed.has(message.type) ? NEVER : undefined),
  });
  await bg.navigated(1, PAGE);
}

/**
 * Sends a message and does not wait for its answer.
 * @return {{answer: *}} answer is 'none yet' until the background answers.
 */
function ask(message, from) {
  const state = {answer: 'none yet'};
  void bg.message(message, {...from, onAnswer: (value) => {
    state.answer = value;
  }});
  return state;
}

describe('a page that never answers the background', () => {
  it('does not hold a player that asks whose it is', async () => {
    // The page never named itself here (the background started again since): its content
    // script is asked whether it opened the player.
    await load();
    jammed.add('IS_PLAYER_OPENER');
    const loaded = ask({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 5});
    await bg.wait(3100);
    expect(bg.sent('IS_PLAYER_OPENER')).toHaveLength(1);
    // No proof: no page's player, as when the page says no.
    expect(loaded.answer).toBe(null);
  });

  it('does not hold a player\'s start while it is introduced to its page', async () => {
    await load();
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    jammed.add('FRAME_LINK_RECEIVER');
    const loaded = ask({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 5});
    await bg.wait(3100);
    expect(bg.sent('FRAME_LINK_RECEIVER')).toHaveLength(1);
    expect(loaded.answer).toEqual(expect.objectContaining({isMainPlayer: true}));
  });

  it('answers a player\'s windowed fullscreen request, later than its other questions', async () => {
    await load();
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.message({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 5});
    jammed.add('TOGGLE_WINDOWED_FULLSCREEN');
    const request = ask({type: 'REQUEST_WINDOWED_FULLSCREEN', force: true}, {tabId: 1, frameId: 5});
    // Firefox's fullscreen transition comes before content.js's answer: it is waited for longer.
    await bg.wait(8000);
    expect(request.answer).toBe('none yet');
    await bg.wait(1100);
    expect(bg.sent('TOGGLE_WINDOWED_FULLSCREEN')).toHaveLength(1);
    // No answer, as for a frame without a content script.
    expect(request.answer).toBe(undefined);
  });

  it('control: a page that answers is heard at once', async () => {
    await load();
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.message({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 5});
    bg.unload();
    bg = await loadBackground({
      tabs: [{id: 1, url: PAGE}],
      onTabMessage: ({message}) => (message.type === 'TOGGLE_WINDOWED_FULLSCREEN' ? 'enter' : undefined),
    });
    await bg.navigated(1, PAGE);
    await bg.frameAdded(1, 0, PAGE, 'page-1');
    await bg.message({type: 'PLAYER_LOADED', url: player('page-1'), parentFrameId: 0}, {tabId: 1, frameId: 5});
    const request = ask({type: 'REQUEST_WINDOWED_FULLSCREEN', force: true}, {tabId: 1, frameId: 5});
    await bg.wait(0);
    expect(request.answer).toBe('enter');
  });
});
