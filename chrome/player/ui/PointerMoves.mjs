/**
 * Tells the user's mouse moves from the ones Firefox makes up. When the page changes under a
 * pointer that stays still (fullscreen on or off, the controls going), Firefox sends a
 * mousemove at the same place; that one must not bring the controls back. Every real move,
 * however small, does at once.
 *
 * It replaced a cooldown that ignored every move for a while after the controls were hidden by
 * a key or a click: 2 s after the fullscreen key, so in fullscreen the controls came only
 * after a lot of moving (his report, 2026-10-13; measured: six moves over hundreds of pixels,
 * half a second after F, showed nothing).
 */
export class PointerMoves {
  constructor() {
    this.screenX = null;
    this.screenY = null;
  }

  /**
   * @param {MouseEvent} event - A mousemove.
   * @return {boolean} Whether the pointer moved since the last one.
   */
  moved(event) {
    const moved = event.screenX !== this.screenX || event.screenY !== this.screenY;
    this.screenX = event.screenX;
    this.screenY = event.screenY;
    return moved;
  }
}
