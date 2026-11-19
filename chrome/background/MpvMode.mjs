// @ts-check
// The listeners are registered by background.mjs: at its top level the event page wakes for them.
import {MessageTypes} from '../player/enums/MessageTypes.mjs';
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {ProblemKinds} from '../player/utils/ProblemLog.mjs';
import {SHORT_S} from '../player/utils/StreamPick.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';
import {Capabilities, MpvBackend} from './MpvBackend.mjs';
import {hlsPackage} from './MpvHlsPackage.mjs';
import {isMpvContentType} from './MpvTarget.mjs';
import {UrlMatchList} from './UrlMatchList.mjs';
import {youTubeVideo} from './YouTubeVideo.mjs';
import {AutoEnableList, CaptionScrapeWaitMs, HlsQualitiesWaitMs, Lengths, Logging, Options, PageSubtitles, SourceLengthWaitMs, Tabs, VpnMirror, askFrame, closeReopenedTab, ensureOptions, hlsPackageIo, hlsQualityChoice, isSentStream, isTabOpen, newestOfLongest, noteProblem, notifySeriesEnd, openPlayersWithSources, pageQualityChoice, pauseTabMedia, saveOption, scrapeCaptionsTags, startPagePlayers, tabHasPlayer, tabTitle, takeScrapedCaptions, userTurnedOff} from './background.mjs';

/** @typedef {import('./TabTracker.mjs').TabHolder} TabHolder */
/** @typedef {import('./TabTracker.mjs').TrackedSource} TrackedSource */
/** @typedef {import('./background.mjs').TabExtras} TabExtras */
/** @typedef {import('./background.mjs').Continuation} Continuation */
/** @typedef {import('./background.mjs').MpvHandOff} MpvHandOff */

export const MpvAllowlist = new UrlMatchList();

export const Mpv = new MpvBackend();

// A play whose stream is not detected yet takes the next one within MpvPlayPendingMs; the same video within MpvPlayRepeatMs is the player repeating itself.
export const MpvPlayPendingMs = 15000;

export const MpvPlayRepeatMs = 10000;

// A play-triggered fetch lands within a few hundred ms.
export const MpvPlayKnownAfterMs = 1000;

const PackingWantedCheckMs = 250;

/**
 * Movie is the fallback: an untagged site still gets `movie`, not mpv's folder-name guess.
 * @param {?string} [explicit]
 * @param {string} [url]
 * @return {string}
 */
export function resolveMpvContentType(explicit, url) {
  if (isMpvContentType(explicit)) {
    return explicit;
  }
  return MpvAllowlist.getContentType(url) || 'movie';
}

/**
 * An active in-page player comes down with a reload; isMpv is set first, so the re-detected source goes to mpv.
 * @param {TabHolder & TabExtras} tab
 * @param {boolean} [onPlay]
 * @return {Promise<void>}
 */
export async function startMpv(tab, onPlay = false) {
  tab.isOn = true;
  tab.isMpv = true;
  tab.mpvOnPlay = onPlay;
  // The user's own MPV, not a list's start: it stays for the tab.
  tab.regexMatched = false;
  tab.mpvTurnedOff = false;
  tab.mpvError = null;
  tab.mpvHostOutdated = false;
  tab.mpvDecoder = null;
  tab.mpvDecoderQuery = null;
  BackgroundUtils.updateTabIcon(tab);

  if (await tabHasPlayer(tab)) {
    tab.resetForReload();
    chrome.tabs.reload(tab.tabId, () => BackgroundUtils.checkMessageError('reload', true)); // closed meanwhile: no unhandled error
  } else if (onPlay || youTubeVideo(tab.url)) {
    // A fresh start: the same video may go to mpv again.
    tab.mpvSentUrls.clear();
    tab.mpvLastPlaySend = null;
    tab.mpvPlayPendingUntil = 0;
    tab.mpvPlayedVideo = null;
    tab.mpvPlayChecking = null;
    chrome.tabs.sendMessage(tab.tabId, {
      type: MessageTypes.MPV_REPORT_PLAYING,
      // A YouTube video page has one video, which the user asked for: also an autoplayed or paused one.
      any: !!youTubeVideo(tab.url),
    }, () => {
      // A blank tab, or a page without the content script, is normal here.
      BackgroundUtils.checkMessageError('mpv_report_playing');
    });
  } else {
    openMpvWithSources(tab);
  }
}

/**
 * @param {TabHolder} tab
 * @return {Promise<void>}
 */
export async function stopMpv(tab) {
  tab.isOn = false;
  tab.isMpv = false;
  tab.mpvOnPlay = false;
  userTurnedOff(tab);
  BackgroundUtils.updateTabIcon(tab);

  if (await tabHasPlayer(tab)) {
    tab.resetForReload();
    chrome.tabs.reload(tab.tabId, () => BackgroundUtils.checkMessageError('reload', true)); // closed meanwhile: no unhandled error
  }
}

/** MPV mode off is the switch for the whole mpv integration: a tab still in MPV went on handing streams to mpv. */
export function leaveMpvWhenOff() {
  if (Options.mpvMode) {
    return;
  }
  for (const tab of Tabs.tabs.values()) {
    if (!tab.isMpv) {
      continue;
    }
    tab.isMpv = false;
    tab.mpvOnPlay = false;
    tab.isOn = tab.isOn && !!tab.url && AutoEnableList.matches(tab.url);
    BackgroundUtils.updateTabIcon(tab, true);
    Tabs.saveTabState(tab);
  }
}

/**
 * MPV on or off for the tab on any site (armed on a blank tab); only a video the user starts goes to mpv.
 * @param {chrome.tabs.Tab} tabobj
 */
