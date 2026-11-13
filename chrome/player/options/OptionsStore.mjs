// @ts-check
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';

/**
 * Centralized options store with load/save, merge and change subscriptions.
 */
export class OptionsStore {
  /** @type {Object|null} */
  static #options = null;
  static #listeners = new Set();
  /**
   * The times of this page's saves whose echo (UPDATE_OPTIONS) has not come back yet, one per
   * save. Only the latest save's was known: a dragged slider saves once a frame, and an earlier
   * save's echo that came after the next save was taken for a change made elsewhere, which
   * redrew the page and put the slider back mid-drag.
   * @type {number[]}
   */
  static #pendingSendTimes = [];
  /** @type {?Promise<void>} The first init()'s load, which every later caller waits for. */
  static #initialized = null;

  /**
   * Initialize the store by loading options and wiring external updates.
   */
  static async init() {
    // A second caller while the first still read the storage got null.
    this.#initialized ??= (async () => {
      this.#options = await Utils.getOptionsFromStorage();
      this.#wireExternalUpdates();
    })().catch((e) => {
      // Not kept: the next call reads the storage again, where one failed read failed every
      // later init() on the page.
      this.#initialized = null;
      throw e;
    });
    await this.#initialized;
    // The options as they are now: a save since the first load replaced the object.
    return this.#options;
  }

  /**
   * Get current options (ensure init() has been awaited somewhere first).
   */
  static get() {
    return this.#options ?? DefaultOptions;
  }

  /**
   * Replace entire options object and persist/broadcast.
   * @param {Object} newOptions
   */
  static async replace(newOptions) {
    this.#options = Utils.mergeOptions(DefaultOptions, newOptions || {});
    await this.#persistAndNotify();
  }

  /**
   * Subscribe to changes. Returns unsubscribe function.
   * @param {(opts: Object)=>void} fn
   */
  static subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  static async #persistAndNotify() {
    // Persist
    await Utils.setConfig('options', JSON.stringify(this.#options));

    // Broadcast to other contexts
    if (EnvUtils.isExtension()) {
      const time = Date.now();
      this.#pendingSendTimes.push(time);
      // Bounded: an echo may never come (a tab the background does not know of).
      if (this.#pendingSendTimes.length > 100) this.#pendingSendTimes.shift();
      chrome.runtime?.sendMessage?.({
        type: MessageTypes.LOAD_OPTIONS,
        time,
      });
    } else {
      const postWindow = window.opener || window.parent || window;
      postWindow.postMessage({type: 'options'}, '/');
    }

    // Local listeners
    this.#listeners.forEach((fn) => {
      try {
        fn(this.#options);
      } catch (e) {
        console.error(e);
      }
    });
  }

  static #wireExternalUpdates() {
    if (EnvUtils.isExtension()) {
      chrome.runtime?.onMessage?.addListener?.((request) => {
        if (request?.type === MessageTypes.UPDATE_OPTIONS) {
          // Ignore our own echo, each one once.
          const own = request.time ? this.#pendingSendTimes.indexOf(request.time) : -1;
          if (own !== -1) {
            this.#pendingSendTimes.splice(own, 1);
            return;
          }
          this.#reloadFromStorage();
        }
      });
    } else {
      window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return;
        // Ignore our own echo: a page with no opener or parent (the options page opened on
        // its own) posts its saves to itself, and reloading them redrew the whole page after
        // each change, the keybind box a key was just set in included.
        if (e.source === window) return;
        if (e.data?.type === 'options') {
          this.#reloadFromStorage();
        }
      });
    }
  }

  static async #reloadFromStorage() {
    try {
      this.#options = await Utils.getOptionsFromStorage();
      this.#listeners.forEach((fn) => {
        try {
          fn(this.#options);
        } catch (e) {
          console.error(e);
        }
      });
    } catch (e) {
      console.error('Failed to reload options', e);
    }
  }
}

