// @ts-check
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';

/**
 * @param {*} a
 * @param {*} b
 * @return {boolean} Whether two option values are the same data.
 */
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class OptionsStore {
  /** @type {Object<string, *>|null} */
  static #options = null;
  /**
   * The options as last read or saved, a copy: the page changes the object it was given in
   * place, and a save writes what differs from this.
   * @type {Object<string, *>|null}
   */
  static #saved = null;
  static #listeners = new Set();
  /**
   * One per save whose echo has not come back: a dragged slider saves once a frame, and a late
   * echo taken for a change made elsewhere would redraw the page mid-drag.
   * @type {number[]}
   */
  static #pendingSendTimes = [];
  /** @type {?Promise<void>} The first init()'s load, which every later caller waits for. */
  static #initialized = null;
  /** @type {Promise<void>} The saves, one after the other: each reads what the last wrote. */
  static #saving = Promise.resolve();

  static async init() {
    this.#initialized ??= (async () => {
      this.#take(await Utils.getOptionsFromStorage());
      this.#wireExternalUpdates();
    })().catch((e) => {
      // Not kept: the next call reads the storage again.
      this.#initialized = null;
      throw e;
    });
    await this.#initialized;
    return this.#options;
  }

  static get() {
    return this.#options ?? DefaultOptions;
  }

  /**
   * Saves the page's options. Only what the page changed is written, over the options as
   * stored now: a page's copy can be older than a save made elsewhere (a player's settings, the
   * background), and writing it whole put that save back.
   * @param {Object} newOptions
   * @return {Promise<void>}
   */
  static replace(newOptions) {
    const options = /** @type {Object<string, *>} */ (Utils.mergeOptions(DefaultOptions, newOptions || {}));
    const saved = this.#saved;
    const changed = Object.keys(options).filter((key) => !saved || !sameValue(options[key], saved[key]));
    this.#take(options);
    const save = this.#saving.then(() => this.#persistAndNotify(options, changed));
    this.#saving = save.catch(() => {});
    return save;
  }

  /**
   * @param {(opts: Object)=>void} fn
   */
  static subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {Object<string, *>} options */
  static #take(options) {
    this.#options = options;
    this.#saved = structuredClone(options);
  }

  /**
   * @param {Object<string, *>} options - What replace() was given, merged.
   * @param {string[]} changed - Its keys that differ from what the page had read or saved.
   */
  static async #persistAndNotify(options, changed) {
    /** @type {Object<string, *>} */
    let stored;
    try {
      stored = await Utils.getOptionsFromStorage();
    } catch (e) {
      console.error('Reading the options before saving them failed', e);
      stored = {...options};
    }
    for (const key of changed) stored[key] = options[key];
    await Utils.setConfig('options', JSON.stringify(stored));
    // Saved elsewhere since the page read them, and no later save of its own came: the page
    // shows them now.
    if (this.#options === options && Object.keys(options).some((key) => !sameValue(stored[key], options[key]))) {
      this.#take(stored);
    }

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

    this.#notify();
  }

  static #notify() {
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
        // A page with no opener or parent posts its saves to itself.
        if (e.source === window) return;
        if (e.data?.type === 'options') {
          this.#reloadFromStorage();
        }
      });
    }
  }

  /**
   * After the saves on their way: read before one was written, the page showed the value it
   * had just replaced, and never wrote it again.
   * @return {Promise<void>}
   */
  static #reloadFromStorage() {
    this.#saving = this.#saving.then(async () => {
      try {
        this.#take(await Utils.getOptionsFromStorage());
        this.#notify();
      } catch (e) {
        console.error('Failed to reload options', e);
      }
    });
    return this.#saving;
  }
}
