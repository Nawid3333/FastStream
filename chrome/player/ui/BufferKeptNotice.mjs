// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';
import {WebUtils} from '../utils/WebUtils.mjs';
import {DOMElements} from './DOMElements.mjs';

/**
 * In the middle of the bottom bar, for a while after the player took back what an earlier player of this video
 * downloaded (FastStreamClient.takeBackBuffer): how much it reuses, and a quiet button that downloads the video again,
 * for a kept buffer that plays wrong. Each part explains itself on hover. Apart from the status line, whose messages
 * (errors, a failed load) are not this one, and only in the room the bar has left: the size, then the button's word,
 * then the button go when it lacks the room (fit). The more menu's "Download the video again" stays for later.
 */
export class BufferKeptNotice {
  static ShownMs = 15000;

  constructor() {
    /** @type {?(() => void)} */
    this.onAgain = null;
    /** @type {?ReturnType<typeof setTimeout>} */
    this.timer = null;
    // The pointer or the keyboard's focus is on it: it stays until both left.
    this.held = {pointer: false, focus: false};
    this.due = false;
    const box = DOMElements.bufferKept;
    const again = DOMElements.bufferKeptAgain;
    if (!box || !again) return;
    again.addEventListener('click', (e) => {
      e.stopPropagation();
      const onAgain = this.onAgain;
      this.hide();
      if (onAgain) onAgain();
    });
    WebUtils.setupTabIndex(again);
    // A click on its text is none on the video.
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('pointerenter', () => this.hold('pointer', true));
    box.addEventListener('pointerleave', () => this.hold('pointer', false));
    box.addEventListener('focusin', () => this.hold('focus', true));
    box.addEventListener('focusout', () => this.hold('focus', false));
    // The room changes with the player's size and the status line's text.
    this.resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.fit()) : null;
  }

  /**
   * @param {number} bytes - What was taken back, in RAM and on the disk.
   * @param {() => void} onAgain - Downloads the video again.
   */
  show(bytes, onAgain) {
    const box = DOMElements.bufferKept;
    if (!box || !DOMElements.bufferKeptText || !DOMElements.bufferKeptAgain || !DOMElements.bufferKeptAgainText) return;
    const size = StringUtils.formatSize(bytes);
    DOMElements.bufferKeptText.textContent = Localize.getMessage('player_buffer_kept', [size]);
    DOMElements.bufferKeptText.title = Localize.getMessage('player_buffer_kept_title');
    DOMElements.bufferKeptAgainText.textContent = Localize.getMessage('player_buffer_kept_again');
    const explained = Localize.getMessage('player_buffer_kept_again_title', [size]);
    DOMElements.bufferKeptAgain.title = explained;
    DOMElements.bufferKeptAgain.ariaLabel = explained;
    this.onAgain = onAgain;
    this.due = false;
    box.style.display = '';
    box.parentElement?.classList.add('buffer_kept_shown');
    this.resizes?.observe(box);
    this.fit();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.held.pointer || this.held.focus) {
        this.due = true;
      } else {
        this.hide();
      }
    }, BufferKeptNotice.ShownMs);
  }

  hide() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.onAgain = null;
    this.due = false;
    this.held = {pointer: false, focus: false};
    const box = DOMElements.bufferKept;
    if (!box) return;
    this.resizes?.disconnect();
    box.style.display = 'none';
    box.parentElement?.classList.remove('buffer_kept_shown');
  }

  /**
   * The most of it the room in the bar takes: all, the button with its word, the button alone, or nothing.
   */
  fit() {
    const box = DOMElements.bufferKept;
    const text = DOMElements.bufferKeptText;
    const again = DOMElements.bufferKeptAgain;
    const word = DOMElements.bufferKeptAgainText;
    if (!box || !text || !again || !word || box.style.display === 'none' || typeof getComputedStyle !== 'function') return;
    box.classList.remove('no_text', 'no_label');
    box.style.visibility = '';
    const style = getComputedStyle(box);
    const room = box.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const gap = parseFloat(style.columnGap) || 0;
    if (text.offsetWidth + gap + again.offsetWidth <= room) return;
    box.classList.add('no_text');
    if (again.offsetWidth <= room) return;
    box.classList.add('no_label');
    if (again.offsetWidth <= room) return;
    box.style.visibility = 'hidden';
  }

  isShown() {
    return !!DOMElements.bufferKept && DOMElements.bufferKept.style.display !== 'none';
  }

  /**
   * @param {'pointer'|'focus'} by
   * @param {boolean} held
   */
  hold(by, held) {
    this.held[by] = held;
    if (this.due && !this.held.pointer && !this.held.focus) this.hide();
  }
}
