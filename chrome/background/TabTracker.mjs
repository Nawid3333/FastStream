// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';
import {StreamLengths} from './StreamLengths.mjs';

// At most SameShapeLimit files of one shape (the first stays), and TrackedLimit in all: files go before manifests.
const SameShapeLimit = 20;
const TrackedLimit = 200;

/**
 * @template T
 * @param {Array<T>} list
 * @param {(entry: T) => string} urlOf
 * @param {(entry: T) => boolean} isFile
 */
function trimTracked(list, urlOf, isFile) {
  const added = list[list.length - 1];
  if (added && isFile(added)) {
    const shape = StreamLengths.shape(urlOf(added));
    const same = list.filter((entry) => isFile(entry) && StreamLengths.shape(urlOf(entry)) === shape);
    if (same.length > SameShapeLimit) {
      list.splice(list.indexOf(same[1]), 1);
    }
  }
  while (list.length > TrackedLimit) {
    // Never the one just added: in a list of manifests only, a new file went at once.
    const file = list.findIndex((entry) => entry !== added && isFile(entry));
    list.splice(file === -1 ? 0 : file, 1);
  }
}

/**
 * @param {TrackedSource} source
 * @return {boolean}
 */
function isFileSource(source) {
  return source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT;
}

/** @typedef {{url: string, mode: string, headers: *, time: number, requestedUrl?: string, typed?: boolean}} TrackedSource */

/**
 * @typedef {{source: string, label: string, headers: *, time: number}|
 *   {source: string, label: string, data: string, language: string}} TrackedSubtitle
 */

export class FrameHolder {
  /**
   * @param {TabHolder} tab
   * @param {number} frameId
   */
  constructor(tab, frameId) {
    this.tab = tab;
    this.frameId = frameId;
    this.parent = null;
    this.children = new Set();
    /** @type {Array<TrackedSubtitle>} */
    this.trackedSubtitles = [];
    /** @type {Array<TrackedSource>} */
    this.trackedSources = [];
    this.reset();
  }

  reset() {
    this.playerOpening = false;
    // Which openPlayer attempt playerOpening is for (content.js's PLAYER_OPEN_GONE names it).
    this.playerOpeningAttempt = 0;
    /** @type {number} */
    this.openMissed = 0;
    /** @type {number} */
    this.openTriedAt = 0;
    // Only a play the user starts opens it again, not the page's own requests.
    /** @type {boolean} */
    this.openGone = false;
    // Came back from Firefox's back-forward cache with its streams: it fetches nothing again.
    this.restoredFromCache = false;
    this.isPlayer = false;
    this.trackedSubtitles = [];
    this.trackedSources = [];
    /** @type {string} */
    this.url = '';
    /** @type {?string} */
    this.documentKey = null;
    /** @type {?{frameId: number, subtitles: Array<Object>, sources: Array<Object>, video: ?Object}} */
    this.handedToPlayer = null;
  }

  /**
   * For that player loading again in its frame: sendSources takes what it hands out of the frames.
   * @param {number} playerFrameId
   * @param {{subtitles: Array<Object>, sources: Array<Object>, video: ?Object}} handed
   */
  noteHandedToPlayer(playerFrameId, handed) {
    this.handedToPlayer = {frameId: playerFrameId, ...handed};
  }

  /**
   * @param {number} playerFrameId
   * @return {?{frameId: number, subtitles: Array<Object>, sources: Array<Object>, video: ?Object}}
   */
  handedTo(playerFrameId) {
    return this.handedToPlayer && this.handedToPlayer.frameId === playerFrameId ? this.handedToPlayer : null;
  }

  forgetHandedToPlayer() {
    this.handedToPlayer = null;
  }

  /** @param {FrameHolder} childFrame */
  removeChildFrame(childFrame) {
    this.children.delete(childFrame);
    childFrame.parent = null;
  }

  /** @param {FrameHolder} parentFrame */
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

  /** @param {TrackedSource} source */
  addSource(source) {
    this.trackedSources.push(source);
    trimTracked(this.trackedSources, (s) => s.url, isFileSource);
  }

  /** @param {{source: string, headers: *, label: string, time: number}} subtitle */
  addSubtitle(subtitle) {
    this.trackedSubtitles.push(subtitle);
    trimTracked(this.trackedSubtitles, (s) => s.source, () => true);
  }

