// @ts-check
/**
 * One press of a mouse button, or one touch, from its mousedown or touchstart to its end,
 * however it ends. Every drag and hold in the player goes by it: the progress bar, the
 * volume, the timeline, the subtitles' position, the subtitle syncer's track, the silence
 * threshold line, a tool's long press (reordering) and the video's hold (twice the speed).
 *
 * Each of them ended on a mouseup of its own: in the player; then in the document too (the
 * frame a press began in hears its mouseup wherever the button is let go, over the page or
 * outside the window); then at a move with the button up, for a mouseup that never came -
 * each added where one was missed, one drag at a time. The hold had none of them: with the
 * window switched while the video was held, its mouseup went to the other window, and the
 * video played on at twice the speed until the next click (measured, 2026-10-28; the tool's
 * long press the same: reordering began after the button was let go). A press ends here, for
 * all of them:
 * - at its release, anywhere in the document, heard before any element can stop it (the
 *   subtitles menu and its rows stop mouseup);
 * - without one, end(null), the moment there can be none: the window lost the focus (another
 *   window or app took it), the tab was hidden, a context menu or the browser's own drag
 *   took the mouse, the touch was cancelled - or, for any other way, at a move with the
 *   button up.
 */

// The `buttons` bit of each `button`: 0 (left) is 1, 1 (middle) is 4, 2 (right) is 2.
const ButtonBits = [1, 4, 2, 8, 16];

/**
 * @typedef {Object} PressHandlers
 * @property {(event: MouseEvent|TouchEvent) => void} [move] - Each move while the press lasts.
 * @property {(release: MouseEvent|TouchEvent|null) => void} end - Once, when it ends: the
 *   mouseup or touchend that released it, or null when it ended without one.
 */

export class PressTracker {
  /**
   * Follows the press a mousedown or touchstart began.
   * @param {MouseEvent|TouchEvent} start - The mousedown or touchstart.
   * @param {PressHandlers} handlers
   * @return {{cancel: () => void}} cancel() ends the press now, as one without a release
   *   (end(null)), if it has not ended: the player went on to another video mid-drag.
   */
  static follow(start, {move, end}) {
    const doc = PressTracker.documentOf(start);
    const win = doc.defaultView;
    const touch = typeof start.type === 'string' && start.type.startsWith('touch');
    const button = /** @type {MouseEvent} */ (start).button || 0;
    const bit = ButtonBits[button] ?? 1;
    let ended = false;

    /** @type {Array<[EventTarget, string, EventListener, AddEventListenerOptions]>} */
    const listeners = [];
    /**
     * @param {EventTarget} target
     * @param {string} type
     * @param {(event: any) => void} fn
     * @param {AddEventListenerOptions} [options]
     */
    const listen = (target, type, fn, options = {capture: true}) => {
      target.addEventListener(type, fn, options);
      listeners.push([target, type, fn, options]);
    };
    /** @param {MouseEvent|TouchEvent|null} release */
    const finish = (release) => {
      if (ended) return;
      ended = true;
      for (const [target, type, fn, options] of listeners) {
        target.removeEventListener(type, fn, options);
      }
      end(release);
    };

    if (touch) {
      listen(doc, 'touchmove', (e) => move?.(e), {capture: true, passive: true});
      listen(doc, 'touchend', (e) => finish(e), {capture: true, passive: true});
      listen(doc, 'touchcancel', () => finish(null), {capture: true, passive: true});
    } else {
      listen(doc, 'mouseup', (/** @type {MouseEvent} */ e) => {
        if ((e.button || 0) === button) finish(e);
      });
      listen(doc, 'mousemove', (/** @type {MouseEvent} */ e) => {
        // The button up, with no mouseup heard: it was let go where this document could
        // not hear it.
        if (typeof e.buttons === 'number' && (e.buttons & bit) === 0) {
          finish(null);
          return;
        }
        move?.(e);
      });
      // Either takes the mouse, and its mouseup with it.
      listen(doc, 'contextmenu', () => finish(null));
      listen(doc, 'dragstart', () => finish(null));
    }
    listen(doc, 'visibilitychange', () => {
      if (doc.hidden) finish(null);
    });
    if (win) {
      // The window's own blur: in the capture phase every element's blur passes here too.
      listen(win, 'blur', (/** @type {FocusEvent} */ e) => {
        if (e.target === win) finish(null);
      });
    }
    return {cancel: () => finish(null)};
  }

  /**
   * Keeps the click a release brings from doing anything, for a press that was no click (a
   * hold): the video's would have played or paused it, a tool's run its action. Taken out at
   * the next press, should no click come (let go outside the document). Only a click of the
   * mouse is that one: a keyboard's (Enter on a focused button) or a script's .click() has no
   * detail, and goes through.
   * @param {MouseEvent|TouchEvent} release - The mouseup.
   */
  static swallowClick(release) {
    const doc = PressTracker.documentOf(release);
    /** @param {MouseEvent} e */
    const swallow = (e) => {
      if (!e.detail) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      done();
    };
    const done = () => {
      doc.removeEventListener('click', swallow, true);
      doc.removeEventListener('mousedown', done, true);
    };
    doc.addEventListener('click', swallow, true);
    doc.addEventListener('mousedown', done, true);
  }

  /**
   * @param {Event} event
   * @return {Document} The document the event happened in.
   */
  static documentOf(event) {
    const target = /** @type {Node|null} */ (event.target);
    return target?.ownerDocument || (target && 'defaultView' in target ? /** @type {Document} */ (/** @type {unknown} */ (target)) : document);
  }
}
