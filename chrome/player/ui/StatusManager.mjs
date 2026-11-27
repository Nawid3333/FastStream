// @ts-check
import {DOMElements} from './DOMElements.mjs';

export const StatusTypes = {
  WELCOME: 'welcome',
  DOWNLOAD: 'download',
  // Notices about the video: over its download line, under the rest.
  WAIT: 'wait',
  SUBTITLES_HINT: 'subtitles-hint',
  RESUMED: 'resumed',
  // A buffer an earlier player of the video handed over, taken back (FastStreamClient.takeBackBuffer): one click starts over.
  REQINTERACTION: 'reqinteraction',
  INFO: 'info',
  ERROR: 'error',
  SAVE_VIDEO: 'save-video',
  SAVE_SCREENSHOT: 'save-screenshot',
  SAVE_GIF: 'save-gif',
  SILENCE_SKIP: 'silence-skip',
  SUBTITLES: 'subtitles',
  COPY: 'copy',
  MPV: 'mpv',
  // A quality the player lowered by itself (FastStreamClient.watchDroppedFrames).
  QUALITY: 'quality',
  // The audio output chosen, not applied (AudioOutputDevice): one click applies it.
  AUDIO_OUTPUT: 'audio-output',
};

// How long the whole text of a new message cut short shows by itself: about its reading time.
const FullTextMsPerChar = 60;
const FullTextMinMs = 4000;
const FullTextMaxMs = 15000;

/**
 * @param {string} message
 * @return {number}
 */
function readingMs(message) {
  return Math.min(FullTextMaxMs, Math.max(FullTextMinMs, message.length * FullTextMsPerChar));
}

/**
 * A message with its numbers left out: a progress or a countdown that moves on is the same message.
 * @param {string} message
 * @return {string}
 */
function messageShape(message) {
  return message.replace(/\d[\d.,]*/g, '#');
}

/**
 * @param {HTMLElement} element
 * @return {boolean}
 */
function isCutShort(element) {
  return element.scrollWidth > element.clientWidth;
}

export class StatusManager {
  constructor() {
    this.statusMessages = new Map();
    /** @type {Array<*>} The level shown in each status message, or null. */
    this.displayed = [];
    /**
     * The status message the pointer is on, whatever it shows; after a finger lifts, the message it was on.
     * @type {?{index: number, level: *, until: number}}
     */
    this.pointedAt = null;
    DOMElements.statusMessages.forEach((element, index) => {
      element.onpointerenter = () => {
        this.pointedAt = {index, level: null, until: Infinity};
        this.updateStatusMessage();
      };
      element.onpointerleave = (/** @type {PointerEvent} */ e) => {
        // A finger leaves as it lifts: the text stays for its reading time.
        const level = this.displayed[index];
        this.pointedAt = e.pointerType === 'touch' && level ? {index, level, until: Date.now() + readingMs(level.message)} : null;
        this.updateStatusMessage();
      };
    });

    this.registerStatusLevel(StatusTypes.WELCOME);
    this.registerStatusLevel(StatusTypes.DOWNLOAD);
    // A level each: on one level, a notice ended another's time. A later level shows over an earlier one.
    this.registerStatusLevel(StatusTypes.WAIT);
    this.registerStatusLevel(StatusTypes.SUBTITLES_HINT);
    this.registerStatusLevel(StatusTypes.RESUMED);
    this.registerStatusLevel(StatusTypes.REQINTERACTION);
    this.registerStatusLevel(StatusTypes.INFO);
    this.registerStatusLevel(StatusTypes.ERROR);

    this.registerStatusLevel(StatusTypes.SAVE_VIDEO, 1);
    this.registerStatusLevel(StatusTypes.SAVE_SCREENSHOT, 1);
    this.registerStatusLevel(StatusTypes.SAVE_GIF, 1);
    this.registerStatusLevel(StatusTypes.SILENCE_SKIP, 1);
    this.registerStatusLevel(StatusTypes.SUBTITLES, 1);
    this.registerStatusLevel(StatusTypes.COPY, 1);
    this.registerStatusLevel(StatusTypes.MPV, 1);
    this.registerStatusLevel(StatusTypes.QUALITY, 1);
    this.registerStatusLevel(StatusTypes.AUDIO_OUTPUT, 1);
  }

  /**
   * @param {string} key
   * @param {number=} channel
   */
  registerStatusLevel(key, channel) {
    const level = {
      key,
      message: '',
      type: 'info',
      expiry: 0,
      channel: channel || 0,
      maxWidth: 0,
      /** @type {?(() => void)} */
      onClick: null,
      // Not shown yet: whole above the bar if the bar cuts it short.
      fresh: false,
      // When it showed first, and until when it shows whole (0: it fits, or it is gone).
      readFrom: 0,
      readUntil: 0,
    };
    this.statusMessages.set(key, level);
  }

