import {describe, expect, it} from 'vitest';
import {PointerMoves} from '../../chrome/player/ui/PointerMoves.mjs';

// The controls come back at a mouse move: every real one, at once, but not the one Firefox
// sends at the same place when the page changes under a still pointer (fullscreen on or
// off). A cooldown ignored every move for 2 s after the fullscreen key instead.

describe('PointerMoves', () => {
  it('counts the first move', () => {
    expect(new PointerMoves().moved({screenX: 10, screenY: 20})).toBe(true);
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
