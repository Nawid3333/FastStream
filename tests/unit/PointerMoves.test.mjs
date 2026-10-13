import {describe, expect, it} from 'vitest';
import {PointerMoves} from '../../chrome/player/ui/PointerMoves.mjs';

// The controls come back at a mouse move: every real one, at once, but not the one Firefox
// sends at the same place when the page changes under a still pointer (fullscreen on or
// off). A cooldown ignored every move for 2 s after the fullscreen key instead.

describe('PointerMoves', () => {
  it('counts the first move', () => {
    expect(new PointerMoves().moved({screenX: 10, screenY: 20, movementX: 3, movementY: 0})).toBe(true);
  });

  it('does not count a first move that did not move, and counts the next real one', () => {
    // The page's first mousemove can be Firefox's own, when F goes fullscreen under a pointer
    // that has not moved since the page came: with no place to compare it to, it brought back
    // the bar F hid (glm's review, 2026-10-13). Firefox's own moves carry no movement.
    const moves = new PointerMoves();
    expect(moves.moved({screenX: 10, screenY: 20, movementX: 0, movementY: 0})).toBe(false);
    expect(moves.moved({screenX: 11, screenY: 20, movementX: 1, movementY: 0})).toBe(true);
  });

  it('counts a move of one pixel, either way', () => {
    const moves = new PointerMoves();
    moves.moved({screenX: 10, screenY: 20});
    expect(moves.moved({screenX: 11, screenY: 20})).toBe(true);
    expect(moves.moved({screenX: 11, screenY: 19})).toBe(true);
  });

  it('does not count a move at the same place on the screen, wherever it is in the page', () => {
    // Fullscreen moved the page under the pointer: the page's coordinates change, the
    // screen's do not.
    const moves = new PointerMoves();
    moves.moved({screenX: 10, screenY: 20, clientX: 10, clientY: 20});
    expect(moves.moved({screenX: 10, screenY: 20, clientX: 300, clientY: 200})).toBe(false);
  });
});