export async function onToggleMpv(tabobj) {
  await ensureOptions();

  if (!Options.mpvMode) {
    return;
  }

  const hasPerms = await BackgroundUtils.checkPermissions();
  if (!hasPerms) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('perms.html'),
    }).catch((e) => console.error('Opening the permissions page failed', e));
    return;
  }

  const tab = Tabs.getTabOrCreate(/** @type {number} */ (tabobj.id));
  if (tabobj.url) {
    tab.url = tabobj.url;
  }

  if (tab.url && BackgroundUtils.isUrlPlayerUrl(tab.url)) {
    return;
  }

  if (tab.isOn && tab.isMpv) {
    await stopMpv(tab);
  } else {
    await startMpv(tab, true);
  }

  Tabs.saveTabState(tab);
}

/**
 * Only a video the user starts there goes to mpv: most pop-ups are ads. Firefox names no opener for a pop-up window.
 * @param {TabHolder} openerTab
 * @param {number} tabId
 */
export function inheritMpv(openerTab, tabId) {
  // isMpv only with isOn: every switch to Off clears both.
  if (!Options.mpvMode || !openerTab.isMpv) {
    return;
  }
  const tab = Tabs.getTabOrCreate(tabId);
  tab.isOn = true;
  tab.isMpv = true;
  tab.mpvOnPlay = true;
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
}

/**
 * @param {TabHolder} tab
 * @param {Continuation} continuation
 * @param {'player'|'mpv'} mode
 */
export function watchNextEpisodeArrives(tab, continuation, mode) {
  const from = tab.url;
  setTimeout(() => {
    if (tab.continuationOptions !== continuation || !Tabs.tabs.has(tab.tabId) || tab.url === from) return;
    noteProblem(tab.tabId, {url: tab.url, kind: ProblemKinds.NO_STREAM, mode}).catch((e) => console.error(e));
  }, MpvNextEpisodeWaitMs);
}

/**
 * A frame that does not tell its <track> elements within CaptionScrapeWaitMs keeps those it had.
 * @param {TabHolder} tab
 * @return {Promise<Array<{label: string, srt: string}>>}
 */
export async function pageSubtitlesForMpv(tab) {
  const frames = [...tab.getFrames()];
  await Promise.all(frames.map(async (frame) => {
    let timer;
    const subs = await Promise.race([
      scrapeCaptionsTags(frame),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), CaptionScrapeWaitMs);
      }),
    ]);
    clearTimeout(timer);
    takeScrapedCaptions(frame, subs);
  }));
  return PageSubtitles.toSrt(frames.flatMap((frame) => frame.getSubtitles()));
}

/**
 * Not when the user turned MPV off since the stream went: the page they went back to plays on.
 * @param {TabHolder} tab
 * @param {{focus?: string, foreground?: string, reused?: boolean}} result
 */
export function pauseAfterHandOff(tab, result) {
  if (Logging) {
    console.log('[MPV] mpv window: reused', result.reused === true, 'focus', result.focus, 'foreground', result.foreground);
  }
  if (tab.isOn && tab.isMpv) {
    pauseTabMedia(tab.tabId);
  }
}

/**
 * A file only its page loads: the tab goes over to FastStream's own player, which loads it through the page and says why.
 * @param {TabHolder} tab
 * @param {MpvHandOff} result
 * @return {boolean}
 */
export function playHereInstead(tab, result) {
  if (!('pageOnly' in result) || !result.pageOnly) {
    return false;
  }
  if (!tab.isOn || !tab.isMpv) {
    return true;
  }
  if (Logging) console.log('[MPV] FastStream plays it instead, in tab', tab.tabId);
  tab.isMpv = false;
  tab.mpvOnPlay = false;
  tab.mpvError = null;
  tab.mpvPlayPendingUntil = 0;
  tab.mpvPlayedVideo = null;
  tab.mpvPlayChecking = null;
  // The MPV key's next play of the same video is no repeat to drop (sendPlayedToMpv).
  tab.mpvLastPlaySend = null;
  tab.mpvStandInPage = tab.mpvPage;
  tab.playerNotice = 'player_mpv_page_only';
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
  openPlayersWithSources(tab).catch((e) => console.error('Opening the player in place of mpv failed', e));
  return true;
}

/**
 * Once per page (tab.mpvAutoOpened); the toolbar's MPV and a start by address share the latch.
 * @param {TabHolder} tab
 * @param {string} url
 * @param {*} headers
 */
export function autoOpenInMpv(tab, url, headers) {
  // Reached after awaits (options, a stream's length): a tab closed meanwhile sends nothing.
  if (!isTabOpen(tab)) {
    return;
  }
  tab.mpvAutoOpened = true;
  Tabs.saveTabState(tab);
  const page = tab.mpvPage;
  const wanted = handOffStillWanted(tab);
  if (Logging) console.log('[MPV] forwarding detected stream to mpv:', url);
  tabTitle(tab.tabId).then((title) =>
    openInMpv(tab.tabId, url, tab, headers, resolveMpvContentType(null, tab.url), tab.url, title,
        {wanted})).then((result) => {
    if (Logging) console.log('[MPV] forward result:', url, JSON.stringify(result));
    if (!isHandOffPage(tab, page) || 'dropped' in result || playHereInstead(tab, result)) {
      return;
    }
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseAfterHandOff(tab, result);
    } else if (!('drm' in result)) {
      // The host never launched mpv: the next stream may try. Not after a copy-protected video's: its next would be a piece or an ad.
      tab.mpvAutoOpened = false;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    console.error('Handing the stream to mpv failed', e);
    if (isHandOffPage(tab, page)) {
      setMpvError(tab, {ok: false, error: String(e)});
    }
  });
}

/**
 * Picked once the lengths are read: a hoster's player may load an ad first. Only streams detected since the episode was asked for.
 * @param {TabHolder} tab
 */
