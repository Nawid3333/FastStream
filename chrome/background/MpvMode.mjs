// @ts-check
// MPV mode: handing a page's video to mpv (the native host, MpvBackend), and what follows it -
// the autoplay watch over the page's next episode, its countdown, the hand-off's results
// (decoder, errors) and the toolbar's MPV toggle. Moved out of background.mjs (2026-11-07),
// whose shared state and helpers it imports from there; background.mjs registers the
// listeners (they have to be at its top level for the event page to wake for them).
import {MessageTypes} from '../player/enums/MessageTypes.mjs';
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {ProblemKinds} from '../player/utils/ProblemLog.mjs';
import {SHORT_S} from '../player/utils/StreamPick.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';
import {Capabilities, MpvBackend} from './MpvBackend.mjs';
import {UrlMatchList} from './UrlMatchList.mjs';
import {AutoEnableList, CaptionScrapeWaitMs, HlsQualitiesWaitMs, Lengths, Logging, Options, PageSubtitles, SourceLengthWaitMs, Tabs, VpnMirror, askFrame, closeReopenedTab, ensureOptions, hlsQualityChoice, isSentStream, isTabOpen, newestOfLongest, noteProblem, notifySeriesEnd, openPlayersWithSources, pageQualityChoice, pauseTabMedia, saveOption, scrapeCaptionsTags, startPagePlayers, tabHasPlayer, tabTitle, takeScrapedCaptions, userTurnedOff} from './background.mjs';

/** @typedef {import('./TabTracker.mjs').TabHolder} TabHolder */
/** @typedef {import('./TabTracker.mjs').TrackedSource} TrackedSource */
/** @typedef {import('./background.mjs').TabExtras} TabExtras */
/** @typedef {import('./background.mjs').Continuation} Continuation */
/** @typedef {import('./background.mjs').MpvHandOff} MpvHandOff */

export const MpvAllowlist = new UrlMatchList();

export const Mpv = new MpvBackend();

// The shortcut's MPV waits for the user to start a video (onUserPlay). A play
// whose stream is not detected yet takes the next one within MpvPlayPendingMs;
// the same video played again within MpvPlayRepeatMs is the player repeating
// itself, not a second request.
export const MpvPlayPendingMs = 15000;

export const MpvPlayRepeatMs = 10000;

// The allowlist's MPV, on a page Back gave back: how long a play whose stream is not
// known waits for it to be detected before the page's known stream goes
// (autoOpenKnownLater). 1 s (3 s until 2026-10-14): a play-triggered fetch lands within a
// few hundred ms, and every Back + play waited the whole time before mpv started.
export const MpvPlayKnownAfterMs = 1000;

/**
 * Resolves the anime/movie shader hint sent to mpv for a stream.
 *
 * Movie is the fallback on purpose: most sites on the MPV Allowlist are
 * movie sites for this user, so only the anime ones need an `@anime` tag --
 * an untagged site, or none of this ever matching, still gets an explicit
 * `movie` rather than nothing (which would leave it to mpv's own, less
 * reliable folder-name heuristic).
 *
 * @param {?string} [explicit] - The player's manual per-video override
 *   (SaveManager.mjs's mpvContentType), or anything else to fall through.
 * @param {string} [url] - Tab URL to check against the MPV Allowlist.
 * @return {string} 'anime' or 'movie', never null/undefined.
 */
export function resolveMpvContentType(explicit, url) {
  if (explicit === 'anime' || explicit === 'movie') {
    return explicit;
  }
  return MpvAllowlist.getContentType(url) || 'movie';
}

/**
 * Puts a tab in MPV mode: FastStream on, streams handed to mpv.
 *
 * An active in-page player has to come down first - the same reload the plain
 * Off/On toggle uses to undo one - because a FastStream overlay isn't
 * something a message can cleanly retract. isMpv is set before the reload, so
 * the freshly (re-)detected source is what onSourceRecieved forwards to mpv
 * once the page reloads; nothing here has to redo that forwarding itself.
 *
 * With onPlay (the shortcut) nothing is handed off here or by the page's own
 * stream requests: the tab waits for the user to start a video (onUserPlay).
 * A video they started and are still watching counts as started now.
 *
 * What the button said of the last hand-off - its failure, an outdated host, mpv's
 * decoder - goes: it is about a stream sent before, and after MPV off and on again it
 * showed with nothing sent since. The next hand-off says it again.
 *
 * @param {TabHolder & TabExtras} tab - The tab to switch.
 * @param {boolean} [onPlay] - Wait for the user to start a video.
 * @return {Promise<void>}
 */
export async function startMpv(tab, onPlay = false) {
  tab.isOn = true;
  tab.isMpv = true;
  tab.mpvOnPlay = onPlay;
  // The user's own MPV (the MPV key, the toolbar's On -> MPV), not a list's start: it stays
  // for the tab (his call, 2026-10-10). Still marked as the list's, it went off on the first
  // page outside the lists of a site an auto-enable list had turned on (glm's review,
  // 2026-10-13).
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
  } else if (onPlay) {
    // A fresh start: the same video may go to mpv again.
    tab.mpvSentUrls.clear();
    tab.mpvLastPlaySend = null;
    tab.mpvPlayPendingUntil = 0;
    tab.mpvPlayedVideo = null;
    tab.mpvPlayChecking = null;
    chrome.tabs.sendMessage(tab.tabId, {
      type: MessageTypes.MPV_REPORT_PLAYING,
    }, () => {
      // A blank tab, or a page without the content script, is normal here.
      BackgroundUtils.checkMessageError('mpv_report_playing');
    });
  } else {
    // No player was ever requested for this page - hand off directly from
    // whatever sources are already tracked.
    openMpvWithSources(tab);
  }
}

