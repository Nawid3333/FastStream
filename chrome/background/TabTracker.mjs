// @ts-check
import {BackgroundUtils} from './BackgroundUtils.mjs';

export class FrameHolder {
  constructor(tab, frameId) {
    this.tab = tab;
    this.frameId = frameId;
    this.parent = null;
    this.children = new Set();
    this.loadedCallbacks = new Set();
    this.reset();
  }

  reset() {
    this.playerOpening = false;
    this.isPlayer = false;
    this.trackedSubtitles = [];
    this.trackedSources = [];
    this.requestHeaders = new Map();
    this.url = '';
    /**
     * The name content.js gave the page it shows (FRAME_ADDED); null when unknown.
     * @type {?string}
     */
    this.documentKey = null;
  }

  removeChildFrame(childFrame) {
    this.children.delete(childFrame);
    childFrame.parent = null;
  }

  addChildFrame(childFrame) {
    this.children.add(childFrame);
    childFrame.parent = this;
  }

  setParentFrame(parentFrame) {
    parentFrame.children.add(this);
    this.parent = parentFrame;
  }


  hasPlayer() {
    if (this.isPlayer) {
      return true;
    }

    for (const child of this.children) {
      if (child.isPlayer) {
        return true;
      }
    }

    return false;
  }

  getSubtitles() {
    return this.trackedSubtitles;
  }

  getSources() {
    return this.trackedSources;
  }


  resetSelfAndChildren() {
    let count = this.isPlayer ? 1 : 0;
    this.reset();
    this.children.forEach((child) => {
      count += child.resetSelfAndChildren();
      child.parent = null;
      this.tab.removeFrame(child.frameId);
    });
    this.children.clear();
    return count;
  }
}

export class TabHolder {
  constructor(tracker, tabId) {
    this.tracker = tracker;
    this.tabId = tabId;
    this.frames = new Map();

    this.isOn = false;
    this.isMpv = false;
    // MPV started by its shortcut: only a video the user starts goes to mpv
    // (background.mjs's onUserPlay), not the first stream the page loads.
    this.mpvOnPlay = false;
    this.mpvAutoOpened = false;
    this.mpvSentUrls = new Set();
    this.url = '';
    // Popup/popunder guard: set by content.js when focus moves into one of
    // this tab's player iframes (the click that ad sites hook via a
    // top-window 'blur' listener to fire a popup/popunder). Not touched by
    // reset() - it's a short-lived timestamp that's harmless to carry across
    // a same-tab navigation and naturally goes stale on its own.
    this.popupGuardArmedUntil = 0;

    this.reset();
  }
  reset() {
    this.frames.clear();
    this.playerCount = 0;
    this.continuationOptions = null;
    this.analyzerData = null;
    // regexMatched/mpvMatched are deliberately NOT cleared here: the
    // leave-a-site detection in the onUpdated handler relies on them
    // surviving hostname changes (upstream semantics for regexMatched).
    this.mpvAutoOpened = false;
    this.mpvSentUrls.clear();
    // A user's play whose stream has not been detected yet, and the last
    // stream a play sent, which keeps a player that calls play() twice from
    // opening a second window.
    this.mpvPlayPendingUntil = 0;
    this.mpvLastPlaySend = null;
  }
  getFrames() {
    return this.frames.values();
  }
  getFrame(frameId) {
    return this.frames.get(frameId);
  }
  getFrameOrCreate(frameId) {
    return this.getFrame(frameId) || this.createFrame(frameId);
  }
  createFrame(frameId) {
    const newFrame = new FrameHolder(this, frameId);
    this.frames.set(frameId, newFrame);
    return newFrame;
  }
  removeFrame(frameId) {
    this.frames.delete(frameId);
  }

  /**
   * Whether a player that says it loaded (PLAYER_LOADED) was opened by a page that is gone.
   * content.js names its page in the player's URL (opener): the page is in the player's
   * own frame when it went to the player, or in the frame above when it put the player in
   * an iframe. A reload or a navigation replaces it, and the new page's content script
   * gives its own name (FRAME_ADDED). A player still starting when its page reloaded can
   * say it loaded after that, and its beforeunload, added once it has loaded, never ran.
   * Taken for a player of the new page, it made the background drop that page's streams
   * (FrameHolder.hasPlayer) and open no player there until the page navigated again.
   * @param {FrameHolder} playerFrame - The player's frame.
   * @param {number|undefined} parentFrameId - The frame above it, as the player tells it.
   * @param {?string} opener - The page the player's URL names; null for a player no
   *   content script opened (a page embedding it itself, the player page in a tab).
   * @return {boolean} True when that page is known to be gone. A frame whose page this
   *   background never heard name itself (it started again since) proves nothing.
   */
  isPlayerOfGoneDocument(playerFrame, parentFrameId, opener) {
    if (!opener) {
      return false;
    }
    const pages = [playerFrame, this.getFrame(parentFrameId)].filter((frame) => frame && frame.documentKey);
    return pages.length > 0 && !pages.some((frame) => frame.documentKey === opener);
  }