export async function pickNextEpisodeForMpv(tab) {
  const pick = {};
  tab.mpvNextPick = pick;
  clearTimeout(tab.mpvNextPickTimer);
  // Only while the episode is still waited for: another tab's stream may have taken the mpv window.
  const open = () => tab.mpvNextEpisodeUntil > Date.now();
  if (!open()) {
    return;
  }
  const page = tab.mpvPage;
  const since = tab.mpvNextEpisodeUntil - MpvNextEpisodeWaitMs;
  const fresh = () => tabSources(tab).filter((source) => !(source.time < since));
  await Lengths.settle(fresh, SourceLengthWaitMs);
  if (tab.mpvNextPick !== pick || !open() || !isTabOpen(tab) || !isHandOffPage(tab, page) || tab.mpvAutoOpened ||
      !tab.isOn || !tab.isMpv || !Options.mpvMode) {
    return;
  }
  const source = newestOfLongest(fresh());
  if (!source) {
    return;
  }
  const length = Lengths.lengthOf(source.url);
  const left = tab.mpvNextEpisodeUntil - Date.now();
  if (typeof length === 'number' && length > 0 && length < SHORT_S && left > MpvNextPickGraceMs) {
    if (Logging) console.log('[MPV autoplay] a short stream, waiting for a longer one:', source.url, length);
    tab.mpvNextPickTimer = setTimeout(() => {
      if (tab.mpvNextPick === pick) pickNextEpisodeForMpv(tab);
    }, left - MpvNextPickGraceMs);
    return;
  }
  autoOpenInMpv(tab, source.url, source.headers);
}

/**
 * @param {TabHolder} tab
 * @return {Array<TrackedSource>}
 */
export function tabSources(tab) {
  const seen = new Set();
  /** @type {Array<TrackedSource>} */
  const sources = [];
  for (const frame of tab.getFrames()) {
    for (const source of frame.getSources()) {
      if (!seen.has(source.url)) {
        seen.add(source.url);
        sources.push(source);
      }
    }
  }
  return sources;
}

// MPV autoplay over the host's watch, which also keeps the event page loaded (docs/notes/mpv.md).
/**
 * @typedef {{tabId: number, next: ?string, previous: ?string, seriesEnd: boolean,
 *   cookieStoreId: ?string}} EpisodeLinksOfTab
 */
/**
 * @typedef {{tabId: number, url: string, qualities: ?Array<{url: string}>, local: ?string, alive: boolean, going: boolean,
 *   countdown: ?ReturnType<typeof setTimeout>, countdownAsks: number,
 *   stalled: ?ReturnType<typeof setTimeout>,
 *   links: ?EpisodeLinksOfTab, closedTab: ?{links: EpisodeLinksOfTab, windowId: number, windowClosing: boolean},
 *   site: string, watcher: ?{notify: Function, hide: Function, state: Function, stop: Function}}} MpvWatch
 */
/** @type {?MpvWatch} */
export let mpvWatch = null;

export const MpvNextEpisodeWaitMs = 60000;

export const MpvNextPickGraceMs = 5000;

// A notice that is a sentence to read; notify.lua's own default is 2 s.
export const MpvNoticeSeconds = 6;

/** @return {number} */
export function autoplayCountdownSeconds() {
  const seconds = Number(Options.autoplayCountdown);
  return Number.isFinite(seconds) ? Math.min(30, Math.max(0, Math.round(seconds))) : 5;
}

/** @param {MpvWatch} state */
export function cancelMpvCountdown(state) {
  // A countdown still asking the page (startMpvCountdown) does not start either.
  state.countdownAsks++;
  if (state.countdown) {
    clearTimeout(state.countdown);
    state.countdown = null;
    // Its notice would otherwise stay up for the whole countdown.
    state.watcher?.hide();
  }
}

/** @param {?MpvWatch} state */
export function syncMpvAutoplay(state) {
  if (!state?.alive) return;
  if (!Options.mpvAutoplayNext) cancelMpvCountdown(state);
  state.watcher?.state({autoplay: !!Options.mpvAutoplayNext});
}

/**
 * Only a single mpv window, which the host can follow: a window per stream has no pipe.
 * @param {TabHolder} tab
 * @param {string} url
 * @param {?Array<{url: string}>} [qualities]
 * @param {?string} [local] - The playlist file mpv plays the stream from (helper 27's hls), its path in mpv.
 */
export function watchMpvFor(tab, url, qualities = null, local = null) {
  if (!tab || typeof tab.tabId !== 'number' || !isTabOpen(tab) || !Mpv.singleInstance) {
    return;
  }
  if (tab.continuationOptions?.mpvNext) {
    tab.continuationOptions = null;
  }
  tab.mpvNextEpisodeUntil = 0;
  // Another tab's stream took the window: that tab's episode no longer goes to mpv by itself.
  const before = mpvWatch && mpvWatch.tabId !== tab.tabId ? Tabs.getTab(mpvWatch.tabId) : null;
  if (before) {
    before.mpvNextEpisodeUntil = 0;
    if (before.continuationOptions?.mpvNext) {
      before.continuationOptions = null;
    }
    closeReopenedTab(before);
  }
  if (mpvWatch?.alive) {
    if (mpvWatch.stalled) clearTimeout(mpvWatch.stalled);
    mpvWatch.stalled = null;
    cancelMpvCountdown(mpvWatch);
    mpvWatch.tabId = tab.tabId;
    mpvWatch.url = url;
    mpvWatch.qualities = qualities;
    mpvWatch.local = local;
    // The links of the tab's page before are not this one's.
    mpvWatch.closedTab = null;
    mpvWatch.links = null;
    mpvWatch.site = siteOf(tab.url);
    rememberEpisodeLinks(mpvWatch, tab);
    return;
  }
  /** @type {MpvWatch} */
  const state = {tabId: tab.tabId, url, qualities, local, alive: true, going: false, countdown: null, countdownAsks: 0,
    stalled: null, links: null, closedTab: null, site: siteOf(tab.url), watcher: null};
  mpvWatch = state;
  state.watcher = Mpv.watch((event) => onMpvWatchEvent(state, event));
  rememberEpisodeLinks(state, tab);
}

export const EpisodeLinksAgainMs = 10000;

/**
 * A page that lists its episodes only a while after its stream is read once more.
 * @param {MpvWatch} state
 * @param {TabHolder} tab
 * @return {Promise<void>}
 */