  /**
   * A frame forgotten, or dropped by the reset on a new site, is no longer the frame of that id.
   * @return {boolean}
   */
  isTracked() {
    return this.tab.getFrame(this.frameId) === this;
  }

  resetSelfAndChildren() {
    let count = this.isPlayer ? 1 : 0;
    this.reset();
    this.children.forEach((child) => {
      count += child.resetSelfAndChildren();
      child.parent = null;
      if (child.isTracked()) this.tab.removeFrame(child.frameId);
    });
    this.children.clear();
    return count;
  }
}

const GoneDocumentLimit = 16;
// Each goes with its response or error; this bounds those that never get either.
const RequestHeaderLimit = 500;
const RedirectOriginLimit = 200;

/**
 * @param {string} a
 * @param {string} b
 * @return {boolean}
 */
function sameHostname(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch (e) {
    return false;
  }
}

export class TabHolder {
  /**
   * @param {TabTracker} tracker
   * @param {number} tabId
   */
  constructor(tracker, tabId) {
    this.tracker = tracker;
    this.tabId = tabId;
    this.frames = new Map();
    // While any plays, the page's own media is held paused.
    this.playingPlayers = new Set();
    // Pages that left the tab, by name, with what each detected (Back's cache, isPlayerOfGoneDocument); not cleared by reset().
    this.goneDocuments = new Map();
    // The tab's, not cleared by reset(): a request (a preload, 103 Early Hints) can be sent before its page named itself.
    /** @type {Map<string|number, *>} */
    this.requestHeaders = new Map();
    // A page's player lists a file by its first address; the stream is detected at the redirect's end.
    /** @type {Map<string|number, string>} */
    this.redirectOrigins = new Map();
    // The entries themselves, not a time: a stream recovered later keeps the page's request time.
    /** @type {WeakSet<object>} */
    this.clearedSources = new WeakSet();

    this.isOn = false;
    this.isMpv = false;
    /** @type {ReturnType<typeof setInterval>|undefined} */
    this.pagePlayerStarter = undefined;
    /** @type {?Object} */
    this.pagePlayerContinuation = null;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.continuationTimer = undefined;
    // Until when the next page's stream goes to mpv by itself, after MPV autoplay's next episode.
    this.mpvNextEpisodeUntil = 0;
    /** @type {?Object} */
    this.mpvNextPick = null;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.mpvNextPickTimer = undefined;
    // The mpv window MPV autoplay went on from, which gets that next episode (the helper's id, '' for its own pipe's).
    this.mpvEpisodeWindow = '';
    // The mpv window the tab's last stream went to, while FastStream follows it. Not persisted: neither are the
    // windows followed (MpvMode.mjs, mpvWindows).
    /** @type {?string} */
    this.mpvWindow = null;
    // A tab MPV autoplay opened for the next episode: it closes again once its stream went to mpv.
    this.mpvReopened = false;
    /** @type {chrome.windows.Window['state']|null} */
    this.windowStateBefore = null;
    /** @type {?number} */
    this.carriedFullscreenFrameId = null;
    // Went on to the next episode carrying it, and no player there took it yet.
    this.carryAwaited = false;
    // MPV by its shortcut: only a video the user starts goes to mpv.
    this.mpvOnPlay = false;
    this.mpvAutoOpened = false;
    this.mpvSentUrls = new Set();
    this.mpvSending = new Map();
    /** @type {?string} */
    this.mpvError = null;
    // The last send was refused for an outdated helper: the tooltip says what to run.
    /** @type {boolean} */
    this.mpvHostOutdated = false;
    /** @type {boolean} */
    this.protectedVideo = false;
    /** @type {?import('./MpvBackend.mjs').MpvDecoder} */
    this.mpvDecoder = null;
    // The host answers seconds later: an answer for a page the tab has left applies nothing.
    /** @type {number} */
    this.mpvPage = 0;
    // The page whose MPV went over to the in-page player (playHereInstead): there On counts as MPV. -1 for none.
    /** @type {number} */
    this.mpvStandInPage = -1;
    // The MPV Allowlist does not start MPV here again by itself; not cleared by reset(), which the Off's own reload runs.
    /** @type {boolean} */
    this.mpvTurnedOff = false;
    this.url = '';
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.urlStartTimer = undefined;

    this.reset();
  }
  reset() {
    // goneDocuments stays: the reset on a new hostname can come after the new page named itself.
    this.frames.clear();
    /** @type {number} */
    this.playerCount = 0;
    // A new page's frame can come back with one of their ids.
    this.playingPlayers.clear();
    // Kept with the tab's state: Firefox unloads the idle event page while an episode plays.
    /** @type {Object<string, number>} */
    this.playerPageFrames = {};
    /** @type {?import('./background.mjs').Continuation} */
    this.continuationOptions = null;
    this.continuationArrived = false;
    /** @type {?string} */
    this.continuationPage = null;
    // regexMatched/mpvMatched stay: leaving a site is told by them across hostname changes.
    this.mpvAutoOpened = false;
    this.mpvSentUrls.clear();
    // The toolbar's Off too: its next On looks at the page's video again (hasVideoSource).
    this.protectedVideo = false;
    // The last stream a play sent keeps a player calling play() twice from opening a second window.
    /** @type {number} */
    this.mpvPlayPendingUntil = 0;
    // also: the files the page's menu switched to for it (PageMenuQuality.mjs).
    /** @type {?{url: string, time: number, also?: string[]}} */
    this.mpvLastPlaySend = null;
    // A stream plainly another length is not its stream.
    /** @type {?import('./background.mjs').PlayedVideo} */
    this.mpvPlayedVideo = null;
    /** @type {?Array<Object>} */
    this.mpvPlayChecking = null;
    /** @type {?string} */
    this.playerNotice = null;
  }

