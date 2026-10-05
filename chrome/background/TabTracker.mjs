// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';
import {StreamLengths} from './StreamLengths.mjs';

// What a frame keeps of the streams and subtitle files its page asked for (addSource,
// addSubtitle). A page that is never left grew both lists without end: an HLS or DASH
// player's pieces (seg-14.mp4, seg-14.vtt) are detected one by one, thousands in an
// evening, each with its request's headers; every one went again to each player tab
// (sendSourcesToMainFramePlayers), and a player opened then read the length of each.
// - At most SameShapeLimit files of one shape (StreamLengths.shape): the first stays, so
//   the shape is still known as a stream's pieces (StreamLengths.lengthsOf), and the
//   oldest after it goes.
// - At most TrackedLimit in all: the oldest file goes first, a manifest only once no file
//   is left.
const SameShapeLimit = 20;
const TrackedLimit = 200;

/**
 * Brings a list of a frame's streams or subtitles, just added to, back to the limits above.
 * @param {Array<Object>} list - The list; its last entry is the new one.
 * @param {(entry: Object) => string} urlOf - An entry's URL.
 * @param {(entry: Object) => boolean} isFile - Whether an entry is a file (one piece of a
 *   stream, possibly), not a manifest.
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
    const file = list.findIndex(isFile);
    list.splice(file === -1 ? 0 : file, 1);
  }
}

/**
 * @param {Object} source - A detected source.
 * @return {boolean} Whether it is a file (MP4 or a direct one), not a manifest.
 */
function isFileSource(source) {
  return source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT;
}

export class FrameHolder {
  constructor(tab, frameId) {
    this.tab = tab;
    this.frameId = frameId;
    this.parent = null;
    this.children = new Set();
    // Set by reset(), as the rest of a frame's page state.
    /** @type {Array<Object>} */
    this.trackedSubtitles = [];
    /** @type {Array<Object>} */
    this.trackedSources = [];
    this.reset();
  }

  reset() {
    this.playerOpening = false;
    // Which openPlayer attempt playerOpening is for (content.js's PLAYER_OPEN_GONE names it).
    this.playerOpeningAttempt = 0;
    // The page here came back from Firefox's back-forward cache, with the streams it had
    // (TabHolder.restoreGoneDocument); it fetches nothing again.
    this.restoredFromCache = false;
    this.isPlayer = false;
    this.trackedSubtitles = [];
    this.trackedSources = [];
    this.url = '';
    /**
     * The name content.js gave the page it shows (FRAME_ADDED); null when unknown.
     * @type {?string}
     */
    this.documentKey = null;
    /**
     * What sendSources last handed a player in a frame inside this one (noteHandedToPlayer).
     * @type {?{frameId: number, subtitles: Array<Object>, sources: Array<Object>, video: ?Object}}
     */
    this.handedToPlayer = null;
  }

  /**
   * Keeps what a player in a frame inside this one was handed (sendSources), for that
   * player loading again in its frame ("Reload Frame" on it): sendSources takes what it
   * hands out of the frames, so the player asked again and got nothing.
   * @param {number} playerFrameId - The player's frame.
   * @param {{subtitles: Array<Object>, sources: Array<Object>, video: ?Object}} handed - What
   *   it was handed.
   */
  noteHandedToPlayer(playerFrameId, handed) {
    this.handedToPlayer = {frameId: playerFrameId, ...handed};
  }

  /**
   * What noteHandedToPlayer kept for a player's frame.
   * @param {number} playerFrameId - The player's frame.
   * @return {?{frameId: number, subtitles: Array<Object>, sources: Array<Object>, video: ?Object}}
   *   Null when the last player handed sources here was in another frame.
   */
  handedTo(playerFrameId) {
    return this.handedToPlayer && this.handedToPlayer.frameId === playerFrameId ? this.handedToPlayer : null;
  }