export async function rememberEpisodeLinks(state, tab) {
  const page = tab.mpvPage;
  const stillThePage = () => state.alive && mpvWatch === state && state.tabId === tab.tabId && isTabOpen(tab) &&
    tab.mpvPage === page;
  let links = await readEpisodeLinks(tab);
  if (!stillThePage()) return;
  state.links = links;
  if (!links.next && !links.seriesEnd) {
    await new Promise((resolve) => setTimeout(resolve, EpisodeLinksAgainMs));
    if (!stillThePage()) return;
    links = await readEpisodeLinks(tab);
    if (!stillThePage()) return;
    state.links = links;
  }
  if (tab.mpvReopened) {
    closeReopenedTab(tab);
  }
}

/**
 * Top frame only: a hoster's or an ad's frame links would open in the tab's container.
 * @param {TabHolder} tab
 * @return {Promise<EpisodeLinksOfTab>}
 */
export async function readEpisodeLinks(tab) {
  /** @type {EpisodeLinksOfTab} */
  const links = {tabId: tab.tabId, next: null, previous: null, seriesEnd: false, cookieStoreId: null};
  const answer = await askFrame(tab.tabId, {type: MessageTypes.EPISODE_LINKS}, {frameId: 0}, 'episode_links',
      MpvPagePollMs);
  const address = (/** @type {*} */ value) => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null;
  if (answer && typeof answer === 'object' && !answer.error) {
    links.next = answer.hasNext === true ? address(answer.next) : null;
    links.seriesEnd = answer.hasNext !== true && answer.seriesEnd === true;
    links.previous = address(answer.previous);
  }
  // Its container, for the same cookies and login; the default and private stores go by the window.
  const store = await chrome.tabs.get(tab.tabId).then((info) => info?.cookieStoreId || null, () => null);
  links.cookieStoreId = store && store !== 'firefox-default' && store !== 'firefox-private' ? store : null;
  return links;
}

/**
 * @param {number} tabId
 * @param {{windowId: number, isWindowClosing: boolean}} removed
 */
export function noteMpvTabClosed(tabId, removed) {
  const state = mpvWatch;
  if (!state?.alive || state.tabId !== tabId || state.links?.tabId !== tabId) return;
  state.closedTab = {links: state.links, windowId: removed.windowId, windowClosing: !!removed.isWindowClosing};
  if (Logging) console.log('[MPV autoplay] its tab was closed; the episodes go on in a new one:', state.links);
}

/**
 * @param {MpvWatch} state
 * @param {import('./MpvBackend.mjs').MpvWatchEvent} event
 */
export function onMpvWatchEvent(state, event) {
  if (event.type === 'closed') {
    state.alive = false;
    cancelMpvCountdown(state);
    if (state.stalled) clearTimeout(state.stalled);
    state.stalled = null;
    if (mpvWatch === state) mpvWatch = null;
    // mpv is gone: the page's next play is the user's, not the player repeating itself.
    const tab = event.reason === 'mpv closed' || event.reason === 'no mpv' ? Tabs.getTab(state.tabId) : null;
    if (tab?.mpvLastPlaySend) {
      tab.mpvLastPlaySend = null;
      Tabs.saveTabState(tab);
    }
    if (tab) closeReopenedTab(tab);
    if (Logging) console.log('[MPV autoplay] the watch ended:', event.reason);
    return;
  }
  if (event.type === 'watching') {
    syncMpvAutoplay(state);
  } else if (event.type === 'decoder') {
    const tab = Tabs.getTab(state.tabId);
    if (tab) setMpvDecoder(tab, event.decoder);
  } else if (event.type === 'ended') {
    if (Options.mpvAutoplayNext && (isSentStream(event.path, state.url, state.qualities) ||
        (state.local !== null && event.path === state.local))) {
      startMpvCountdown(state);
    }
  } else if (event.type === 'request' && (event.action === 'next' || event.action === 'previous')) {
    // A key or a button: now, whatever the countdown says.
    cancelMpvCountdown(state);
    goToEpisode(state, event.action);
  } else if (event.type === 'request' && event.action === 'autoplay') {
    toggleMpvAutoplay(state);
  } else if (event.type === 'request' && event.action === 'pause') {
    // Space at an end stops this countdown and keeps autoplay on for the next end.
    const counting = !!state.countdown;
    cancelMpvCountdown(state);
    if (counting) {
      state.watcher?.notify(chrome.i18n.getMessage('mpv_autoplay_title') || 'Autoplay',
          chrome.i18n.getMessage('mpv_autoplay_stopped') || 'stopped (n: next episode)');
    }
  }
}

export const MpvPagePollMs = 1000;

/** A frame that never answered kept state.going set, and every later key returned at it. */
export const MpvPageNavigateMs = 5000;

/**
 * Top frame first; the first frame that knows decides (a hoster's links are other videos).
 * @param {TabHolder} tab
 * @return {Promise<?string>}
 */
export async function nextEpisodeInPage(tab) {
  const frameIds = tab.frames ? Array.from(tab.frames.keys()).sort((a, b) => a - b) : [];
  for (const frameId of frameIds) {
    // No answer is "cannot tell": a silent frame costs a second, not the countdown.
    const answer = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), MpvPagePollMs);
      chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.PLAYLIST_POLL}, {frameId}, (response) => {
        void chrome.runtime.lastError;
        clearTimeout(timer);
        resolve(response);
      });
    });
    if (answer && typeof answer === 'object') {
      if (answer.next === true) return 'next';
      if (answer.seriesEnd === true) return 'series_end';
    }
  }
  return null;
}

/**
 * The page is asked first: at the series' last episode nothing is counted down.
 * @param {MpvWatch} state
 * @return {Promise<void>}
 */