  /** Every page in the tab is about to go: their names are marked gone first. */
  resetForReload() {
    for (const frame of this.frames.values()) {
      if (!frame.parent) {
        this.markDocumentGone(frame);
      }
    }
    this.reset();
  }

  /**
   * Races the new page's FRAME_ADDED: a frame 0 already named at the new hostname is kept, with the frames under it.
   * @param {string} url
   */
  resetForNewSite(url) {
    /** @type {Array<FrameHolder>} */
    const kept = [];
    const zero = this.frames.get(0);
    if (zero && zero.documentKey && sameHostname(zero.url, url)) {
      /** @param {FrameHolder} frame */
      const collect = (frame) => {
        kept.push(frame);
        frame.children.forEach(collect);
      };
      collect(zero);
    }
    this.reset();
    let players = 0;
    for (const frame of kept) {
      this.frames.set(frame.frameId, frame);
      if (frame.isPlayer) {
        players++;
      }
    }
    this.playerCount = players;
  }

  /**
   * @param {string} requestId
   * @param {*} headers
   */
  rememberRequestHeaders(requestId, headers) {
    this.requestHeaders.delete(requestId);
    this.requestHeaders.set(requestId, headers);
    while (this.requestHeaders.size > RequestHeaderLimit) {
      this.requestHeaders.delete(/** @type {string|number} */ (this.requestHeaders.keys().next().value));
    }
  }

  /**
   * webRequest keeps the request id across redirects.
   * @param {string} requestId
   * @param {string} url
   */
  noteRedirect(requestId, url) {
    if (this.redirectOrigins.has(requestId)) return;
    this.redirectOrigins.set(requestId, url);
    while (this.redirectOrigins.size > RedirectOriginLimit) {
      this.redirectOrigins.delete(/** @type {string|number} */ (this.redirectOrigins.keys().next().value));
    }
  }

  /**
   * @param {string|number} requestId
   * @return {?string}
   */
  redirectOrigin(requestId) {
    return this.redirectOrigins.get(requestId) || null;
  }

  getFrames() {
    return this.frames.values();
  }
  /** @param {number|undefined} frameId */
  getFrame(frameId) {
    return this.frames.get(frameId);
  }
  /** @param {number} frameId */
  getFrameOrCreate(frameId) {
    return this.getFrame(frameId) || this.createFrame(frameId);
  }
  /** @param {number} frameId */
  createFrame(frameId) {
    const newFrame = new FrameHolder(this, frameId);
    this.frames.set(frameId, newFrame);
    return newFrame;
  }
  /** @param {number} frameId */
  removeFrame(frameId) {
    this.frames.delete(frameId);
  }