  /**
   * Forgets a frame the page removed, with every frame inside it (FRAME_REMOVED).
   * Whatever waits for one of them to load (WAIT_UNTIL_MAIN_LOADED) is answered with
   * null, as it never will. A frame this background never knew - Firefox unloaded it
   * while the page kept its frames - is nothing to forget; it used to throw here.
   * @param {FrameHolder|undefined} frame - The removed frame.
   */
  forgetFrame(frame) {
    if (!frame) {
      return;
    }
    const gone = [];
    const collect = (f) => {
      gone.push(f);
      f.children.forEach(collect);
    };
    collect(frame);

    this.playerCount = Math.max(0, (this.playerCount || 0) - frame.resetSelfAndChildren());
    if (frame.parent) {
      frame.parent.removeChildFrame(frame);
    }
    for (const f of gone) {
      f.loadedCallbacks.forEach((callback) => {
        try {
          callback(null);
        } catch (e) {
          console.error(e);
        }
      });
      f.loadedCallbacks.clear();
    }
    this.removeFrame(frame.frameId);
  }

  getMainPlayer() {
    if (!BackgroundUtils.isUrlPlayerUrl(this.url)) {
      return null;
    }

    const mainFrame = this.getFrame(0);
    if (!mainFrame) {
      return null;
    }

    return mainFrame.isPlayer ? mainFrame : null;
  }
}

// Prefix of the storage.session key each tab's toggle state is kept under.
const TabStateKeyPrefix = 'tabState:';

// Firefox runs the background as an event page and unloads it after ~30 idle
// seconds, which takes every TabHolder with it. What the user chose with the
// toolbar button is kept in storage.session (cleared when the browser closes,
// the same lifetime tab ids have) so a woken background still knows it.
// mpvAutoOpened goes with it: without it the page's next stream request after a
// wake opens a second mpv window for a page already handed off. mpvOnPlay too,
// or a woken background forwards the page's first stream after all. The rest of a
// TabHolder - frames, detected sources - describes the current page and is
// rebuilt as that page makes requests.
const PersistedTabFields = ['url', 'isOn', 'isMpv', 'mpvOnPlay', 'regexMatched', 'mpvMatched', 'mpvAutoOpened'];

export class TabTracker {
  constructor() {
    this.tabs = new Map();
  }

  /**
   * Stores the tab's toggle state so it outlives the event page.
   * @param {TabHolder} tab
   * @return {Promise<void>}
   */
  async saveTabState(tab) {
    /** @type {Object<string, *>} */
    const state = {};
    for (const field of PersistedTabFields) {
      // @ts-ignore - TabHolder fields are assigned dynamically.
      state[field] = tab[field];
    }
    try {
      await chrome.storage.session.set({[TabStateKeyPrefix + tab.tabId]: state});
    } catch (e) {
      console.warn('Could not save tab state', e);
    }
  }

  /**
   * Puts back the toggle state saved before the event page was unloaded.
   * Applied onto any TabHolder that already exists, since the webRequest
   * listeners create them synchronously as soon as the page wakes.
   * @return {Promise<void>}
   */
  async restoreTabStates() {
    let stored;
    try {
      stored = await chrome.storage.session.get(null);
    } catch (e) {
      console.warn('Could not restore tab states', e);
      return;
    }
    for (const [key, state] of Object.entries(stored)) {
      if (!key.startsWith(TabStateKeyPrefix)) continue;
      const tab = this.getTabOrCreate(Number(key.substring(TabStateKeyPrefix.length)));
      for (const field of PersistedTabFields) {
        if (field in state) {
          // @ts-ignore - TabHolder fields are assigned dynamically.
          tab[field] = state[field];
        }
      }
    }
  }

  createTab(tabId) {
    const newTab = new TabHolder(this, tabId);
    this.tabs.set(tabId, newTab);
    return newTab;
  }

  getTab(tabId) {
    return this.tabs.get(tabId);
  }

  getTabOrCreate(tabId) {
    return this.getTab(tabId) || this.createTab(tabId);
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
    chrome.storage.session.remove(TabStateKeyPrefix + tabId).catch(() => {});
  }

  getFrame(tabId, frameId) {
    const tab = this.getTab(tabId);
    return tab && tab.getFrame(frameId);
  }

  getFrameOrCreate(tabId, frameId) {
    const tab = this.getTabOrCreate(tabId);
    return tab.getFrameOrCreate(frameId);
  }
}