export async function startMpvCountdown(state) {
  if (state.countdown) return;
  const seconds = autoplayCountdownSeconds();
  if (seconds === 0) {
    goToEpisode(state, 'next');
    return;
  }
  // A key, the switch, mpv closing or another end while the page is asked wins over this one.
  const ask = ++state.countdownAsks;
  const tab = Tabs.getTab(state.tabId);
  // A closed tab's page, or one gone to another site, said it at the hand-off: that site's page is not asked.
  const away = !!tab && !onWatchedSite(state, tab);
  const links = !tab ? state.closedTab?.links : away ? state.links : null;
  const page = tab && !away && tab.isOn && tab.isMpv ? await nextEpisodeInPage(tab) :
    links?.seriesEnd ? 'series_end' : null;
  if (ask !== state.countdownAsks || state.countdown || !state.alive || !Options.mpvAutoplayNext) return;
  if (page === 'series_end') {
    notifySeriesEnd(state);
    return;
  }
  state.watcher?.notify(chrome.i18n.getMessage('mpv_autoplay_title') || 'Autoplay',
      chrome.i18n.getMessage('mpv_autoplay_countdown', [String(seconds)]) ||
      `next episode in ${seconds} s (n: now, Space: stop)`, seconds);
  state.countdown = setTimeout(() => {
    state.countdown = null;
    if (state.alive && Options.mpvAutoplayNext) goToEpisode(state, 'next');
  }, seconds * 1000);
}

/**
 * @param {MpvWatch} state
 * @return {Promise<void>}
 */
export function toggleMpvAutoplay(state) {
  // One after the other: two quick presses read the same setting before either was saved.
  mpvAutoplayToggles = mpvAutoplayToggles.then(async () => {
    const on = !Options.mpvAutoplayNext;
    try {
      await saveOption('mpvAutoplayNext', on);
    } catch (e) {
      console.error('Saving MPV autoplay failed', e);
      return;
    }
    syncMpvAutoplay(state);
    state.watcher?.notify(chrome.i18n.getMessage('mpv_autoplay_title') || 'Autoplay',
        chrome.i18n.getMessage(on ? 'mpv_autoplay_on' : 'mpv_autoplay_off') || (on ? 'on' : 'off'));
  });
  return mpvAutoplayToggles;
}

export let mpvAutoplayToggles = Promise.resolve();

/**
 * @param {MpvWatch} state
 * @param {'next'|'previous'} direction
 */
export async function goToEpisode(state, direction) {
  const title = chrome.i18n.getMessage(direction === 'next' ? 'player_next_video_label' : 'player_previous_video_label') ||
    (direction === 'next' ? 'Next video' : 'Previous video');
  const tab = Tabs.getTab(state.tabId);
  if (!tab && state.closedTab) {
    return goToEpisodeInNewTab(state, direction, title);
  }
  if (tab && !onWatchedSite(state, tab)) {
    return goToEpisodeFromSiteLeft(state, tab, direction, title);
  }
  if (!tab || !tab.isOn || !tab.isMpv) {
    notifyEpisodeUnavailable(state, title);
    return;
  }
  // An end and a key at the same moment would click the page's link twice, a skipped episode.
  if (state.going) {
    return;
  }
  state.going = true;
  const frameIds = Array.from(tab.frames.keys()).sort((a, b) => a - b);
  let clicked = false;
  let seriesEnd = false;
  try {
    for (const frameId of frameIds) {
      const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), MpvPageNavigateMs);
        chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.PLAYLIST_NAVIGATION, direction}, {frameId}, (response) => {
          void chrome.runtime.lastError;
          clearTimeout(timer);
          resolve(response);
        });
      });
      // No other frame is asked: this one may still click.
      if (answer === 'timeout') break;
      if (answer === 'clicked') {
        clicked = true;
        break;
      }
      if (answer === 'series_end') {
        seriesEnd = true;
        break;
      }
    }
  } finally {
    state.going = false;
  }
  // Another tab's stream took mpv while the page was asked: what this page did no longer counts.
  if (state.tabId !== tab.tabId || !state.alive) {
    return;
  }
  if (seriesEnd) {
    notifySeriesEnd(state);
    return;
  }
  if (!clicked) {
    state.watcher?.notify(title, chrome.i18n.getMessage('mpv_episode_none') || 'none found on the page',
        MpvNoticeSeconds);
    noteProblem(tab.tabId, {url: tab.url, kind: ProblemKinds.NO_NEXT, mode: 'mpv'}).catch((e) => console.error(e));
    return;
  }
  if (Logging) console.log('[MPV autoplay] went on:', direction, tab.tabId);
  awaitEpisodeStream(state, tab, title);
}

/**
 * @param {MpvWatch} state
 * @param {string} title
 */
export function notifyEpisodeUnavailable(state, title) {
  state.watcher?.notify(title, chrome.i18n.getMessage('mpv_episode_unavailable') ||
    'its tab is closed, or not in MPV mode', MpvNoticeSeconds);
}

/**
 * The episode opens in a tab not shown, in the closed one's window and container; Firefox loads its stream there.
 * @param {MpvWatch} state
 * @param {'next'|'previous'} direction
 * @param {string} title
 * @return {Promise<void>}
 */
export async function goToEpisodeInNewTab(state, direction, title) {
  const closed = state.closedTab;
  if (!closed) return;
  const url = direction === 'next' ? closed.links.next : closed.links.previous;
  if (!url) {
    if (direction === 'next' && closed.links.seriesEnd) {
      notifySeriesEnd(state);
    } else {
      notifyEpisodeUnavailable(state, title);
    }
    return;
  }
  // Its window went with it, or MPV mode was switched off since.
  if (closed.windowClosing || !Options.mpvMode) {
    notifyEpisodeUnavailable(state, title);
    return;
  }
  // An end and a key at the same moment would open the episode twice.
  if (state.going) {
    return;
  }
  state.going = true;
  /** @type {?chrome.tabs.Tab} */
  let created = null;
  try {
    created = await chrome.tabs.create({url, active: false, windowId: closed.windowId,
      ...(closed.links.cookieStoreId ? {cookieStoreId: closed.links.cookieStoreId} : {})});
  } catch (e) {
    console.error('Opening the next episode\'s tab failed', e);
  } finally {
    state.going = false;
  }
  if (!created || typeof created.id !== 'number') {
    notifyEpisodeUnavailable(state, title);
    return;
  }
  // mpv closed, or another tab's stream took it, while the tab was made.
  if (!state.alive || mpvWatch !== state || state.closedTab !== closed) {
    chrome.tabs.remove(created.id).catch(() => {});
    return;
  }
  state.closedTab = null;
  state.links = null;
  state.tabId = created.id;
  state.site = siteOf(url);
  // MPV, as the closed tab was: matched by the allowlist, its own start would send the page's first stream too.
  const tab = Tabs.getTabOrCreate(created.id);
  tab.isOn = true;
  tab.isMpv = true;
  tab.mpvOnPlay = false;
  tab.mpvMatched = MpvAllowlist.matches(url);
  tab.mpvReopened = true;
  BackgroundUtils.updateTabIcon(tab);
  if (Logging) console.log('[MPV autoplay] went on in a new tab:', direction, created.id, url);
  awaitEpisodeStream(state, tab, title);
  // Its frames may have come before the continuation did (FRAME_ADDED starts this too).
  startPagePlayers(tab);
}