  /**
   * A player still starting when its page reloaded can say it loaded after that; taken for the new page's, it dropped that page's streams.
   * @param {FrameHolder} playerFrame
   * @param {number|undefined} parentFrameId
   * @param {?string} opener
   * @return {boolean}
   */
  isPlayerOfGoneDocument(playerFrame, parentFrameId, opener) {
    if (!opener) {
      return false;
    }
    if (this.goneDocuments.has(opener)) {
      return true;
    }
    const pages = [playerFrame, this.getFrame(parentFrameId)].filter((frame) => frame && frame.documentKey);
    return pages.length > 0 && !pages.some((frame) => frame.documentKey === opener);
  }

  /**
   * Any page can frame the player with any parent_frame_id: the opener must be the named frame's page or the player frame's own.
   * @param {FrameHolder} playerFrame
   * @param {*} parentFrameId
   * @param {?string} opener
   * @return {'proven'|'refused'|'ask'}
   */
  playerParentProof(playerFrame, parentFrameId, opener) {
    if (!opener || !Number.isInteger(parentFrameId) || parentFrameId < 0) {
      return 'refused';
    }
    const parent = this.getFrame(parentFrameId);
    if ([playerFrame, parent].some((frame) => frame && frame.documentKey === opener)) {
      return 'proven';
    }
    return parent && parent.documentKey ? 'refused' : 'ask';
  }

  /** @param {FrameHolder} frame */
  markDocumentGone(frame) {
    /** @param {FrameHolder} f */
    const mark = (f) => {
      // Inner pages first, so a page is newer than its frames' pages.
      f.children.forEach(mark);
      if (f.documentKey) {
        // Deleted first: a Map keeps an existing key at its old place.
        this.goneDocuments.delete(f.documentKey);
        this.goneDocuments.set(f.documentKey, {
          sources: f.getSources().slice(),
          subtitles: f.getSubtitles().slice(),
        });
      }
    };
    mark(frame);
    while (this.goneDocuments.size > GoneDocumentLimit) {
      // A page that detected nothing goes first: an ad's many frames pushed the page itself out.
      let drop = this.goneDocuments.keys().next().value;
      for (const [key, kept] of this.goneDocuments) {
        if (kept.sources.length === 0 && kept.subtitles.length === 0) {
          drop = key;
          break;
        }
      }
      this.goneDocuments.delete(drop);
    }
  }

  /**
   * Their FRAME_REMOVED can come after this, or never; the same name again is the same page (Back's cache).
   * @param {FrameHolder} frame
   * @param {?string} documentKey
   */
  noteDocumentReplaced(frame, documentKey) {
    if (frame.documentKey && frame.documentKey !== documentKey) {
      this.markDocumentGone(frame);
    }
  }

  /** @param {FrameHolder} frame */
  restoreGoneDocument(frame) {
    const kept = frame.documentKey && this.goneDocuments.get(frame.documentKey);
    if (!kept) {
      return;
    }
    this.goneDocuments.delete(frame.documentKey);
    frame.restoredFromCache = true;
    // FrameHolder.reset() sets both lists, which the checker cannot see from here.
    const sources = /** @type {Array<TrackedSource>} */ (frame.getSources());
    for (const source of kept.sources) {
      if (!sources.some((s) => s.url === source.url)) {
        sources.push(source);
      }
    }
    const subtitles = /** @type {Array<TrackedSubtitle>} */ (frame.getSubtitles());
    for (const subtitle of kept.subtitles) {
      if (!subtitles.includes(subtitle)) {
        subtitles.push(subtitle);
      }
    }
  }

  /**
   * Can come after the next page there named itself: a known name that is not the frame's is that late one.
   * @param {FrameHolder|undefined} frame
   * @param {*} documentKey
   */
  forgetRemovedFrame(frame, documentKey) {
    if (!frame) {
      return;
    }
    if (frame.documentKey && typeof documentKey === 'string' && frame.documentKey !== documentKey) {
      return;
    }
    this.markDocumentGone(frame);
    this.forgetFrame(frame);
  }