/**
 * Takes a tab out of MPV mode and turns FastStream off for it, tearing down
 * any in-page player that is up or on its way.
 *
 * @param {TabHolder} tab - The tab to switch.
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

/**
 * Takes every tab out of MPV while MPV mode is off. That option is the switch for the
 * whole mpv integration, and a tab keeps its mode until something changes it: one in MPV
 * when the option was switched off, or put back so by a woken background, went on handing
 * its streams to mpv - on a site on both the MPV Allowlist and the auto-enable list, page
 * after page. Such a tab keeps FastStream on where the auto-enable list would turn it on,
 * for the in-page player, and is off everywhere else, as after the toolbar's MPV -> Off.
 * MPV opens no in-page player, so there is none to take down.
 */
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
 * The toggle_mpv shortcut (Alt+F unless the user rebinds it; Ctrl+Shift+U until
 * 2026-10-04): MPV on or
 * off for the tab, on any site. Unlike the toolbar cycle it does not need the
 * site on the MPV Allowlist - pressing it is the deliberate choice the
 * allowlist otherwise makes for the user. Off means FastStream off, the same
 * as the toolbar's MPV -> Off step. From the in-page player it goes straight to
 * MPV, as the player's key goes from MPV straight to the player (onClicked).
 *
 * Only a video the user starts goes to mpv (startMpv's onPlay, onUserPlay):
 * on an arbitrary site the first stream a page loads is as likely a preview
 * or a background clip as the video they came for.
 *
 * On a blank or new tab it arms MPV for the tab instead: nothing is playing
 * yet, and the tab's mode survives navigation, so the first video of the next
 * page opened there goes to mpv (new tab, Alt+F, paste a link). The
 * toolbar opens the player page on a blank tab; that page has no video to send.
 * On the player page itself it does nothing.
 *
 * Does nothing while MPV mode is off: that option is the switch for the whole
 * mpv integration, and openMpvWithSources refuses without it.
 *
 * @param {chrome.tabs.Tab} tabobj - The tab that was active when the key was pressed.
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
 * A tab a tab in MPV opened - a site's player in a pop-up tab, an episode middle-clicked -
 * starts in MPV as well, the MPV key's way: only a video the user starts there goes to mpv
 * (#337). MPV belongs to a tab, and the new one had none, so its video played in the
 * browser. Never the allowlist's automatic first stream: most pop-ups are ads, and an
 * autoplaying one would go to mpv. Firefox names the opener (openerTabId) for a tab, not
 * for a pop-up window, which this cannot reach (measured 2026-10-04).
 * @param {TabHolder} openerTab - The tab that opened it.
 * @param {number} tabId - The new tab.
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
 * Notes a next episode whose page brought no video within a minute (ProblemLog): the
 * continuation is still there, as nothing took it (its sources, or mpv's stream).
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
 * A tab's subtitles, as SubRip for mpv: the subtitle files its page asked for and its
 * <track> elements, in every frame - what the in-page player would show from that page. A
 * frame that does not tell its <track> elements within CaptionScrapeWaitMs keeps those it
 * had.
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
 * Pauses the page after a hand-off the host says worked, and logs how raising mpv's window
 * went (the host's focus, foreground and reused). Not when the user turned MPV off since
 * the stream went (userTurnedOff): mpv got it all the same, but the page they went back to
 * plays on. A fresh mpv answers seconds after the send.
 * @param {TabHolder} tab - The tab the stream was sent from.
 * @param {{focus?: string, foreground?: string, reused?: boolean}} result - The host's answer.
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
 * After openInMpv refused a file only its page loads (pageOnly: abyss.to's player, #665):
 * the tab goes over from MPV to FastStream's own player, as the toolbar's MPV -> On does,
 * and that player, which loads the file through the page (PageFetch), says why
 * (tab.playerNotice). mpv's window opened and closed at once before, and nothing said why
 * (the owner's pick, 2026-11-12: no byte relay to mpv, which would need a new helper). Not
 * the user's Off (userTurnedOff): the toolbar shows On, and the user's click gives MPV back.
 * A tab the user turned off or over to FastStream meanwhile keeps that.
 * @param {TabHolder} tab - The tab the stream was sent from.
 * @param {MpvHandOff} result - openInMpv's answer.
 * @return {boolean} Whether it was such a refusal: then nothing else is done with it.
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
  tab.playerNotice = 'player_mpv_page_only';
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
  openPlayersWithSources(tab).catch((e) => console.error('Opening the player in place of mpv failed', e));
  return true;
}

/**
 * The allowlist's MPV: hands a page's stream to mpv, once per page
 * (tab.mpvAutoOpened), then pauses the page.
 *
 * @param {TabHolder} tab - The tab the stream is in.
 * @param {string} url - The stream.
 * @param {*} headers - Its request headers, as detected.
 */
export function autoOpenInMpv(tab, url, headers) {
  // Reached after awaits (options, a stream's length): a tab closed meanwhile sends nothing.
  if (!isTabOpen(tab)) {
    return;
  }
  tab.mpvAutoOpened = true;
  Tabs.saveTabState(tab);
  const page = tab.mpvPage;
  if (Logging) console.log('[MPV] forwarding detected stream to mpv:', url);
  tabTitle(tab.tabId).then((title) =>
    openInMpv(tab.tabId, url, tab, headers, resolveMpvContentType(null, tab.url), tab.url, title)).then((result) => {
    if (Logging) console.log('[MPV] forward result:', url, JSON.stringify(result));
    if (!isHandOffPage(tab, page) || playHereInstead(tab, result)) {
      return;
    }
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseAfterHandOff(tab, result);
    } else if (!('drm' in result)) {
      // The host never launched mpv, so let the next stream try. Not after a copy-protected
      // video's: the page's next stream would be one of its pieces, or an ad's.
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
 * MPV autoplay's next page (tab.mpvNextEpisodeUntil): the stream to send, picked as
 * openMpvWithSources picks, once the lengths of what the page loaded are read. Its first
 * stream went at once before, and here this extension started the page's player itself
 * (startPagePlayers): a hoster's player may load an ad's stream first, which went to mpv under
 * the episode's title, and the episode's own, detected after, was dropped (an anime site, season 1
 * to 2, his report 2026-10-13: mpv showed the title on a black picture). Each detection
 * starts the pick again. One known to run under StreamPick's SHORT_S (an ad, a trailer, a
 * preview) waits for a longer one until MpvNextPickGraceMs before the minute is up, and goes
 * then as the best there is. Only streams detected since the episode was asked for: a frame
 * of the page before that is not always gone from the tab (its FRAME_REMOVED never came),
 * and its episode, the longest, went to mpv again.
 * @param {TabHolder} tab - The tab gone on to the next episode.
 */
export async function pickNextEpisodeForMpv(tab) {
  const pick = {};
  tab.mpvNextPick = pick;
  clearTimeout(tab.mpvNextPickTimer);
  // Only while the episode is still waited for: another tab's stream that took the mpv window
  // ends the wait (watchMpvFor), and a pick then sent this tab's page over it.
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
 * Every stream detected in a tab's frames, once each.
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

// MPV autoplay (his wish, 2026-10-11): an episode handed to mpv that plays to its end (with
// "Autoplay next episode in mpv" on), or mpv's key or button for the next or the previous
// episode, goes on to that episode in the tab's page, and its stream goes into the same mpv
// window, so a series plays episode after episode without the browser. The host (7) follows
// mpv over a port kept open (MpvBackend.watch), which also keeps this background page from
// unloading (measured, docs/notes/mpv.md). Host 9 (same day, his wishes): mpv shows episode buttons and an autoplay switch
// (the mpv setup's faststream-episodes.lua), which this setting drives and the switch flips;
// an end waits Options.autoplayCountdown seconds, which the switch or a key can cut short,
// and Space stop.
// The tab may be closed while mpv plays (his wish, 2026-10-27): the next and the previous
// episode's links are read from its page at each hand-off (rememberEpisodeLinks), and an end
// or a key then opens the episode in a tab not shown (goToEpisodeInNewTab), which closes again
// once its stream went to mpv.
/**
 * The episode links of the page a stream went to mpv from, and where its tab was.
 * @typedef {{tabId: number, next: ?string, previous: ?string, seriesEnd: boolean,
 *   cookieStoreId: ?string}} EpisodeLinksOfTab
 */
/**
 * @typedef {{tabId: number, url: string, qualities: ?Array<{url: string}>, alive: boolean, going: boolean,
 *   countdown: ?ReturnType<typeof setTimeout>, countdownAsks: number,
 *   stalled: ?ReturnType<typeof setTimeout>,
 *   links: ?EpisodeLinksOfTab, closedTab: ?{links: EpisodeLinksOfTab, windowId: number, windowClosing: boolean},
 *   watcher: ?{notify: Function, hide: Function, state: Function, stop: Function}}} MpvWatch
 */
/** @type {?MpvWatch} */
export let mpvWatch = null;

// How long the next page has to bring its stream (MPV key's mode: TabHolder.mpvNextEpisodeUntil).
export const MpvNextEpisodeWaitMs = 60000;

// How long before that minute is up a short stream goes as the best there is
// (pickNextEpisodeForMpv).
export const MpvNextPickGraceMs = 5000;

// How long mpv shows a notice that is a sentence to read (host 11; before, every notice went
// after notify.lua's 2 s). The countdown's stays for the countdown; on and off for 2 s.
export const MpvNoticeSeconds = 6;

/**
 * The seconds between an episode's end and the next one (Options.autoplayCountdown).
 * @return {number} 0 to 30.
 */
export function autoplayCountdownSeconds() {
  const seconds = Number(Options.autoplayCountdown);
  return Number.isFinite(seconds) ? Math.min(30, Math.max(0, Math.round(seconds))) : 5;
}

/**
 * Stops an end's countdown, if one runs.
 * @param {MpvWatch} state
 */
export function cancelMpvCountdown(state) {
  // A countdown still asking the page (startMpvCountdown) does not start either.
  state.countdownAsks++;
  if (state.countdown) {
    clearTimeout(state.countdown);
    state.countdown = null;
    // Its notice stays for the whole countdown: a new stream, or autoplay switched off on
    // the options page, would leave "next episode in 5 s" up with nothing coming.
    state.watcher?.hide();
  }
}

/**
 * What mpv's autoplay switch shows: after the watch began, and when the setting changed.
 * @param {?MpvWatch} state
 */
export function syncMpvAutoplay(state) {
  if (!state?.alive) return;
  if (!Options.mpvAutoplayNext) cancelMpvCountdown(state);
  state.watcher?.state({autoplay: !!Options.mpvAutoplayNext});
}

/**
 * Follows the mpv a stream of the tab just went to: the latest hand-off is the one an end or
 * a key goes on from. Only a single mpv window (Mpv.singleInstance), which the host can
 * follow; a window per stream has no pipe.
 * @param {TabHolder} tab
 * @param {string} url - The stream sent.
 * @param {?Array<{url: string}>} [qualities] - The page's qualities of it that went along
 *   (isSentStream).
 */
export function watchMpvFor(tab, url, qualities = null) {
  if (!tab || typeof tab.tabId !== 'number' || !isTabOpen(tab) || !Mpv.singleInstance) {
    return;
  }
  // The next episode came: what was asked for it is done.
  if (tab.continuationOptions?.mpvNext) {
    tab.continuationOptions = null;
  }
  tab.mpvNextEpisodeUntil = 0;
  // Another tab's stream took the window: the episode that tab still waits for no longer
  // goes to mpv by itself, where it would replace this one.
  const before = mpvWatch && mpvWatch.tabId !== tab.tabId ? Tabs.getTab(mpvWatch.tabId) : null;
  if (before) {
    before.mpvNextEpisodeUntil = 0;
    if (before.continuationOptions?.mpvNext) {
      before.continuationOptions = null;
    }
    // One autoplay opened for an episode that no longer goes to mpv.
    closeReopenedTab(before);
  }
  if (mpvWatch?.alive) {
    // A stream arrived: the next page's "no stream" alarm, and an end's countdown, are done.
    if (mpvWatch.stalled) clearTimeout(mpvWatch.stalled);
    mpvWatch.stalled = null;
    cancelMpvCountdown(mpvWatch);
    mpvWatch.tabId = tab.tabId;
    mpvWatch.url = url;
    mpvWatch.qualities = qualities;
    // A tab that is open now is what an end goes on from. The links of the tab's page before
    // are not this one's: closed before these are read, it has none (glm's review).
    mpvWatch.closedTab = null;
    mpvWatch.links = null;
    rememberEpisodeLinks(mpvWatch, tab);
    return;
  }
  /** @type {MpvWatch} */
  const state = {tabId: tab.tabId, url, qualities, alive: true, going: false, countdown: null, countdownAsks: 0,
    stalled: null, links: null, closedTab: null, watcher: null};
  mpvWatch = state;
  state.watcher = Mpv.watch((event) => onMpvWatchEvent(state, event));
  rememberEpisodeLinks(state, tab);
}

/** How long rememberEpisodeLinks waits to read the links again when the page had none yet. */
export const EpisodeLinksAgainMs = 10000;

/**
 * Reads the next and the previous episode's links of the page whose stream just went to mpv,
 * for an end or a key to go on with once its tab is closed (goToEpisodeInNewTab), through
 * EPISODE_LINKS, which clicks nothing. A page that lists its episodes only a while after its
 * stream (a list it fetches) is read once more, also in a tab autoplay opened for the episode
 * itself (TabHolder.mpvReopened), which closes once read.
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
 * The page's episode links (EPISODE_LINKS), from its top frame only: the background opens one
 * later as a tab of its own, and a frame's (a hoster's, an ad's) went there in the tab's
 * container (glm's review, 2026-10-27), where goToEpisode, with the tab open, has such a frame
 * go on only within itself. A page that does not answer within MpvPagePollMs cannot tell.
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
  // Its container, which the episode's tab opens in: the same cookies, the same login. The
  // default and the private store go by the window (as the DOWNLOAD message's tab does).
  const store = await chrome.tabs.get(tab.tabId).then((info) => info?.cookieStoreId || null, () => null);
  links.cookieStoreId = store && store !== 'firefox-default' && store !== 'firefox-private' ? store : null;
  return links;
}

/**
 * The tab mpv's stream came from is closed (tabs.onRemoved): the episode links its page had
 * stay with the watch, for an end or a key to go on in a new tab (goToEpisodeInNewTab).
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
 * What the host says about the watched mpv.
 * @param {MpvWatch} state - The watch (mpvWatch).
 * @param {import('./MpvBackend.mjs').MpvWatchEvent} event - watching, path, ended, request,
 *   decoder or closed.
 */
export function onMpvWatchEvent(state, event) {
  if (event.type === 'closed') {
    state.alive = false;
    cancelMpvCountdown(state);
    if (state.stalled) clearTimeout(state.stalled);
    state.stalled = null;
    if (mpvWatch === state) mpvWatch = null;
    // mpv is gone (both watches' reasons for it): the page's next play is the user's, not
    // the player repeating itself. Within MpvPlayRepeatMs it only paused the page, and
    // closing mpv quickly left a dead click. A helper port that went while mpv plays on
    // keeps the window: a repeat would load the episode again from where the page is.
    const tab = event.reason === 'mpv closed' || event.reason === 'no mpv' ? Tabs.getTab(state.tabId) : null;
    if (tab?.mpvLastPlaySend) {
      tab.mpvLastPlaySend = null;
      Tabs.saveTabState(tab);
    }
    // A tab autoplay opened for an episode mpv no longer waits for.
    if (tab) closeReopenedTab(tab);
    if (Logging) console.log('[MPV autoplay] the watch ended:', event.reason);
    return;
  }
  if (event.type === 'watching') {
    syncMpvAutoplay(state);
  } else if (event.type === 'decoder') {
    // What the toolbar's tooltip names, for the tab whose stream mpv plays (followMpvDecoder).
    const tab = Tabs.getTab(state.tabId);
    if (tab) setMpvDecoder(tab, event.decoder);
  } else if (event.type === 'ended') {
    if (Options.mpvAutoplayNext && isSentStream(event.path, state.url, state.qualities)) {
      startMpvCountdown(state);
    }
  } else if (event.type === 'request' && (event.action === 'next' || event.action === 'previous')) {
    // A key or a button: now, whatever the countdown says.
    cancelMpvCountdown(state);
    goToEpisode(state, event.action);
  } else if (event.type === 'request' && event.action === 'autoplay') {
    toggleMpvAutoplay(state);
  } else if (event.type === 'request' && event.action === 'pause') {
    // Space at an end (his wish, 2026-10-17: the easiest key): this episode's countdown stops,
    // and autoplay stays on for the next end, which the switch would have turned off. mpv
    // stays paused on the last frame. Space during playback finds no countdown to stop.
    const counting = !!state.countdown;
    cancelMpvCountdown(state);
    if (counting) {
      state.watcher?.notify(chrome.i18n.getMessage('mpv_autoplay_title') || 'Autoplay',
          chrome.i18n.getMessage('mpv_autoplay_stopped') || 'stopped (n: next episode)');
    }
  }
}

/** How long startMpvCountdown waits for each frame of the page to answer. */
export const MpvPagePollMs = 1000;

/**
 * How long goToEpisode waits for a frame to answer its next/previous request (the content
 * script answers at once, after its click): a frame that never answered kept state.going
 * set, and every later key, button and autoplay of the session returned at it (glm's
 * review, 2026-10-12).
 */
export const MpvPageNavigateMs = 5000;

/**
 * What the page of the tab mpv's stream came from says about its next episode, asking its
 * frames top first as goToEpisode does, through PLAYLIST_POLL, which clicks nothing:
 * 'series_end' when the first frame that knows says the series ends here (no other frame is
 * asked: a hoster's links are other videos), 'next' when it has a next episode, null when no
 * frame can tell.
 * @param {TabHolder} tab
 * @return {Promise<?string>}
 */
export async function nextEpisodeInPage(tab) {
  const frameIds = tab.frames ? Array.from(tab.frames.keys()).sort((a, b) => a - b) : [];
  for (const frameId of frameIds) {
    // A frame that never answers costs a second, not the countdown (glm's review): no
    // answer is "cannot tell".
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
 * An episode ended in mpv with autoplay on: the next one after the countdown, which mpv
 * shows. Space stops it, the autoplay switch too (and autoplay with it); the next-episode
 * key or button skips it.
 *
 * The page is asked first (2026-10-12, the mpv setup's TODO): at the series' last episode
 * mpv said "next episode in 5 s", and only when the countdown ran out that autoplay stops.
 * Now it says the series ended at once, and counts down nothing. A page that cannot tell
 * counts down as before (goToEpisode then says what it finds).
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
  // A closed tab's page said it when its stream went to mpv (rememberEpisodeLinks).
  const page = tab && tab.isOn && tab.isMpv ? await nextEpisodeInPage(tab) :
    !tab && state.closedTab?.links.seriesEnd ? 'series_end' : null;
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
 * mpv's autoplay switch: flips the setting, which mpv then shows.
 * @param {MpvWatch} state
 * @return {Promise<void>}
 */
export function toggleMpvAutoplay(state) {
  // One after the other: two quick presses read the same setting before either was saved,
  // and the second was lost.
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

/** The switch presses not done yet (toggleMpvAutoplay). */
export let mpvAutoplayToggles = Promise.resolve();

/**
 * Goes on to the next (or the previous) episode in the page of the tab mpv's stream came
 * from: the page's own link, as the in-page player's next button does it, top frame first.
 * The next page's player is started if it waits for a click (startPagePlayers), and its
 * stream goes to mpv by itself, into the same window. mpv says what happens.
 * @param {MpvWatch} state - The watch (mpvWatch).
 * @param {'next'|'previous'} direction
 */
export async function goToEpisode(state, direction) {
  const title = chrome.i18n.getMessage(direction === 'next' ? 'player_next_video_label' : 'player_previous_video_label') ||
    (direction === 'next' ? 'Next video' : 'Previous video');
  const tab = Tabs.getTab(state.tabId);
  if (!tab && state.closedTab) {
    return goToEpisodeInNewTab(state, direction, title);
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
      // No other frame is asked: this one may still click, and a hoster's link after it
      // would be a second episode.
      if (answer === 'timeout') break;
      if (answer === 'clicked') {
        clicked = true;
        break;
      }
      // The page is the series' last episode (content.js isSeriesEnd): no other frame (a
      // hoster's, whose links are other videos) is asked.
      if (answer === 'series_end') {
        seriesEnd = true;
        break;
      }
    }
  } finally {
    state.going = false;
  }
  // Another tab's stream took mpv while the page was asked (watchMpvFor moves the watch to
  // it): what this page did is no longer what mpv waits for. The old tab got the next
  // episode's wait all the same, and a minute later mpv said "no stream" over the other
  // tab's video (glm's second look, 2026-10-13).
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
 * mpv's notice that the episode cannot be gone to: its tab is closed (and its page had no
 * link to it, or its window went), or not in MPV mode.
 * @param {MpvWatch} state
 * @param {string} title
 */
export function notifyEpisodeUnavailable(state, title) {
  state.watcher?.notify(title, chrome.i18n.getMessage('mpv_episode_unavailable') ||
    'its tab is closed, or not in MPV mode', MpvNoticeSeconds);
}

/**
 * goToEpisode with the tab of mpv's stream closed (his wish, 2026-10-27): the episode its page
 * linked to (rememberEpisodeLinks) opens in a new tab that is not shown, in the window and the
 * container the closed one was in, and goes on as the tab did (awaitEpisodeStream). Measured
 * in Firefox 158: such a tab loads the hoster, its player is started, and its stream is
 * asked for, while Firefox holds the page's own play() until the tab is shown. Once the stream
 * went to mpv, the tab closes again (rememberEpisodeLinks). Not when the closed tab's window
 * went with it, nor for a page whose next was a button, not a link.
 * @param {MpvWatch} state
 * @param {'next'|'previous'} direction
 * @param {string} title - mpv's notice's title.
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
  // Its window went with it; or MPV mode was switched off since (leaveMpvWhenOff), which a
  // tab still open shows by its isMpv (glm's review).
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
  // MPV, as the closed tab was: the lists by address decide nothing for it (tabs.onUpdated
  // keeps a tab that is on already). Matched by the MPV allowlist already, where it names the
  // address: its own start would send the page's first stream, an ad's maybe, beside the
  // episode's pick (glm's review).
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
 * The tab went on to the episode: its stream goes to mpv by itself (onSourceRecieved,
 * pickNextEpisodeForMpv) for a minute, its page's player is started if it waits for a click
 * (startPagePlayers), and mpv says what happens.
 * @param {MpvWatch} state
 * @param {TabHolder} tab
 * @param {string} title - mpv's notice's title.
 */
export function awaitEpisodeStream(state, tab, title) {
  tab.continuationOptions = {autoPlay: true, mpvNext: true};
  tab.mpvNextEpisodeUntil = Date.now() + MpvNextEpisodeWaitMs;
  // Not for a tab closed meanwhile: its state went back into storage (isTabOpen; glm's review).
  if (isTabOpen(tab)) Tabs.saveTabState(tab);
  state.watcher?.notify(title, chrome.i18n.getMessage('mpv_episode_loading') || 'loading in mpv',
      MpvNoticeSeconds);
  // The page gone to had its minute and brought no stream (a locked episode, a dead hoster,
  // a login wall): mpv says so, where it otherwise sat at the old episode's end in silence.
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
 * Whether the host's answer to a hand-off still belongs to the tab's page: the tab is open
 * and shows the page the stream was sent from (tab.mpvPage). A fresh mpv answers seconds
 * after the send. An answer for the page before paused the next page's video with nothing
 * sent for it, showed that page's failure or decoder on the button, and a failure opened
 * the allowlist's hand-off again, which then sent the next page's second stream as well.
 * @param {TabHolder} tab - The tab the stream was sent from.
 * @param {number} page - Its tab.mpvPage when the stream was sent.
 * @return {boolean}
 */
export function isHandOffPage(tab, page) {
  return isTabOpen(tab) && tab.mpvPage === page;
}

/**
 * Shows a failed MPV-mode hand-off on the tab's toolbar button ("!", and the reason in
 * its tooltip), or clears it after one that worked. Without it the page simply played
 * on in the browser, and nothing said why. An outdated host is kept too, for the tooltip
 * alone (no "!" since the thin helper, 2026-10-13: an older one still plays the stream):
 * it says to install the host again, as the copy a PC runs is not updated by an extension
 * update or a `git pull` (MpvBackend's RequiredHostVersion).
 * @param {TabHolder} tab - The tab the stream was sent from.
 * @param {{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean}} result -
 *   The host's answer.
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

// How long the host may wait, after a hand-off, for mpv to start decoding: a slow stream
// takes seconds to open, and until then mpv has no decoder to name.
export const MpvDecoderWaitMs = 20000;

/**
 * After a hand-off that worked, asks mpv which video decoder it plays the stream with,
 * for the toolbar button's tooltip: the hardware API, or a hint that mpv decodes in
 * software (with what to add to mpv.conf). Read-only: FastStream never overrides mpv.conf.
 * Only an mpv the host started for single-instance use has the pipe to ask over.
 * @param {TabHolder} tab - The tab the stream was sent from.
 * @param {{ok: boolean}} result - The hand-off's answer.
 */
export function followMpvDecoder(tab, result) {
  const query = {};
  tab.mpvDecoderQuery = query;
  setMpvDecoder(tab, null);
  if (!result.ok || !Mpv.singleInstance) {
    return;
  }
  // The thin helper's relay, which the watch holds open, tells the decoder as mpv loads it
  // (onMpvWatchEvent). Asked here, each second until mpv had one meant a new helper process
  // (cmd and node) every second, up to MpvDecoderWaitMs (review of 2026-10-14).
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
  // The answer takes up to MpvDecoderWaitMs, and the tab is often closed by then: the
  // stream plays in mpv now.
  if (!isTabOpen(tab) || JSON.stringify(tab.mpvDecoder ?? null) === JSON.stringify(decoder)) {
    return;
  }
  tab.mpvDecoder = decoder;
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
}

/**
 * Hands a video the user started to mpv, then pauses the page.
 *
 * The same video again within MpvPlayRepeatMs is the player repeating itself
 * (play() called twice, or resuming after pauseTabMedia), so it only pauses
 * the page again. openStream gets no tab: its per-page dedupe would swallow a
 * later, deliberate play of a video already sent (after closing mpv).
 *
 * @param {TabHolder} tab - The tab the video is in.
 * @param {{url: string, headers: *}} source - Detected source: url and request headers.
 * @param {?{time?: number, duration?: ?number}} [video] - The page's video as it played
 *   (content.js playedVideo): mpv starts where it was. It started at 0:00, and the page,
 *   paused at the user's place, kept it.
 */
export function sendPlayedToMpv(tab, source, video = null) {
  // As autoOpenInMpv: a tab closed while its stream was looked for sends nothing.
  if (!isTabOpen(tab)) {
    return;
  }
  const now = Date.now();
  const last = tab.mpvLastPlaySend;
  if (last && last.url === source.url && now - last.time < MpvPlayRepeatMs) {
    pauseTabMedia(tab.tabId);
    return;
  }

  tab.mpvLastPlaySend = {url: source.url, time: now};
  Tabs.saveTabState(tab);
  const page = tab.mpvPage;
  // Only a video of a known length (not a live one), and past its first seconds: a play
  // from the start starts at the start.
  const time = video?.time;
  const startTime = Number.isFinite(video?.duration) && typeof time === 'number' && time > 5 ? time : undefined;
  tabTitle(tab.tabId).then((title) =>
    openInMpv(tab.tabId, source.url, null, source.headers, resolveMpvContentType(null, tab.url), tab.url, title,
        {startTime})).then((result) => {
    if (Logging) console.log('[MPV] user play result:', source.url, JSON.stringify(result));
    if (!isHandOffPage(tab, page) || playHereInstead(tab, result)) {
      return;
    }
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseAfterHandOff(tab, result);
    } else if (tab.mpvLastPlaySend && tab.mpvLastPlaySend.url === source.url) {
      // The host never launched mpv, so let the next play try again.
      tab.mpvLastPlaySend = null;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    console.error('Handing the played video to mpv failed', e);
    if (isHandOffPage(tab, page)) {
      setMpvError(tab, {ok: false, error: String(e)});
    }
  });
}

/**
 * Sends the newest of the longest sources tracked on the tab to mpv via the
 * native messaging host.
 *
 * Only one source is sent. mpv opens a window per invocation, and a page
 * routinely exposes several sources (ads, previews, one per quality), so
 * sending them all would bury the user in mpv windows. An ad or a preview
 * runs for seconds, the video for minutes, and of those that tie the newest
 * is the one the page just started playing; the rest stay tracked, so the
 * player's "send to mpv" button can still reach them.
 *
 * @param {TabHolder} tab - The tab whose tracked sources should open in mpv.
 * @return {boolean} True when a source was handed to mpv.
 */
export function openMpvWithSources(tab) {
  if (!Options.mpvMode) {
    return false;
  }

  // Entering MPV mode is an explicit start, so forget what was already sent
  // for this tab. Without this the dedupe in openStream silently swallows a
  // re-entry that targets the same URL (toolbar cycled MPV -> Off -> On -> MPV).
  tab.mpvSentUrls.clear();

  const source = newestOfLongest(tabSources(tab));
  if (!source) {
    return false;
  }

  tab.mpvAutoOpened = true;
  Tabs.saveTabState(tab);
  const page = tab.mpvPage;
  tabTitle(tab.tabId).then((title) =>
    openInMpv(tab.tabId, source.url, tab, source.headers, resolveMpvContentType(null, tab.url), tab.url, title)).then((result) => {
    if (Logging) console.log('[MPV] openStream result:', source.url, JSON.stringify(result));
    if (!isHandOffPage(tab, page) || playHereInstead(tab, result)) {
      return;
    }
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseAfterHandOff(tab, result);
    } else {
      // The host never launched mpv, so let the next detected stream try.
      tab.mpvAutoOpened = false;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    console.error('Handing the stream to mpv failed', e);
    if (isHandOffPage(tab, page)) {
      setMpvError(tab, {ok: false, error: String(e)});
    }
  });
  return true;
}

/**
 * Hands a stream to mpv, unless the page's request for it went through Firefox VPN: mpv
 * runs outside Firefox, asks from the user's own address, and a site that ties its stream
 * to the VPN's refuses it ("could not open the stream", VOE, 2026-10-06). Then mpv is not
 * started, and the answer says why, where a failed hand-off shows (the toolbar button's
 * "!" and tooltip, the player's status line). After the tab, arguments as
 * MpvBackend.openStream.
 * @param {number|undefined} tabId - The tab the stream is from: whether it is a private
 *   window decides which of the VPN's hosts count (VpnProxyMirror.throughBrowserVpn).
 * @param {string} url - The stream.
 * @param {...*} rest - openStream's other arguments.
 * @return {Promise<MpvHandOff>} openStream's answer, or {ok: false, vpn: true, error}, or
 *   {ok: false, drm: true, error}, or {ok: false, pageOnly: true, error}.
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
  // The stream the page asked for: Firefox VPN is known to carry it by its host
  // (VpnProxyMirror.noteSource). A quality file taken in its place may be on a host that check
  // never saw - a hoster's get_file link, which redirects to its CDN - and it went to mpv on
  // that file's host alone (this review, 2026-10-13).
  const detected = url;
  // A file only its page gives (StreamLengths.servesWebPage): its length's read, started when it
  // was detected, tells by its first answer; one detected while the tab was off is read now.
  // Waited for alongside the reads below.
  const file = tabId !== undefined && tabId >= 0 && Tabs.getTab(tabId) ?
    tabSources(Tabs.getTab(tabId)).find((source) => source.url === detected &&
      (source.mode === PlayerModes.ACCELERATED_MP4 || source.mode === PlayerModes.DIRECT)) : null;
  if (file) {
    Lengths.probe(file);
  }
  const webPage = Lengths.servesWebPage(detected, HlsQualitiesWaitMs);
  // The page's player offers this file in other qualities too (page-qualities.js): mpv gets
  // the one the user's quality setting asks for, and the list. MPV mode sent the page's
  // default, the lowest on a film site's hoster. Not for the player's button, which sends the
  // one it plays and its own list (extras.qualities).
  if (tabId !== undefined && tabId >= 0 && !(rest[5] && 'qualities' in rest[5])) {
    const choice = await pageQualityChoice(Tabs.getTab(tabId), url);
    if (choice) {
      if (Logging && choice.url !== url) console.log('[MPV] the page\'s best quality instead:', choice.url);
      url = choice.url;
      rest[5] = {...(rest[5] || {}), qualities: choice.list};
    }
  }
  // An HLS stream: the quality its master playlist offers that the setting asks for, and the
  // list for mpv's quality menu (hlsQualityChoice). Not for the player's button either.
  if (!(rest[5] && 'qualities' in rest[5])) {
    const choice = await hlsQualityChoice(tabId !== undefined && tabId >= 0 ? Tabs.getTab(tabId) : null, url);
    if (choice) {
      if (Logging && choice.url !== url) console.log('[MPV] the HLS stream\'s best quality instead:', choice.url);
      url = choice.url;
      if (choice.list) rest[5] = {...(rest[5] || {}), qualities: choice.list};
    }
  }
  // Copy-protected (DRM, StreamLengths.isProtected): mpv has no key system either, and its
  // window stayed black where the page's player plays the video. Its manifest's read tells,
  // which started when it was detected, with the tab on; a master's tells for its variants.
  // An HLS stream's is waited for above (hlsQualityChoice) when it gives the qualities; the
  // player's button gives its own, a DASH stream none, and a stream detected while the tab
  // was off was not read: waited for here, as long.
  const tracked = tabId !== undefined && tabId >= 0 && Tabs.getTab(tabId) ?
    tabSources(Tabs.getTab(tabId)).find((source) => source.url === detected) : null;
  if (tracked && (tracked.mode === PlayerModes.ACCELERATED_HLS || tracked.mode === PlayerModes.ACCELERATED_DASH)) {
    await Lengths.settle(() => [tracked], HlsQualitiesWaitMs);
  }
  if (Lengths.isProtected(detected) || Lengths.isProtected(url)) {
    if (Logging) console.log('[MPV] not handed off, copy-protected:', url);
    return {
      ok: false,
      drm: true,
      error: chrome.i18n.getMessage('player_mpv_drm') ||
        'This video is copy-protected (DRM), and mpv cannot play it: the site\'s own player keeps it.',
    };
  }
  // Answered with a web page from anywhere but its page (abyss.to's player address, #665: the
  // page's service worker gives the video). mpv got "Video not found", and its window opened
  // and closed at once. FastStream's own player loads it through the page (PageFetch), and the
  // callers hand the tab over to it (playHereInstead).
  if (await webPage) {
    if (Logging) console.log('[MPV] not handed off, only its page loads it:', detected);
    return {
      ok: false,
      pageOnly: true,
      error: chrome.i18n.getMessage('player_mpv_page_only') ||
        'This video loads only through its page, and mpv cannot open it: FastStream plays it here.',
    };
  }
  if (VpnMirror.throughBrowserVpn(detected, incognito) || VpnMirror.throughBrowserVpn(url, incognito)) {
    if (Logging) console.log('[MPV] not handed off, Firefox VPN carries it:', url);
    return Promise.resolve({
      ok: false,
      vpn: true,
      error: chrome.i18n.getMessage('player_mpv_vpn') ||
        'Firefox VPN carries this video, and mpv cannot use it. Turn Firefox VPN off for this site and reload the page.',
    });
  }
  // The page's subtitles go with its stream, as the in-page player shows them: MPV mode sent
  // the stream alone. The player's button sends the tracks it shows (subtitles given, none
  // too), which stay its choice; a stream already sent asks nothing (openStream).
  const tabHolder = rest[0];
  const extras = rest[5];
  if (tabId !== undefined && tabId >= 0 && !(extras && 'subtitles' in extras) &&
      !tabHolder?.mpvSentUrls?.has(url)) {
    const tab = Tabs.getTab(tabId);
    const subtitles = tab ? await pageSubtitlesForMpv(tab).catch((e) => {
      console.error('Reading the subtitles of the page for mpv failed', e);
      return [];
    }) : [];
    if (subtitles.length > 0) {
      if (Logging) console.log('[MPV] subtitles of the page go along:', subtitles.map((s) => s.label));
      rest[5] = {...(extras || {}), subtitles};
    }
  }
  if (incognito) {
    // A private window's stream: mpv keeps no resume position for it (the owner's pick,
    // 2026-10-14; fs-private, MpvTarget.mjs).
    rest[5] = {...(rest[5] || {}), private: true};
  }
  const result = await Mpv.openStream(url, ...rest);
  // MPV autoplay: the mpv it went to is followed (watchMpvFor). By the tab's id: the
  // player's button and the MPV key's play pass no tab (openStream's duplicate check).
  if (result && result.ok && tabId !== undefined && tabId >= 0) {
    watchMpvFor(Tabs.getTab(tabId), url, rest[5]?.qualities || null);
  }
  return result;
}