/**
 * @param {string|undefined} url
 * @return {string}
 */
function siteOf(url) {
  try {
    return new URL(String(url)).hostname;
  } catch (e) {
    return '';
  }
}

/**
 * The site, not the page: a tab taken to another site must not have that site's "next" clicked.
 * @param {MpvWatch} state
 * @param {TabHolder} tab
 * @return {boolean}
 */
function onWatchedSite(state, tab) {
  return !state.site || siteOf(tab.url) === state.site;
}

/**
 * @param {MpvWatch} state
 * @param {TabHolder} tab
 * @param {'next'|'previous'} direction
 * @param {string} title
 * @return {Promise<void>}
 */
async function goToEpisodeFromSiteLeft(state, tab, direction, title) {
  if (!state.links || state.going) {
    if (!state.going) notifyEpisodeUnavailable(state, title);
    return;
  }
  const links = state.links;
  /** @type {number|undefined} */
  let windowId;
  try {
    windowId = (await chrome.tabs.get(tab.tabId)).windowId;
  } catch (e) {
    // Closed meanwhile: noteMpvTabClosed keeps its links, and the next end goes on from them.
  }
  if (typeof windowId !== 'number' || !state.alive || mpvWatch !== state || state.links !== links) {
    if (typeof windowId !== 'number') notifyEpisodeUnavailable(state, title);
    return;
  }
  state.closedTab = {links, windowId, windowClosing: false};
  await goToEpisodeInNewTab(state, direction, title);
  // Not taken (no link that way, MPV off): the tab is still there, and not closed.
  if (state.closedTab?.links === links) state.closedTab = null;
}

/**
 * @param {MpvWatch} state
 * @param {TabHolder} tab
 * @param {string} title
 */
export function awaitEpisodeStream(state, tab, title) {
  tab.continuationOptions = {autoPlay: true, mpvNext: true};
  tab.mpvNextEpisodeUntil = Date.now() + MpvNextEpisodeWaitMs;
  // Not for a tab closed meanwhile: its state would go back into storage.
  if (isTabOpen(tab)) Tabs.saveTabState(tab);
  state.watcher?.notify(title, chrome.i18n.getMessage('mpv_episode_loading') || 'loading in mpv',
      MpvNoticeSeconds);
  // The page had its minute and brought no stream: mpv says so.
  if (state.stalled) clearTimeout(state.stalled);
  state.stalled = setTimeout(() => {
    state.stalled = null;
    if (!state.alive || mpvWatch !== state || state.tabId !== tab.tabId) return;
    noteProblem(tab.tabId, {url: tab.url, kind: ProblemKinds.NO_STREAM, mode: 'mpv'}).catch((e) => console.error(e));
    state.watcher?.notify(title, chrome.i18n.getMessage('mpv_episode_nostream') ||
      'the page brought no stream within a minute; open it in the browser to see why', MpvNoticeSeconds);
  }, MpvNextEpisodeWaitMs);
}

/**
 * A fresh mpv answers seconds after the send: an answer for the page before must not touch the next.
 * @param {TabHolder} tab
 * @param {number} page
 * @return {boolean}
 */
export function isHandOffPage(tab, page) {
  return isTabOpen(tab) && tab.mpvPage === page;
}

/**
 * pushState counts a new mpvPage, not a new document.
 * @param {TabHolder} tab
 * @return {() => boolean}
 */
function handOffStillWanted(tab) {
  const page = tab.mpvPage;
  const document = tab.getFrame(0)?.documentKey;
  return () => isTabOpen(tab) && tab.isOn && tab.isMpv && !!Options.mpvMode &&
    (tab.mpvPage === page || (!!document && tab.getFrame(0)?.documentKey === document));
}

/**
 * An outdated host shows in the tooltip only: an older helper still plays the stream.
 * @param {TabHolder} tab
 * @param {{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean}} result
 */
export function setMpvError(tab, result) {
  if (!isTabOpen(tab)) {
    return;
  }
  /** @type {?string} */
  let error = null;
  if (!result.ok) {
    error = result.noHost || !result.error ?
      chrome.i18n.getMessage('player_mpv_no_host') || 'the FastStream mpv helper did not answer - is it installed?' :
      result.error;
  }
  const hostOutdated = result.hostOutdated === true;
  if (tab.mpvError !== error || tab.mpvHostOutdated !== hostOutdated) {
    tab.mpvError = error;
    tab.mpvHostOutdated = hostOutdated;
    BackgroundUtils.updateTabIcon(tab);
    Tabs.saveTabState(tab);
  }
}

// A slow stream takes seconds to open, and until then mpv has no decoder to name.
export const MpvDecoderWaitMs = 20000;

/**
 * Read-only: FastStream never overrides mpv.conf. Only an mpv started for single-instance use can be asked.
 * @param {TabHolder} tab
 * @param {{ok: boolean}} result
 */