  /**
   * @param {string} key
   * @param {string|null} [message] - null or none clears the level's message.
   * @param {string=} type
   * @param {number=} expiry
   * @param {?(() => void)} [onClick] - What a click on it does (it shows as clickable);
   *   without, a click goes on to the player, as before.
   */
  setStatusMessage(key, message, type, expiry, onClick = null) {
    const level = this.statusMessages.get(key);
    if (!level) {
      throw new Error(`Unknown status level ${key}`);
    }

    const shown = level.expiry && Date.now() > level.expiry ? '' : level.message;
    // The download line changes all the time.
    level.fresh = Boolean(message) && key !== StatusTypes.DOWNLOAD &&
      (level.fresh || !shown || messageShape(shown) !== messageShape(message || '') || level.type !== (type || 'info'));
    if (!message || level.fresh) level.readUntil = 0;
    level.message = message;
    level.type = type || 'info';
    level.expiry = expiry ? (Date.now() + expiry) : 0;
    level.onClick = message ? onClick : null;
    this.updateStatusMessage();
  }

  updateStatusMessage() {
    const elements = DOMElements.statusMessages;
    const toDisplayList = new Array(elements.length).fill(null);
    this.statusMessages.forEach((level) => {
      if (level.expiry && Date.now() > level.expiry) {
        level.message = '';
      }
      if (level.message) {
        toDisplayList[level.channel] = level;
      }
    });

    let displayCount = 0;
    toDisplayList.forEach((toDisplay, index) => {
      const element = elements[index];
      if (!toDisplay) {
        element.style.display = 'none';
        return;
      }

      displayCount++;

      element.style.width = '';
      element.style.display = '';
      element.textContent = toDisplay.message;
      element.className = `status_message ${toDisplay.type}${toDisplay.onClick ? ' clickable' : ''}`;
      const onClick = toDisplay.onClick;
      element.onclick = onClick ? (e) => {
        e.stopPropagation();
        onClick();
      } : null;
    });

    if (displayCount > 1) {
      // Fix the widths of the earlier status messages
      let lastFound = false;
      for (let i = toDisplayList.length - 1; i >= 0; i--) {
        const toDisplay = toDisplayList[i];
        if (!toDisplay) {
          continue;
        }

        if (!lastFound) {
          lastFound = true;
          continue;
        }

        const element = /** @type {HTMLElement} */ (elements[i]);
        const width = element.offsetWidth + 5;

        toDisplay.maxWidth = Math.max(toDisplay.maxWidth, width);
        element.style.width = toDisplay.maxWidth + 'px';
      }
    } else {
      this.statusMessages.forEach((level) => {
        level.maxWidth = 0;
      });
    }

    this.updateFullText(toDisplayList, elements);
  }

  /**
   * The whole text of a status message the bar cuts short (a narrow player, a long text), wrapped above the bar:
   * for its reading time when it is new, and while the pointer is on it. Its title shows late, and never on touch.
   * @param {Array<*>} toDisplayList - The level shown in each status message, or null.
   * @param {NodeListOf<HTMLElement>|Array<HTMLElement>} elements
   */
  updateFullText(toDisplayList, elements) {
    const bubble = DOMElements.statusFullText;
    const now = Date.now();
    this.displayed = toDisplayList;
    toDisplayList.forEach((level, index) => {
      if (!level?.fresh) return;
      level.fresh = false;
      level.readFrom = now;
      level.readUntil = isCutShort(elements[index]) ? now + readingMs(level.message) : 0;
    });
    const pointed = this.pointedAt;
    if (pointed && (now > pointed.until || (pointed.level && toDisplayList[pointed.index] !== pointed.level))) {
      this.pointedAt = null;
    }
    // The message pointed at, else the newest still in its reading time (another's end shows the one under it again).
    // Measured only then: each measure lays the page out.
    const candidates = toDisplayList.map((level, index) => ({level, index}))
        .filter(({level}) => level && level.readUntil > now)
        .sort((a, b) => b.level.readFrom - a.level.readFrom);
    if (this.pointedAt && toDisplayList[this.pointedAt.index]) {
      candidates.unshift({level: toDisplayList[this.pointedAt.index], index: this.pointedAt.index});
    }
    const level = candidates.find(({index}) => isCutShort(elements[index]))?.level ?? null;
    if (!bubble) return;
    if (!level) {
      bubble.style.display = 'none';
      return;
    }
    bubble.style.display = '';
    bubble.textContent = level.message;
    bubble.className = `status_full_text ${level.type}`;
  }
}