  /**
   * Forgets what noteHandedToPlayer kept: the sources browser's Clear, or the player
   * asking again got the cleared sources back from here.
   */
  forgetHandedToPlayer() {
    this.handedToPlayer = null;
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

  /**
   * Keeps a stream the page asked for, within the limits (trimTracked).
   * @param {{url: string, mode: string}} source - The source.
   */
  addSource(source) {
    this.trackedSources.push(source);
    trimTracked(this.trackedSources, (s) => s.url, isFileSource);
  }

  /**
   * Keeps a subtitle file the page asked for, within the limits (trimTracked).
   * @param {{source: string}} subtitle - The subtitle.
   */
  addSubtitle(subtitle) {
    this.trackedSubtitles.push(subtitle);
    trimTracked(this.trackedSubtitles, (s) => s.source, () => true);
  }

  /**
   * Whether the tab still tracks this frame under its id. A new page in the frame keeps it
   * (FRAME_ADDED resets it in place); a frame forgotten (FRAME_REMOVED), or dropped with its
   * page's streams by the reset on a new site (tabs.onUpdated), is no longer the frame of
   * that id: the next page there gets a new one.
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
      this.tab.removeFrame(child.frameId);
    });
    this.children.clear();
    return count;
  }
}

// How many gone pages a tab remembers (TabHolder.goneDocuments). Navigating a tab would
// otherwise grow it without end; the oldest go first.
const GoneDocumentLimit = 16;
// How many requests' headers a tab keeps while their responses are awaited
// (TabHolder.requestHeaders). Each goes when its response or its error comes; this only
// bounds those that never get either.
const RequestHeaderLimit = 500;

/**
 * @param {string} a - A URL, or anything else.
 * @param {string} b - Another.
 * @return {boolean} Whether both are URLs of one hostname.
 */
function sameHostname(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch (e) {
    return false;
  }
}

export class TabHolder {
  constructor(tracker, tabId) {
    this.tracker = tracker;
    this.tabId = tabId;
    this.frames = new Map();
    // The frames of FastStream's players in the tab that play (PLAYER_PLAYING): while any
    // does, the page's own media is held paused (background.mjs sendPageMediaHold).
    this.playingPlayers = new Set();
    // Pages that left the tab, by the name each gave itself (FRAME_ADDED's document),
    // with what each had detected: for a page Firefox's back-forward cache gives back
    // (restoreGoneDocument), and to refuse a player still starting that names one
    // (isPlayerOfGoneDocument). Not cleared by reset(), see there.
    this.goneDocuments = new Map();
    // The headers of the tab's requests still waiting for a response, by request id
    // (rememberRequestHeaders). The tab's, not a frame's, and not cleared by reset(): a
    // request can be sent before the page that made it named itself (a preload, 103
    // Early Hints) or before the reset on a new site, and answered after, and a stream
    // found without the Referer its CDN checks got a 403 in the player.
    /** @type {Map<string, *>} */
    this.requestHeaders = new Map();

    this.isOn = false;
    this.isMpv = false;
    // MPV started by its shortcut: only a video the user starts goes to mpv
    // (background.mjs's onUserPlay), not the first stream the page loads.
    this.mpvOnPlay = false;
    this.mpvAutoOpened = false;
    this.mpvSentUrls = new Set();
    // Why the last hand-off to mpv failed, while MPV mode shows it on the toolbar button
    // ("!" and the reason in the tooltip); null after one that worked or a new page.
    /** @type {?string} */
    this.mpvError = null;
    // Whether the mpv host's last answer in this tab came from an outdated host
    // (MpvBackend's RequiredHostVersion): the button then shows "!" after a hand-off that
    // worked too, and its tooltip says to install the host again.
    /** @type {boolean} */
    this.mpvHostOutdated = false;
    // Which video decoder the mpv this tab handed its stream to uses (MpvBackend's
    // MpvDecoder), for the toolbar button's tooltip; null until mpv has said.
    /** @type {?Object} */
    this.mpvDecoder = null;
    // The latest decoder question in flight: an older answer is dropped.
    /** @type {?Object} */
    this.mpvDecoderQuery = null;
    // Counts the pages the tab showed (background.mjs, tabs.onUpdated): the host answers a
    // hand-off seconds later, and an answer for a page the tab has left applies nothing.
    /** @type {number} */
    this.mpvPage = 0;
    // The user turned the tab off, or MPV off, on the site it shows (background.mjs
    // userTurnedOff): the MPV Allowlist does not start MPV there again by itself, also
    // after a page of the site it does not list. Another site, or the user turning MPV on,
    // ends it. Not cleared by reset(), which the Off's own reload runs.
    /** @type {boolean} */
    this.mpvTurnedOff = false;
    this.url = '';
    // Popup/popunder guard: set by content.js when focus moves into one of
    // this tab's player iframes (the click that ad sites hook via a
    // top-window 'blur' listener to fire a popup/popunder). Not touched by
    // reset() - it's a short-lived timestamp that's harmless to carry across
    // a same-tab navigation and naturally goes stale on its own.
    this.popupGuardArmedUntil = 0;
    // A start by address waiting for the new page to name itself (background.mjs
    // startWithTrackedLater); the next address change cancels it.
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.urlStartTimer = undefined;

    this.reset();
  }
  reset() {
    // goneDocuments stays: the reset on a new hostname (tabs.onUpdated) can come after the
    // new page named itself, and a player the tab was sent to (a moz-extension:// URL, so
    // a new hostname) still names the page it replaced. The names this reset drops can be
    // live ones. The reset before a reload knows better (resetForReload).
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
    // What that play plays (content.js's playedVideo): a stream plainly another length is
    // not its stream.
    this.mpvPlayedVideo = null;
    // While a stream is checked for such a play, the streams detected meanwhile, to be
    // checked next (background.mjs sendPendingPlay); null otherwise.
    /** @type {?Array<Object>} */
    this.mpvPlayChecking = null;
  }

  /**
   * The reset before the tab is reloaded (startMpv, stopMpv, the toolbar's Off): every
   * page in it is about to go, so their names are marked gone first. A player still
   * starting in an iframe names its page, and once the reload made its frame and the
   * frame above new ones, with no names on them, only the mark tells that page is gone.
   */
  resetForReload() {
    for (const frame of this.frames.values()) {
      if (!frame.parent) {
        this.markDocumentGone(frame);
      }
    }
    this.reset();
  }

  /**
   * The reset for a tab gone to another site (tabs.onUpdated, a new hostname). It races
   * the new page's own FRAME_ADDED: a page Firefox's back-forward cache gives back names
   * itself again and gets its streams back (restoreGoneDocument), and a new page names
   * itself as its content script starts. Coming after, reset() wiped that page's frame,
   * and nothing gave it back. A frame 0 that already shows the new site - a page named in
   * it, at a URL of the new hostname - is that page: it is kept, with the frames under it.
   * Only a page naming itself moves a frame's URL to another host (FRAME_ADDED). The
   * player page the tab can be sent to runs no content script, so there frame 0 still
   * shows the page it replaced, and is dropped as before.
   * @param {string} url - The URL the tab went to.
   */
  resetForNewSite(url) {
    const kept = [];
    const zero = this.frames.get(0);
    if (zero && zero.documentKey && sameHostname(zero.url, url)) {
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
   * Keeps a request's headers until its response or its error comes (forgetRequestHeaders).
   * @param {string} requestId - webRequest's id, unique in the session.
   * @param {*} headers - Its requestHeaders.
   */
  rememberRequestHeaders(requestId, headers) {
    this.requestHeaders.delete(requestId);
    this.requestHeaders.set(requestId, headers);
    while (this.requestHeaders.size > RequestHeaderLimit) {
      this.requestHeaders.delete(this.requestHeaders.keys().next().value);
    }
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
   * A player in an iframe of an iframe can come too late for either frame to tell: the
   * reload made both new, with no names. The page's name, marked gone, still does.
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
    if (this.goneDocuments.has(opener)) {
      return true;
    }
    const pages = [playerFrame, this.getFrame(parentFrameId)].filter((frame) => frame && frame.documentKey);
    return pages.length > 0 && !pages.some((frame) => frame.documentKey === opener);
  }

  /**
   * Whether a player may be taken for a child of the frame it names (PLAYER_LOADED's
   * parentFrameId, from the player's own URL). The player page is web-accessible, so any
   * page can frame it with any parent_frame_id: one naming the top frame made the top
   * frame count as holding a player (FrameHolder.hasPlayer), and the background dropped
   * every stream of the page and opened no player there until it navigated. content.js
   * names its page in each player's URL (opener), a name only its content script knows,
   * so that name must be the named frame's page, or the player frame's own (a page that
   * went to the player).
   * @param {FrameHolder} playerFrame - The player's frame.
   * @param {*} parentFrameId - The frame it names.
   * @param {?string} opener - The page its URL names.
   * @return {'proven'|'refused'|'ask'} 'ask' when the named frame's page never named
   *   itself to this background (it started again since): its content script can tell.
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

  /**
   * Marks the page a frame shows gone, with the pages in the frames inside it, and keeps
   * what each had detected under its name. A frame whose page never named itself has
   * nothing to keep.
   * @param {FrameHolder} frame - The frame whose page goes.
   */
  markDocumentGone(frame) {
    const mark = (f) => {
      if (f.documentKey) {
        // Deleted first: a Map keeps a key it already has at its old place, and the
        // limit below drops the oldest, not the one just marked.
        this.goneDocuments.delete(f.documentKey);
        this.goneDocuments.set(f.documentKey, {
          sources: f.getSources().slice(),
          subtitles: f.getSubtitles().slice(),
        });
      }
      f.children.forEach(mark);
    };
    mark(frame);
    while (this.goneDocuments.size > GoneDocumentLimit) {
      this.goneDocuments.delete(this.goneDocuments.keys().next().value);
    }
  }

  /**
   * A page names itself in a frame (FRAME_ADDED): the page the frame showed before, and
   * the pages inside it, are gone. Their FRAME_REMOVED can come after this message, or
   * not at all. The same name again is the same page (Firefox's back-forward cache gives
   * a page back with its content script, which names it again), and ends nothing.
   * @param {FrameHolder} frame - The frame the page named itself in.
   * @param {?string} documentKey - The page's name; null when it gave none.
   */
  noteDocumentReplaced(frame, documentKey) {
    if (frame.documentKey && frame.documentKey !== documentKey) {
      this.markDocumentGone(frame);
    }
  }

  /**
   * Gives a page that named itself again (FRAME_ADDED) what it had detected before it
   * left. Firefox's back-forward cache gives a page back with its content script alive:
   * its leaving made the background forget its frame (FRAME_REMOVED), and the page
   * fetches nothing again, so the toolbar's next On found no stream on it. The name is
   * the page's own, random per page, so it is the same page, wherever its URL went
   * since. A page that came back is no longer gone.
   * @param {FrameHolder} frame - The frame, its documentKey already set.
   */
  restoreGoneDocument(frame) {
    const kept = frame.documentKey && this.goneDocuments.get(frame.documentKey);
    if (!kept) {
      return;
    }
    this.goneDocuments.delete(frame.documentKey);
    frame.restoredFromCache = true;
    // FrameHolder.reset() sets both lists, which the checker cannot see from here.
    const sources = /** @type {Array<Object>} */ (frame.getSources());
    for (const source of kept.sources) {
      // FRAME_ADDED keeps a source the frame already had at the page's URL.
      if (!sources.some((s) => s.url === source.url)) {
        sources.push(source);
      }
    }
    const subtitles = /** @type {Array<Object>} */ (frame.getSubtitles());
    for (const subtitle of kept.subtitles) {
      if (!subtitles.includes(subtitle)) {
        subtitles.push(subtitle);
      }
    }
  }

  /**
   * A page says it left its frame (FRAME_REMOVED): forgets the frame, and marks the page
   * gone. The message can come after the next page in that frame named itself (the two
   * race across a navigation); a known name that is not the frame's is that late one,
   * and must not forget the new page's frame and streams. A message without a name (the
   * player page's own, content.js's for a player iframe it removed), or a frame whose
   * page never named itself, is taken as before.
   * @param {FrameHolder|undefined} frame - The frame the message names.
   * @param {*} documentKey - The name of the page that sent it, if any.
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

  /**
   * Forgets a frame the page removed, with every frame inside it (FRAME_REMOVED).
   * A frame this background never knew - Firefox unloaded it while the page kept its
   * frames - is nothing to forget; it used to throw here.
   * @param {FrameHolder|undefined} frame - The removed frame.
   */
  forgetFrame(frame) {
    if (!frame) {
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

// Prefix of the storage.session key each tab's toggle state is kept under.
const TabStateKeyPrefix = 'tabState:';

// Firefox runs the background as an event page and unloads it after ~30 idle
// seconds, which takes every TabHolder with it. What the user chose with the
// toolbar button is kept in storage.session (cleared when the browser closes,
// the same lifetime tab ids have) so a woken background still knows it.
// mpvAutoOpened goes with it: without it the page's next stream request after a
// wake opens a second mpv window for a page already handed off. mpvOnPlay too,
// or a woken background forwards the page's first stream after all. mpvError and
// mpvHostOutdated, or the toolbar's "!" for a failed hand-off or an outdated host went at
// the wake; mpvDecoder, or its tooltip forgot which decoder mpv uses. And a play still waiting for its
// stream (mpvPlayPendingUntil, mpvPlayedVideo) and the last one sent (mpvLastPlaySend,
// which keeps a player's second play() from opening a second window). mpvTurnedOff, or the
// MPV Allowlist started MPV again on the site the user had turned it off on. The rest of a
// TabHolder - frames, detected sources - describes the current page and is
// rebuilt as that page makes requests.
const PersistedTabFields = ['url', 'isOn', 'isMpv', 'mpvOnPlay', 'regexMatched', 'mpvMatched', 'mpvAutoOpened',
  'mpvError', 'mpvHostOutdated', 'mpvDecoder', 'mpvPlayPendingUntil', 'mpvPlayedVideo', 'mpvLastPlaySend',
  'mpvTurnedOff'];

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
    // A tab closed meanwhile (an await, a timer of its own): its state was written back after
    // removeTab had deleted it, and stayed in session storage for good.
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

  /**
   * Forgets a request's headers once its response or its error came. A tab this tracker
   * does not know (closed, its requests cancelled after tabs.onRemoved) is not made again
   * for it: Firefox never reuses a tab id, so it would stay for the background's life.
   * @param {number} tabId - The request's tab.
   * @param {string} requestId - Its id.
   */
  forgetRequestHeaders(tabId, requestId) {
    this.getTab(tabId)?.requestHeaders.delete(requestId);
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
