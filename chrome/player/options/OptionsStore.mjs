// @ts-check
import {EnvUtils} from '../utils/EnvUtils.mjs';
import {Utils} from '../utils/Utils.mjs';
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {MessageTypes} from '../enums/MessageTypes.mjs';

export class OptionsStore {
  /** @type {Object|null} */
  static #options = null;
  static #listeners = new Set();
  /**
   * One per save whose echo has not come back: a dragged slider saves once a frame, and a late
   * echo taken for a change made elsewhere would redraw the page mid-drag.
   * @type {number[]}
   */
  static #pendingSendTimes = [];
  /** @type {?Promise<void>} The first init()'s load, which every later caller waits for. */
  static #initialized = null;

  static async init() {
    this.#initialized ??= (async () => {
      this.#options = await Utils.getOptionsFromStorage();
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
   * @param {Object} newOptions
   */
  static async replace(newOptions) {
    this.#options = Utils.mergeOptions(DefaultOptions, newOptions || {});
    await this.#persistAndNotify();
  }

  /**
   * @param {(opts: Object)=>void} fn
   */
  static subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  static async #persistAndNotify() {
    await Utils.setConfig('options', JSON.stringify(this.#options));

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