  /** @param {FrameHolder|undefined} frame */
  forgetFrame(frame) {
    // One already forgotten: its frame id may hold the frame's next document now.
    if (!frame || !frame.isTracked()) {
      return;
    }
    this.playerCount = Math.max(0, (this.playerCount || 0) - frame.resetSelfAndChildren());
    if (frame.parent) {
      frame.parent.removeChildFrame(frame);
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

const TabStateKeyPrefix = 'tabState:';

// Persisted in storage.session, as Firefox unloads the idle event page; why each: docs/notes/mpv.md.
const PersistedTabFields = ['url', 'isOn', 'isMpv', 'mpvOnPlay', 'regexMatched', 'mpvMatched', 'mpvAutoOpened',
  'mpvError', 'mpvHostOutdated', 'protectedVideo', 'mpvDecoder', 'mpvPlayPendingUntil', 'mpvPlayedVideo', 'mpvLastPlaySend',
  'mpvTurnedOff', 'windowStateBefore', 'carriedFullscreenFrameId', 'carryAwaited', 'playerPageFrames', 'playerNotice',
  'mpvPage', 'mpvStandInPage'];

export class TabTracker {
  constructor() {
    this.tabs = new Map();
  }

  /**
   * @param {TabHolder} tab
   * @return {Promise<void>}
   */
  async saveTabState(tab) {
    // A tab closed meanwhile: its state written back after removeTab stayed for good.
    if (this.tabs.get(tab.tabId) !== tab) {
      return;
    }
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
   * Applied onto TabHolders that exist already: the webRequest listeners create them as the page wakes.
   * @return {Promise<void>}
   */
  async restoreTabStates() {
    /** @type {Object<string, *>} */
    let stored;
    try {
      stored = await chrome.storage.session.get(null);
    } catch (e) {
      console.warn('Could not restore tab states', e);
      return;
    }
    // Only tabs still there: tabs.onRemoved may have run removeTab meanwhile.
    /** @type {Set<number|undefined>|null} */
    let live = null;
    try {
      live = new Set((await chrome.tabs.query({})).map((tab) => tab.id));
    } catch (e) {
      // Without the list, as before: every saved state.
    }
    for (const [key, state] of Object.entries(stored)) {
      if (!key.startsWith(TabStateKeyPrefix)) continue;
      const tabId = Number(key.substring(TabStateKeyPrefix.length));
      if (live && !live.has(tabId)) {
        chrome.storage.session.remove(key).catch(() => {});
        continue;
      }
      const tab = this.getTabOrCreate(tabId);
      // A player's message that woke the page may have noted its frame while this read.
      const noted = tab.playerPageFrames;
      for (const field of PersistedTabFields) {
        if (field in state) {
          // @ts-ignore - TabHolder fields are assigned dynamically.
          tab[field] = state[field];
        }
      }
      tab.playerPageFrames = {...tab.playerPageFrames, ...noted};
    }
  }

  /** @param {number} tabId */
  createTab(tabId) {
    const newTab = new TabHolder(this, tabId);
    this.tabs.set(tabId, newTab);
    return newTab;
  }

  /** @param {number|undefined} tabId */
  getTab(tabId) {
    return this.tabs.get(tabId);
  }

  /** @param {number} tabId */
  getTabOrCreate(tabId) {
    return this.getTab(tabId) || this.createTab(tabId);
  }

  /** @param {number} tabId */
  removeTab(tabId) {
    this.tabs.delete(tabId);
    chrome.storage.session.remove(TabStateKeyPrefix + tabId).catch(() => {});
  }

  /**
   * Firefox never reuses a tab id: a tab made again here would stay for the background's life.
   * @param {number} tabId
   * @param {string} requestId
   */
  forgetRequestHeaders(tabId, requestId) {
    this.getTab(tabId)?.requestHeaders.delete(requestId);
  }

  /**
   * @param {number} tabId
   * @param {number} frameId
   */
  getFrame(tabId, frameId) {
    const tab = this.getTab(tabId);
    return tab && tab.getFrame(frameId);
  }

  /**
   * @param {number} tabId
   * @param {number} frameId
   */
  getFrameOrCreate(tabId, frameId) {
    const tab = this.getTabOrCreate(tabId);
    return tab.getFrameOrCreate(frameId);
  }
}