export function followMpvDecoder(tab, result) {
  const query = {};
  tab.mpvDecoderQuery = query;
  setMpvDecoder(tab, null);
  if (!result.ok || !Mpv.singleInstance) {
    return;
  }
  // The relay tells the decoder as mpv loads it; asking each second started a helper process each time.
  if (Mpv.mayUse(Capabilities.RELAY)) {
    return;
  }
  Mpv.decoderStatus(MpvDecoderWaitMs).then((status) => {
    // A later hand-off (or a new page) asks again: this answer is about an older stream.
    if (tab.mpvDecoderQuery !== query) {
      return;
    }
    setMpvDecoder(tab, status.ok && status.running ? status.decoder || null : null);
  }).catch((e) => console.warn('Asking mpv for its decoder failed', e));
}

/**
 * @param {TabHolder} tab
 * @param {?import('./MpvBackend.mjs').MpvDecoder} decoder
 */
export function setMpvDecoder(tab, decoder) {
  // The tab is often closed by then: the stream plays in mpv.
  if (!isTabOpen(tab) || JSON.stringify(tab.mpvDecoder ?? null) === JSON.stringify(decoder)) {
    return;
  }
  tab.mpvDecoder = decoder;
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
}

/** @type {WeakSet<Object>} */
const PlaySendsUnanswered = new WeakSet();

/**
 * The same video within MpvPlayRepeatMs is the player repeating itself. No tab for openStream: its dedupe would swallow a later deliberate play.
 * @param {TabHolder} tab
 * @param {{url: string, headers: *}} source
 * @param {?{time?: number, duration?: ?number}} [video]
 * @param {string} [pageUrl] - The page mpv names and resumes it by; a YouTube video's own address.
 */
export function sendPlayedToMpv(tab, source, video = null, pageUrl = tab.url) {
  // As autoOpenInMpv: a tab closed while its stream was looked for sends nothing.
  if (!isTabOpen(tab)) {
    return;
  }
  const now = Date.now();
  const last = tab.mpvLastPlaySend;
  if (last && last.url === source.url && now - last.time < MpvPlayRepeatMs) {
    // Unanswered yet: its answer pauses the page if mpv has it, and a failure leaves it playing.
    if (!PlaySendsUnanswered.has(last)) {
      pauseTabMedia(tab.tabId);
    }
    return;
  }

  const sent = {url: source.url, time: now};
  tab.mpvLastPlaySend = sent;
  PlaySendsUnanswered.add(sent);
  Tabs.saveTabState(tab);
  const page = tab.mpvPage;
  const wanted = handOffStillWanted(tab);
  // Only a video of a known length, past its first seconds.
  const time = video?.time;
  const startTime = Number.isFinite(video?.duration) && typeof time === 'number' && time > 5 ? time : undefined;
  tabTitle(tab.tabId).then((title) =>
    openInMpv(tab.tabId, source.url, null, source.headers, resolveMpvContentType(null, pageUrl), pageUrl, title,
        {startTime, wanted})).then((result) => {
    PlaySendsUnanswered.delete(sent);
    if (Logging) console.log('[MPV] user play result:', source.url, JSON.stringify(result));
    if ('dropped' in result && tab.mpvLastPlaySend === sent && isTabOpen(tab)) {
      tab.mpvLastPlaySend = null;
      Tabs.saveTabState(tab);
    }
    if (!isHandOffPage(tab, page) || 'dropped' in result || playHereInstead(tab, result)) {
      return;
    }
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseAfterHandOff(tab, result);
    } else if (tab.mpvLastPlaySend && tab.mpvLastPlaySend.url === source.url) {
      // The host never launched mpv: the next play may try. A copy-protected video's too.
      tab.mpvLastPlaySend = null;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    PlaySendsUnanswered.delete(sent);
    console.error('Handing the played video to mpv failed', e);
    if (isHandOffPage(tab, page)) {
      setMpvError(tab, {ok: false, error: String(e)});
    }
  });
}

/**
 * One source only: mpv opens a window per send. The longest; of ties the newest, which the page just started.
 * @param {TabHolder} tab
 * @return {boolean}
 */
export function openMpvWithSources(tab) {
  if (!Options.mpvMode) {
    return false;
  }

  // An explicit start: forget what was sent, or openStream's dedupe swallows a re-entry.
  tab.mpvSentUrls.clear();

  const source = newestOfLongest(tabSources(tab));
  if (!source) {
    return false;
  }

  // The allowlist's own hand-off, latch and answer included.
  autoOpenInMpv(tab, source.url, source.headers);
  return true;
}

/**
 * Not through Firefox VPN: mpv asks from the user's address, and a site tying its stream to the VPN's refuses it.
 * @param {number|undefined} tabId
 * @param {string} url
 * @param {...*} rest
 * @return {Promise<MpvHandOff>}
 */
