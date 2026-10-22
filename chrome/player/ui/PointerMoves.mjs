// @ts-check
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
    // The first has no place to compare to: Firefox's own moves carry no movement. The page's
    // first could be one, when F goes fullscreen under a pointer that has not moved since the
    // page came, and it brought back the bar F hid (glm's review, 2026-10-13).
    const moved = this.screenX === null ?
      event.movementX !== 0 || event.movementY !== 0 :
      event.screenX !== this.screenX || event.screenY !== this.screenY;
    this.screenX = event.screenX;
    this.screenY = event.screenY;
    return moved;
  }
}