export async function openInMpv(tabId, url, ...rest) {
  let incognito;
  if (tabId !== undefined && tabId >= 0) {
    try {
      incognito = !!(await chrome.tabs.get(tabId))?.incognito;
    } catch (e) {
      // The tab went: both kinds of window count.
    }
  }
  // VPN is known by the detected stream's host: a quality file taken in its place may be on another host.
  const detected = url;
  // The page's subtitles go with its stream; the player's button sends its own. Read beside the other waits.
  const subtitlesTab = tabId !== undefined && tabId >= 0 && !(rest[5] && 'subtitles' in rest[5]) ? Tabs.getTab(tabId) : null;
  const pageSubtitles = subtitlesTab ? pageSubtitlesForMpv(subtitlesTab).catch((e) => {
    console.error('Reading the subtitles of the page for mpv failed', e);
    return [];
  }) : Promise.resolve([]);
  // A file only its page gives (servesWebPage): told by its length read's first answer.
  const file = tabId !== undefined && tabId >= 0 && Tabs.getTab(tabId) ?
    tabSources(Tabs.getTab(tabId)).find((source) => source.url === detected &&
      (source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT)) : null;
  if (file) {
    Lengths.probe(file);
  }
  const webPage = Lengths.servesWebPage(detected, HlsQualitiesWaitMs);
  // The page's qualities: mpv gets the one the quality setting asks for, and the list; not for the player's button.
  if (tabId !== undefined && tabId >= 0 && !(rest[5] && 'qualities' in rest[5])) {
    const choice = await pageQualityChoice(Tabs.getTab(tabId), url);
    if (choice) {
      if (Logging && choice.url !== url) console.log('[MPV] the page\'s best quality instead:', choice.url);
      url = choice.url;
      rest[5] = {...(rest[5] || {}), qualities: choice.list};
    }
  }
  // An HLS stream: its master's quality for the setting, and the list; not for the player's button.
  if (!(rest[5] && 'qualities' in rest[5])) {
    const choice = await hlsQualityChoice(tabId !== undefined && tabId >= 0 ? Tabs.getTab(tabId) : null, url);
    if (choice) {
      if (Logging && choice.url !== url) console.log('[MPV] the HLS stream\'s best quality instead:', choice.url);
      url = choice.url;
      if (choice.list) rest[5] = {...(rest[5] || {}), qualities: choice.list};
    }
  }
  // Copy-protected: mpv has no key system, and its window stayed black.
  const tracked = tabId !== undefined && tabId >= 0 && Tabs.getTab(tabId) ?
    tabSources(Tabs.getTab(tabId)).find((source) => source.url === detected) : null;
  // An HLS stream mpv cannot open from its address alone: its playlists go with every address whole
  // (MpvHlsPackage.mjs), read meanwhile and stopped when the stream does not go or its page or MPV went.
  const stopPacking = new AbortController();
  const stillWanted = rest[5]?.wanted;
  const packing = tracked && tracked.mode === PlayerModes.ACCELERATED_HLS ?
    Promise.resolve().then(() => {
      const watching = stillWanted ? setInterval(() => {
        if (!stillWanted()) stopPacking.abort();
      }, PackingWantedCheckMs) : undefined;
      return hlsPackage({url, keyFrom: detected, typed: tracked.typed === true, io: hlsPackageIo(rest[1]), signal: stopPacking.signal})
          .finally(() => clearInterval(watching));
    }).catch((e) => {
      console.error('Reading the playlists of an HLS stream for mpv failed', e);
      return null;
    }) : Promise.resolve(null);
  if (tracked && (tracked.mode === PlayerModes.ACCELERATED_HLS || tracked.mode === PlayerModes.ACCELERATED_DASH)) {
    await Lengths.settle(() => [tracked], HlsQualitiesWaitMs);
  }
  if (Lengths.isProtected(detected) || Lengths.isProtected(url)) {
    if (Logging) console.log('[MPV] not handed off, copy-protected:', url);
    stopPacking.abort();
    return {
      ok: false,
      drm: true,
      error: chrome.i18n.getMessage('player_mpv_drm') ||
        'This video is copy-protected (DRM), and mpv cannot play it: the site\'s own player keeps it.',
    };
  }
  // Answered with a web page from anywhere but its page: FastStream's player loads it through the page (playHereInstead).
  if (await webPage || (url !== detected && await Lengths.servesWebPage(url, 0))) {
    if (Logging) console.log('[MPV] not handed off, only its page loads it:', url);
    stopPacking.abort();
    return {
      ok: false,
      pageOnly: true,
      error: chrome.i18n.getMessage('player_mpv_page_only') ||
        'This video loads only through its page, and mpv cannot open it: FastStream plays it here.',
    };
  }
  if (VpnMirror.throughBrowserVpn(detected, incognito) || VpnMirror.throughBrowserVpn(url, incognito)) {
    if (Logging) console.log('[MPV] not handed off, Firefox VPN carries it:', url);
    stopPacking.abort();
    return Promise.resolve({
      ok: false,
      vpn: true,
      error: chrome.i18n.getMessage('player_mpv_vpn') ||
        'Firefox VPN carries this video, and mpv cannot use it. Turn Firefox VPN off for this site and reload the page.',
    });
  }
  const pack = await packing;
  if (pack) {
    // Unknown (no helper answered): it goes, and the answer says why it did not play.
    if (await Mpv.knows(Capabilities.HLS) === false) {
      if (Logging) console.log('[MPV] not handed off, the helper is older than 27:', url);
      return {
        ok: false,
        hostOutdated: true,
        error: chrome.i18n.getMessage('player_mpv_needs_hls_helper') ||
          'mpv can play this stream only with the newer mpv helper: run update-local.cmd in the mpv folder of FastStream, then send it again.',
      };
    }
    if (Logging) console.log('[MPV] its playlists go along:', pack.files.map((file) => file.name));
    // Its quality list's addresses lack the key the files are given here.
    rest[5] = {...(rest[5] || {}), hls: pack, qualities: undefined};
  }
  const tabHolder = rest[0];
  if (subtitlesTab && !tabHolder?.mpvSentUrls?.has(url)) {
    const subtitles = await pageSubtitles;
    if (subtitles.length > 0) {
      if (Logging) console.log('[MPV] subtitles of the page go along:', subtitles.map((s) => s.label));
      rest[5] = {...(rest[5] || {}), subtitles};
    }
  }
  if (incognito) {
    // A private window's: mpv keeps no resume position (fs-private).
    rest[5] = {...(rest[5] || {}), private: true};
  }
  const wanted = rest[5]?.wanted;
  if (wanted) {
    rest[5] = {...rest[5]};
    delete rest[5].wanted;
    // The waits above take seconds on a slow CDN.
    if (!wanted()) {
      if (Logging) console.log('[MPV] not handed off, its page or MPV went meanwhile:', url);
      return {ok: false, dropped: true};
    }
  }
  const result = await Mpv.openStream(url, ...rest);
  // By the tab's id: the player's button and the MPV key's play pass no tab.
  if (result && result.ok && tabId !== undefined && tabId >= 0) {
    watchMpvFor(Tabs.getTab(tabId), url, rest[5]?.qualities || null, typeof result.local === 'string' ? result.local : null);
  }
  return result;
}
