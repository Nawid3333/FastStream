// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {PIECE_LENGTH, STILLS_LENGTH, StreamLength} from '../player/utils/StreamLength.mjs';
import {StreamPick} from '../player/utils/StreamPick.mjs';
import {guessMediaInfo} from '../player/utils/MediaTitle.mjs';
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {Utils} from '../player/utils/Utils.mjs';
import {getAddressKey} from '../player/utils/AddressKey.mjs';
import {EnvUtils} from '../player/utils/EnvUtils.mjs';
import {desiredHeight, listForSource, pickQuality} from '../player/utils/PageQualityPick.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';
import {bufferKey, BufferStash, nearKey} from './BufferStash.mjs';
import {BufferKeepAlarm, keptBufferDisk} from './KeptBufferDisk.mjs';
import {bufferKeepMs} from '../player/options/BufferKeep.mjs';
import {pruneSessions, STALE_MS} from '../player/network/SessionPrune.mjs';
import {isLocalAddress} from './LocalAddress.mjs';
import {createMenus, linkTarget, MenuIds, updateMenus} from './ContextMenu.mjs';
import {parseCustomSourcePatterns} from './CustomSourcePatterns.mjs';
import {sanitizeDownloadFilename} from './DownloadFilename.mjs';
import {fetchFreshLink} from './FreshLink.mjs';
import {KeyShortcut} from './KeyShortcut.mjs';
import {MessageTypes} from '../player/enums/MessageTypes.mjs';
import {MpvBackend} from './MpvBackend.mjs';
import {MpvSubtitles} from './MpvSubtitles.mjs';
import {pageFetchIo} from './MpvHlsPackage.mjs';
import {MultiRegexMatcher} from './MultiRegexMatcher.mjs';
import {RuleManager} from './NetRequestRuleManager.mjs';
import {StreamLengths} from './StreamLengths.mjs';
import {sniffManifest} from './ManifestSniffer.mjs';
import {modeFromContentType} from './ManifestTypes.mjs';
import {classifyResponse, modeFromQuery, urlType, worthSniffing} from './StreamDetection.mjs';
import {relayPageFetch} from './PageFetchRelay.mjs';
import {TabTracker} from './TabTracker.mjs';
import {UrlMatchList} from './UrlMatchList.mjs';
import {VpnProxyMirror} from './VpnProxyMirror.mjs';
import {youTubeVideo} from './YouTubeVideo.mjs';
import {Mpv, MpvAllowlist, MpvNoticeSeconds, MpvPlayKnownAfterMs, MpvPlayPendingMs, autoOpenInMpv, inheritMpv, leaveMpvWhenOff, noteMpvTabClosed, onToggleMpv, openInMpv, openMpvWithSources, pausePlayerWhileAsked, pickNextEpisodeForMpv, resolveMpvContentType, sendPlayedToMpv, setMpvError, startMpv, stopMpv, syncAllMpvAutoplay} from './MpvMode.mjs';

/** @typedef {typeof import('../player/options/defaults/DefaultOptions.mjs').DefaultOptions} PlayerOptions */

// Empty until the saved options are read (loadOptions; ensureOptions waits for them).
export let Options = /** @type {PlayerOptions} */ ({});
/** @type {{customSourcePatterns?: string}} */
const OptionsCache = {};
// Each options load made both rules again, unchanged: two rule updates per save.
/** @type {Map<number, string>} */
const RedirectRulesMade = new Map();
const RedirectRuleRemoved = 'removed';

// `-domain` excludes a whole site, from the redirect of manifest links too.
export const AutoEnableList = new UrlMatchList({domainEntriesExclude: true});
export const VpnMirror = new VpnProxyMirror({
  origin: chrome.runtime.getURL(''),
  getProxyApi: () => /** @type {any} */ (chrome).proxy || null,
});

/** @return {Promise<boolean>} */
async function refreshProxyPermission() {
  let permitted = false;
  // Not in @types/chrome's list of permissions; Firefox has it (an optional one).
  const proxy = /** @type {any} */ ('proxy');
  try {
    permitted = await chrome.permissions.contains({permissions: [proxy]});
  } catch (e) {
    console.warn('Could not read the proxy permission', e);
  }
  VpnMirror.setPermitted(permitted);
  return permitted;
}
refreshProxyPermission();
chrome.permissions.onAdded.addListener(async (added) => {
  if (!added.permissions?.includes(/** @type {any} */ ('proxy'))) return;
  const permitted = await refreshProxyPermission();
  if (!permitted) return;
  // A player that offered to follow the VPN loads its source again, now through it.
  for (const tab of await BackgroundUtils.queryTabs().catch(() => [])) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, {type: MessageTypes.VPN_ALLOWED}, () => {
      BackgroundUtils.checkMessageError('vpn', true);
    });
  }
});
chrome.permissions.onRemoved.addListener(() => refreshProxyPermission());

// Guards the manual "send to mpv" button against repeat clicks.
const ManualMpvRepeatMs = 3000;
let LastManualMpvUrl = '';
let LastManualMpvTime = 0;
// A repeat click gets the first send's answer: an immediate "sent" was wrong when it failed.
/** @type {?Promise<MpvHandOff>} */
let LastManualMpvAnswer = null;

// Events can come before the options are read (install, reload): on empty options MPV mode and the lists read as off.
/** @type {?Promise<*>} */
let OptionsLoadPromise = null;
export function ensureOptions() {
  if (!OptionsLoadPromise) {
    // Firefox's word for the system first: the restored toolbar states name the mpv helper's steps for it.
    OptionsLoadPromise = EnvUtils.os().then(() => Promise.all([
      loadOptions(),
      Tabs.restoreTabStates(),
    ])).then(() => leaveMpvWhenOff()).catch((e) => {
      console.error('Loading the options failed', e);
      // The next event tries again: kept, the failure stood until the event page unloaded.
      OptionsLoadPromise = null;
    });
  }
  return OptionsLoadPromise;
}
const ExtensionVersion = chrome.runtime.getManifest().version;
// On for a temporary install (the e2e suites, web-ext run), off for an installed release.
export let Logging = false;
chrome.management.getSelf().then((self) => {
  Logging = self.installType === 'development';
}).catch(console.error);
// The quota unlimitedStorage allows, from the start: asked only here, in a top-level page (storage.md, "unlimitedStorage").
navigator.storage?.persist?.().catch(() => {});
export const Tabs = new TabTracker();
const ruleManager = new RuleManager();

// The reads go out from this background, in no tab: the header rule matches on that.
export const Lengths = new StreamLengths({
  setHeaders: (url, commands) => ruleManager.addHeaderRule(url, chrome.tabs.TAB_ID_NONE, commands),
});
export const PageSubtitles = new MpvSubtitles({
  setHeaders: (url, commands) => ruleManager.addHeaderRule(url, chrome.tabs.TAB_ID_NONE, commands),
});
/**
 * @param {?Array<{name: string, value: string}>} [headers] - The stream's request headers.
 * @return {import('./MpvHlsPackage.mjs').PackageIo}
 */
export function hlsPackageIo(headers) {
  return pageFetchIo({headers, setHeaders: (url, commands) => ruleManager.addHeaderRule(url, chrome.tabs.TAB_ID_NONE, commands)});
}
// Content scripts share the page's event loop: a busy page would hold mpv back.
export const CaptionScrapeWaitMs = 1000;
// The longest a player waits for the lengths still being read.
export const SourceLengthWaitMs = 2500;
// The page answers within milliseconds unless its scripts keep it busy.
const PlayedVideoWaitMs = 1000;
// Content scripts share the page's event loop: one that never let go held a click or a fullscreen for good.
const FrameAnswerWaitMs = 3000;
// A player's port to its page, joined to the page's frame (PageFetchRelay.mjs).
chrome.runtime.onConnect.addListener((port) => {
  relayPageFetch(port, {extensionId: chrome.runtime.id, extensionUrl: chrome.runtime.getURL(''),
    connectTab: (tabId, info) => chrome.tabs.connect(tabId, info)});
});
// content.js waits up to 10 s per track (HttpRequestTimeoutMs): a little longer.
const CaptionsAnswerWaitMs = 12000;
const PageQualitiesWaitMs = 1000;
export const HlsQualitiesWaitMs = 1500;
// The page's word comes before the video has data: the request's own headers (an Origin) may still come after it.
const LiveMediaReportWaitMs = 1000;


let CustomSourcePatternsMatcher = new MultiRegexMatcher();

BackgroundUtils.openWelcomePageOnInstall();
BackgroundUtils.forgetRemovedSettingsOnUpdate();

// After the restore, or a woken event page would reset every tab's icon to Off.
ensureOptions().then(() => BackgroundUtils.queryTabs()).then((ctabs) => {
  ctabs.forEach(/** @param {chrome.tabs.Tab} tabobj */ (tabobj) => {
    const tab = Tabs.getTabOrCreate(/** @type {number} */ (tabobj.id));
    try {
      BackgroundUtils.updateTabIcon(tab, true);
    } catch (e) {
      console.error(e);
    }
  });
}).catch((e) => console.error('Updating the tab icons failed', e));

const EmptyTabUrls = ['about:blank', 'about:home', 'about:newtab', 'about:privatebrowsing'];

let playerOpeningAttempts = 0;
// A page just loaded, or loaded again, has its video a moment later; then twice and four times as long.
const ReopenMissedFirstMs = 1000;
// A page that takes longer is the user's own by then.
const ContinuationKeepMs = 120000;
const ReopenMissedTimes = 3;
// Doubling up to the longest: a page playing a video nobody sees is asked less and less.
const ReopenMissedEveryMs = 2000;
const ReopenMissedLongestMs = 60000;
// A play the user starts tries at once, but not twice within this (one press, two events).
const ReopenOnPlayEveryMs = 500;

/**
 * playerOpening counts: the overlay iframe exists before PLAYER_LOADED sets isPlayer.
 * @param {TabHolder} tab
 * @return {boolean}
 */
function hasOrOpeningPlayer(tab) {
  for (const frame of tab.getFrames()) {
    if (frame.playerOpening || frame.isPlayer) {
      return true;
    }
  }
  return false;
}

// Each frame answers at once or not at all.
const HasPlayerTimeoutMs = 1000;

/**
 * Asks the tab when this background knows of none: a background started again knows nothing, while the player stays.
 * @param {TabHolder} tab
 * @return {Promise<boolean>}
 */
export async function tabHasPlayer(tab) {
  if (hasOrOpeningPlayer(tab)) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), HasPlayerTimeoutMs);
    chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.HAS_PLAYER}, /** @param {boolean|undefined} response */ (response) => {
      // No content script (a blank or privileged page) is a tab without a player.
      void chrome.runtime.lastError;
      clearTimeout(timer);
      resolve(response === true);
    });
  });
}

/**
 * Off means off: a play waiting for its stream is dropped, and the MPV Allowlist does not start MPV on this site again.
 * @param {TabHolder} tab
 */
export function userTurnedOff(tab) {
  tab.mpvTurnedOff = true;
  tab.mpvPlayPendingUntil = 0;
  tab.mpvPlayedVideo = null;
  tab.mpvPlayChecking = null;
}

/**
 * Listing the site is a fresh decision; an entry for another site, or a woken background with no list before, keeps the Off.
 * @param {?Array<string>} before
 */
function forgetOffsForNewEntries(before) {
  if (!before) {
    return;
  }
  const old = new UrlMatchList();
  old.setEntries(before);
  for (const tab of Tabs.tabs.values()) {
    if (tab.mpvTurnedOff && tab.url && MpvAllowlist.matches(tab.url) && !old.matches(tab.url)) {
      tab.mpvTurnedOff = false;
      Tabs.saveTabState(tab);
    }
  }
}

/**
 * toggle_player has no default key: Firefox 159 binds Ctrl+Shift+F to its own Add-ons page, and Firefox's key wins.
 * @param {chrome.tabs.Tab} tabobj
 * @param {{playerKey?: boolean}} [how]
 */
async function onClicked(tabobj, {playerKey = false} = {}) {
  await ensureOptions();

  const tab = Tabs.getTabOrCreate(/** @type {number} */ (tabobj.id));

  const hasPerms = await BackgroundUtils.checkPermissions();
  if (!hasPerms) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('perms.html'),
    }).catch((e) => console.error('Opening the permissions page failed', e));
    return;
  }

  if (tabobj.url) {
    tab.url = tabobj.url;
  }

  if (tab.url && !EmptyTabUrls.includes(tab.url)) {
    if (!BackgroundUtils.isUrlPlayerUrl(tab.url)) {
      if (playerKey && tab.isOn && tab.isMpv) {
        // MPV -> On: the user's own On, so not marked as the list's start.
        tab.isMpv = false;
        tab.mpvOnPlay = false;
        tab.regexMatched = false;
        userTurnedOff(tab);
        BackgroundUtils.updateTabIcon(tab);
        openPlayersWithSources(tab);
      } else if (!playerKey && Options.mpvMode && MpvAllowlist.matches(tab.url)) {
        if (Logging) console.log('[MPV] toolbar cycle on allowlisted URL:', tab.url);
        // Cycle MPV -> Off -> On -> MPV. An On standing in for MPV (playHereInstead) counts as MPV, or Off was never reached.
        const standIn = tab.isOn && !tab.isMpv && tab.mpvStandInPage === tab.mpvPage;
        tab.mpvStandInPage = -1;
        if (tab.isMpv || standIn) {
          // MPV -> Off
          await stopMpv(tab);
        } else if (tab.isOn) {
          // On -> MPV
          await startMpv(tab);
        } else {
          // Off -> On: the user's own On, not the list's: it stays for the tab.
          tab.isOn = true;
          tab.regexMatched = false;
          BackgroundUtils.updateTabIcon(tab);
          openPlayersWithSources(tab);
        }
      } else {
        tab.isOn = !tab.isOn;
        tab.isMpv = false;
        if (!tab.isOn) {
          userTurnedOff(tab);
        } else {
          // The user's own On, as the toolbar cycle's Off -> On: it stays for the tab.
          tab.regexMatched = false;
        }

        BackgroundUtils.updateTabIcon(tab);

        if (tab.isOn) {
          openPlayersWithSources(tab);
        } else if (await tabHasPlayer(tab) && !tab.isOn) {
          // A player still loading counts, or an Off right after On left it on the page.
          tab.resetForReload();
          chrome.tabs.reload(tab.tabId, () => BackgroundUtils.checkMessageError('reload', true)); // closed meanwhile: no unhandled error
        }
      }
    } else {
      tab.isOn = !tab.isOn;
      tab.isMpv = false;
      BackgroundUtils.updateTabIcon(tab);
    }
  } else {
    chrome.tabs.update(tab.tabId, {
      url: BackgroundUtils.getPlayerUrl(),
    }, () => {

    });
  }

  Tabs.saveTabState(tab);
}

// Not onClicked itself: the click's OnClickData would land in its second parameter.
chrome.action.onClicked.addListener((tabobj) => onClicked(tabobj));

// Firefox for Android has no commands (docs/notes/build-and-release.md, "Firefox for Android").
chrome.commands?.onCommand.addListener((command, tabobj) => {
  if (!tabobj) {
    return;
  }
  if (command === 'toggle_player') {
    onClicked(tabobj, {playerKey: true});
  } else if (command === 'toggle_mpv') {
    onToggleMpv(tabobj);
  }
});

// Made at every start: an event page's items outlive it, so the old ones go first.
const menus = /** @type {import('./ContextMenu.mjs').Menus|undefined} */ (/** @type {any} */ (chrome).menus || chrome.contextMenus);
const menuText = (/** @type {string} */ key) => chrome.i18n.getMessage(key) || key;
if (menus) {
  const menusMade = ensureOptions().then(() => createMenus(menus, menuText, !!Options.mpvMode))
      .catch((e) => console.error('The right-click menu was not made', e));

  // A right-click can be what started this background: its items are named once made anew.
  /** @type {any} */ (menus).onShown?.addListener(async (/** @type {any} */ info, /** @type {chrome.tabs.Tab} */ tabobj) => {
    await menusMade;
    await ensureOptions();
    const tab = typeof tabobj?.id === 'number' ? Tabs.getTab(tabobj.id) : null;
    await updateMenus(menus, {isOn: !!tab?.isOn, isMpv: !!tab?.isMpv, mpvMode: !!Options.mpvMode}, menuText)
        .catch((e) => console.error('The right-click menu was not updated', e));
  });

  menus.onClicked.addListener((info, tabobj) => {
    if (!tabobj || typeof tabobj.id !== 'number') {
      return;
    }
    if (info.menuItemId === MenuIds.PLAYER) {
      onClicked(tabobj, {playerKey: true});
    } else if (info.menuItemId === MenuIds.MPV) {
      onToggleMpv(tabobj);
    } else if (info.menuItemId === MenuIds.LINK_PLAYER || info.menuItemId === MenuIds.LINK_MPV) {
      // linkText: Firefox's menus only.
      openLinkIn(tabobj, info.linkUrl, info.menuItemId === MenuIds.LINK_MPV,
          /** @type {{linkText?: string}} */ (info).linkText)
          .catch((e) => console.error('Opening the link failed', e));
    }
  });
}

/**
 * FastStream on before its page loads; opened without an opener, so inheritMpv does not overwrite the choice.
 * @param {chrome.tabs.Tab} tabobj
 * A YouTube video's link goes to mpv itself, with no tab: FastStream finds no YouTube stream.
 * @param {string|undefined} linkUrl
 * @param {boolean} mpv
 * @param {string} [linkText]
 * @return {Promise<void>}
 */
async function openLinkIn(tabobj, linkUrl, mpv, linkText) {
  await ensureOptions();
  const url = linkTarget(linkUrl);
  if (!url || (mpv && !Options.mpvMode)) {
    return;
  }
  const youTube = mpv ? youTubeVideo(url) : null;
  if (youTube) {
    if (Logging) console.log('[MPV] YouTube link to mpv:', youTube.url);
    // No tab: the video is not this page's, so neither its subtitles nor its next episode go with it.
    const result = await openInMpv(-1, youTube.url, null, undefined, resolveMpvContentType(null, youTube.url),
        youTube.url, linkText, {startTime: youTube.start, private: tabobj.incognito === true});
    const tab = typeof tabobj.id === 'number' ? Tabs.getTab(tabobj.id) : null;
    // Declined in mpv: no error to show.
    if (tab && !('declined' in result)) {
      setMpvError(tab, result);
    }
    return;
  }
  if (!await BackgroundUtils.checkPermissions()) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('perms.html'),
    }).catch((e) => console.error('Opening the permissions page failed', e));
    return;
  }
  const cookieStoreId = /** @type {{cookieStoreId?: string}} */ (tabobj).cookieStoreId;
  const created = await chrome.tabs.create({
    url,
    active: true,
    ...(typeof tabobj.index === 'number' ? {index: tabobj.index + 1} : {}),
    ...(typeof tabobj.windowId === 'number' ? {windowId: tabobj.windowId} : {}),
    ...(cookieStoreId ? {cookieStoreId} : {}),
  });
  if (typeof created?.id !== 'number') {
    return;
  }
  const tab = Tabs.getTabOrCreate(created.id);
  tab.isOn = true;
  tab.isMpv = mpv;
  tab.mpvOnPlay = mpv;
  // The player chosen for it: the MPV Allowlist does not decide this site's pages again.
  if (!mpv) tab.mpvMatched = true;
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
}

/**
 * A key the page cancelled, which Firefox never ran as a shortcut; the bindings are read fresh, so a rebinding counts at once.
 * @param {import('./KeyShortcut.mjs').KeyPress} press
 * @param {chrome.tabs.Tab} tabobj
 */
async function onCancelledShortcut(press, tabobj) {
  if (!chrome.commands) return;
  const commands = await chrome.commands.getAll();
  // Firefox's word: navigator.platform says "Win32" with privacy.resistFingerprinting on.
  const isMac = (await EnvUtils.os()) === 'mac';
  const command = commands.find((c) => KeyShortcut.matches(c.shortcut || '', press, isMac));
  if (!command) {
    return;
  }
  if (Logging) console.log('[Shortcut] the page cancelled', command.shortcut, '- running', command.name);
  if (command.name === 'toggle_player') {
    onClicked(tabobj, {playerKey: true});
  } else if (command.name === 'toggle_mpv') {
    onToggleMpv(tabobj);
  }
}


chrome.tabs.onRemoved.addListener((tabid, removed) => {
  // Closed while it carried a fullscreen: the window, if it stays, goes back to its state.
  const closing = Tabs.getTab(tabid);
  if (closing?.windowStateBefore && removed && !removed.isWindowClosing) {
    restoreWindowState(closing, removed.windowId);
  }
  if (removed) noteMpvTabClosed(tabid, removed);
  Tabs.removeTab(tabid);
  VpnMirror.forgetTab(tabid);
});

// A tab a page opens takes its opener's MPV mode (inheritMpv).
chrome.tabs.onCreated.addListener(async (newTab) => {
  await ensureOptions();

  const openerTabId = newTab.openerTabId;
  if (typeof openerTabId !== 'number') return;

  const openerTab = Tabs.getTab(openerTabId);
  if (!openerTab) return;

  inheritMpv(openerTab, /** @type {number} */ (newTab.id));
});

// Address and status changes only: title and favicon changes kept the event page awake; Firefox resets the button per document.
BackgroundUtils.onTabUpdated(async (tabid, changeInfo, tabobj) => {
  await ensureOptions();

  const tab = Tabs.getTabOrCreate(tabid);

  if (changeInfo.url) {
    const url = new URL(changeInfo.url);
    const oldURL = tab.url ? new URL(tab.url) : null;
    if (oldURL && oldURL.hostname !== url.hostname) {
      // The next episode's instructions go along to the page FastStream went to by itself, also on another site.
      const next = tab.continuationOptions && !tab.continuationOptions.mpvNext ?
        {options: tab.continuationOptions, arrived: tab.continuationArrived, page: tab.continuationPage} : null;
      // Keeps the new site's page when it named itself first (TabHolder.resetForNewSite).
      tab.resetForNewSite(changeInfo.url);
      if (next) {
        tab.continuationOptions = next.options;
        tab.continuationArrived = next.arrived;
        tab.continuationPage = next.page;
      }
      // A different site is a fresh decision: mpvMatched and the user's Off go. Not from an empty tab (openLinkIn).
      if (!EmptyTabUrls.includes(oldURL.href)) {
        tab.mpvMatched = false;
        tab.mpvTurnedOff = false;
      }
    }

    // Only the fragment changed: the same page, whose player plays on.
    const samePage = BackgroundUtils.isSamePageUrlChange(tab.url, changeInfo.url);
    tab.url = changeInfo.url;

    if (!samePage) {
      // The instructions are for the first page frame 0 names after the click; a page after that is the user's own (noteContinuationPage).
      if (tab.continuationOptions && !tab.continuationOptions.mpvNext) {
        if (!tab.continuationArrived) {
          tab.continuationArrived = true;
          // The next page can name itself before its address comes (resetForNewSite).
          const zero = tab.getFrame(0);
          tab.continuationPage = zero?.documentKey && zero.url === changeInfo.url ? zero.documentKey : null;
        } else if (tab.continuationPage === null || tab.getFrame(0)?.documentKey !== tab.continuationPage) {
          tab.continuationOptions = null;
        }
      }
      // A carried fullscreen goes on only into the next episode; any other page gets the window as it was.
      if (tab.windowStateBefore) {
        if (tab.continuationOptions?.fullscreenState === 'fullscreen') {
          tab.carryAwaited = true;
          tab.carriedFullscreenFrameId = null;
        } else {
          tab.carryAwaited = false;
          tab.carriedFullscreenFrameId = null;
          restoreWindowState(tab, tabobj.windowId);
        }
      }
      // The auto-open latch is per page: a second episode on the same site would find it set.
      tab.mpvPage++;
      tab.mpvAutoOpened = false;
      tab.mpvSentUrls.clear();
      tab.mpvError = null;
      tab.mpvHostOutdated = false;
      tab.mpvDecoder = null;
      tab.mpvPlayPendingUntil = 0;
      tab.mpvPlayedVideo = null;
      tab.mpvPlayChecking = null;
      // The page before's copy-protected video, not this one's (hasVideoSource).
      tab.protectedVideo = false;
      tab.playerNotice = null;
      clearTimeout(tab.urlStartTimer);

      chrome.tabs.sendMessage(tabid, {
        type: MessageTypes.REMOVE_PLAYERS,
      }, {
        frameId: 0,
      }, () => {
        // Often before the next page's content script runs: no players there to remove.
        BackgroundUtils.checkMessageError('remove_players', true);
      });
    }

    const shouldAutoEnable = AutoEnableList.matches(changeInfo.url);

    const isPlayerUrl = BackgroundUtils.isUrlPlayerUrl(tab.url);
    const mpvSite = !!Options.mpvMode && MpvAllowlist.matches(tab.url);
    if (Logging) console.log('[MPV] check:', tab.url, 'mpvMode:', !!Options.mpvMode, 'mpvSite:', mpvSite);

    if (isPlayerUrl) {
      tab.isOn = true;
      tab.regexMatched = true;
      // The player page has no MPV mode.
      tab.isMpv = false;
      tab.mpvOnPlay = false;
    } else if (mpvSite && !tab.mpvMatched && !tab.mpvTurnedOff) {
      if (Logging) console.log('[MPV] auto-start on allowlisted URL:', tab.url);
      tab.regexMatched = true;
      tab.mpvMatched = true;
      tab.isOn = true;
      tab.isMpv = true;
      // The allowlist's own rule, even if the shortcut armed this tab.
      tab.mpvOnPlay = false;
      // MPV autoplay's next episode on another site is pickNextEpisodeForMpv's.
      startWithTrackedLater(tab, changeInfo.url, () => tab.isMpv && !tab.mpvOnPlay && !tab.mpvAutoOpened &&
          !(tab.mpvNextEpisodeUntil > Date.now()), () => openMpvWithSources(tab));
    } else if (shouldAutoEnable && !tab.regexMatched && !tab.isOn) {
      // Not for a tab the user turned on: their choice for the tab outranks the standing list.
      tab.regexMatched = true;
      tab.isOn = true;
      tab.isMpv = mpvSite && !tab.mpvTurnedOff;
      tab.mpvOnPlay = false;
      if (tab.isMpv) {
        startWithTrackedLater(tab, changeInfo.url, () => tab.isMpv && !tab.mpvOnPlay && !tab.mpvAutoOpened,
            () => openMpvWithSources(tab));
      } else {
        startWithTrackedLater(tab, changeInfo.url, () => !tab.isMpv,
            (foundBefore) => openPlayersWithSources(tab, foundBefore));
      }
    } else if (!shouldAutoEnable && !mpvSite && tab.regexMatched) {
      tab.isOn = false;
      tab.isMpv = false;
      tab.regexMatched = false;
      tab.mpvMatched = false;
    }

    Tabs.saveTabState(tab);
  }

  BackgroundUtils.updateTabIcon(tab, true);
}, ['url', 'status']);

const UrlStartSettleMs = 500;

/**
 * Waits for the new page to name itself: tabs.onUpdated can come before its FRAME_ADDED, and the page before's trailer went to mpv.
 * @param {TabHolder} tab
 * @param {string} url
 * @param {() => boolean} stillWanted
 * @param {(foundBefore: number) => *} start
 */
function startWithTrackedLater(tab, url, stillWanted, start) {
  // A change after the # only is the same page: it goes on.
  const changedAt = Date.now();
  tab.urlStartTimer = setTimeout(() => {
    const samePage = tab.url === url || BackgroundUtils.isSamePageUrlChange(url, tab.url);
    if (Tabs.getTab(tab.tabId) === tab && samePage && tab.isOn && stillWanted()) {
      start(changedAt);
    }
  }, UrlStartSettleMs);
}

/**
 * @param {chrome.runtime.MessageSender} sender
 * @return {boolean}
 */
function fromOwnPage(sender) {
  return String(sender.url || '').startsWith(chrome.runtime.getURL(''));
}

// Who may send each message: 'own' is FastStream's own pages only, 'any' its content scripts too (backgroundMessages.test.mjs).
/** @type {Object<string, 'own'|'any'>} */
export const MessageSenders = {
  [MessageTypes.PING]: 'own',
  [MessageTypes.VPN_STATUS]: 'own',
  [MessageTypes.VPN_OPEN_PERMISSION]: 'own',
  [MessageTypes.OPEN_EXTERNAL_URL]: 'own',
  [MessageTypes.LOAD_OPTIONS]: 'own',
  [MessageTypes.MPV_TEST]: 'own',
  [MessageTypes.MPV_OPEN]: 'own',
  [MessageTypes.PLAYER_LOADED]: 'own',
  [MessageTypes.PLAYER_PLAYING]: 'own',
  [MessageTypes.REQUEST_FRESH_LINK]: 'own',
  [MessageTypes.BUFFER_STASH]: 'own',
  [MessageTypes.BUFFER_TAKE]: 'own',
  [MessageTypes.BUFFER_LENT]: 'own',
  [MessageTypes.REQUEST_SOURCES]: 'own',
  [MessageTypes.CLEAR_SOURCES]: 'own',
  [MessageTypes.SET_HEADERS]: 'own',
  [MessageTypes.DOWNLOAD]: 'own',
  [MessageTypes.REQUEST_FULLSCREEN]: 'own',
  [MessageTypes.REQUEST_WINDOWED_FULLSCREEN]: 'own',
  [MessageTypes.REQUEST_KEYBOARD]: 'own',
  [MessageTypes.REQUEST_WINDOW_FULLSCREEN]: 'own',
  [MessageTypes.REQUEST_MINIPLAYER]: 'own',
  [MessageTypes.REQUEST_PLAYLIST_NAVIGATION]: 'own',
  [MessageTypes.REQUEST_PLAYLIST_POLL]: 'own',
  [MessageTypes.PAGE_QUALITY_PROBE]: 'own',
  [MessageTypes.PAGE_QUALITY_SELECT]: 'own',
  [MessageTypes.MPV_USER_PLAY]: 'any',
  [MessageTypes.SHORTCUT_CANCELLED]: 'any',
  [MessageTypes.FRAME_ADDED]: 'any',
  [MessageTypes.FRAME_REMOVED]: 'any',
  [MessageTypes.PLAYER_OPEN_GONE]: 'any',
  [MessageTypes.LOADED_MEDIA]: 'any',
  [MessageTypes.DETECTED_SOURCE]: 'any',
  [MessageTypes.SEND_TO_PLAYER]: 'any',
  [MessageTypes.EXIT_CARRIED_FULLSCREEN]: 'any',
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (MessageSenders[msg?.type] === 'own' && !fromOwnPage(sender)) {
    return;
  }
  if (msg.type === MessageTypes.PING) {
    sendResponse(MessageTypes.PONG);
    // A player this background did not see load is counted here too (restorePlayerFrame), once the tab state is back.
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') {
      ensureOptions().then(() => {
        const tab = /** @type {TabHolder & TabExtras} */ (Tabs.getTabOrCreate(tabId));
        restorePlayerFrame(tab, /** @type {FrameHolder & FrameExtras} */ (tab.getFrameOrCreate(/** @type {number} */ (sender.frameId))), sender);
      }).catch((e) => console.error(e));
    }
    return;
  } else if (msg.type === MessageTypes.VPN_STATUS) {
    // Own pages only: the answer adds the URL's host to those that follow the VPN.
    sendResponse(VpnMirror.status(String(msg.url || ''), !!sender.tab?.incognito, sender.tab?.id));
    return;
  } else if (msg.type === MessageTypes.VPN_OPEN_PERMISSION) {
    // A player in a page has no permissions API: the permissions page asks, in a tab of its own.
    /** @type {chrome.tabs.CreateProperties} */
    const create = {url: chrome.runtime.getURL('perms.html') + '#proxy'};
    if (sender.tab?.id !== undefined) {
      create.openerTabId = sender.tab.id;
      create.index = sender.tab.index + 1;
    }
    chrome.tabs.create(create).catch((e) => console.error('Opening the permissions page failed', e));
    sendResponse(true);
    return;
  } else if (msg.type === MessageTypes.OPEN_EXTERNAL_URL) {
    // A player framed in a page has no chrome.tabs. Web pages only: tabs.create opens extension pages too. No opener: the tab takes no MPV mode from the page's (inheritMpv).
    let url = null;
    try {
      url = new URL(String(msg.url));
    } catch (e) {
      // No address at all.
    }
    let asker = null;
    try {
      asker = new URL(String(sender.url));
    } catch (e) {
      // No sender's address.
    }
    const fromOwnPage = !!asker && ['player/index.html', 'player/options/index.html']
        .some((page) => `${asker.protocol}//${asker.host}${asker.pathname}` === chrome.runtime.getURL(page));
    if (!url || !/^https?:$/.test(url.protocol) || !fromOwnPage) {
      sendResponse(false);
      return;
    }
    chrome.tabs.create({url: url.href}).catch((e) => console.error('Opening a page for the player failed', e));
    sendResponse(true);
    return;
  } else if (msg.type === MessageTypes.LOAD_OPTIONS) {
    // The allowlist as this background had it, when it had one (none yet right after a wake).
    const allowlistBefore = Array.isArray(Options.mpvAllowlist) ? Options.mpvAllowlist : null;
    loadOptions().then(() => {
      leaveMpvWhenOff();
      forgetOffsForNewEntries(allowlistBefore);
      // mpv's autoplay switch shows the setting the options page just changed.
      syncAllMpvAutoplay();
    }).catch((e) => console.error('Loading the new options failed', e))
        // Answered once in effect: a page the sender opened at once was checked against the old allowlist.
        .finally(() => sendResponse(true));
    sendOptionsToTabs(msg.time);
    return true;
  } else if (msg.type === MessageTypes.MPV_TEST) {
    // Once the options are read: the ping went without the user's mpv path.
    ensureOptions().then(() => Mpv.testConnection()).then(async (result) => {
      // And, when an mpv this host started is open, which decoder it plays with.
      if (result.ok && result.mpv) {
        const status = await Mpv.decoderStatus(0);
        if (status.ok && status.running && status.decoder) {
          return {...result, decoder: status.decoder, decoderText: MpvBackend.describeDecoder(status.decoder)};
        }
      }
      return result;
    }).then((result) => {
      sendResponse(result);
    }).catch((e) => sendResponse({ok: false, error: String(e)}));
    return true;
  } else if (msg.type === MessageTypes.MPV_OPEN) {
    // Repeat clicks within ManualMpvRepeatMs are swallowed: each would open its own mpv window. Player only: it names what the helper gets.
    if (Logging) console.log('[MPV] MPV_OPEN request:', msg.url);
    const now = Date.now();
    if (msg.url === LastManualMpvUrl &&
        now - LastManualMpvTime < ManualMpvRepeatMs && LastManualMpvAnswer) {
      if (Logging) console.log('[MPV] MPV_OPEN repeat click: the first one\'s answer');
      LastManualMpvAnswer.then(sendResponse).catch((e) => console.error(e));
      return true;
    }
    LastManualMpvUrl = msg.url;
    LastManualMpvTime = now;

    // The player's headers lack User-Agent: without the browser's own, mpv says "libmpv" to the CDN.
    /** @type {Array<{name: string, value: string}>} */
    const headers = Array.isArray(msg.headers) ? msg.headers.slice() : [];
    if (!headers.some((h) => h && /^user-agent$/i.test(h.name))) {
      headers.push({name: 'User-Agent', value: navigator.userAgent});
    }

    LastManualMpvAnswer = ensureOptions().then(() => openInMpv(sender.tab?.id, msg.url, null, headers,
        resolveMpvContentType(msg.contentType, sender.tab && sender.tab.url), sender.tab && sender.tab.url,
        sender.tab && sender.tab.title, {
          startTime: msg.startTime, subtitles: msg.subtitles,
          // Given either way, so openInMpv sends the one the player plays.
          qualities: Array.isArray(msg.qualities) ? msg.qualities : null,
          whileAsked: pausePlayerWhileAsked(sender),
        })).then((result) => {
      if (Logging) console.log('[MPV] MPV_OPEN result:', JSON.stringify(result));
      if (!result.ok) {
        LastManualMpvTime = 0;
      }
      return result;
    }).catch((e) => {
      // As a launch that failed: the player waits for an answer, and may try again at once.
      console.error('Sending the stream to mpv failed', e);
      LastManualMpvTime = 0;
      return {ok: false, error: String(e)};
    });
    // Never rejects (the catch above answers); the player may have gone meanwhile.
    LastManualMpvAnswer.then(sendResponse).catch((e) => console.error(e));
    return true;
  } else if (msg.type === MessageTypes.MPV_USER_PLAY) {
    const play = () => onUserPlay(sender, typeof msg.src === 'string' ? msg.src : '', msg.video || null,
        typeof msg.page === 'string' ? msg.page : '');
    if (msg.pressedHere === false) {
      pressedAbove(sender, msg.playedAt, msg.documentStart).then((pressed) => {
        if (pressed) play();
      }).catch((e) => console.error('Asking the frames above for a press failed', e));
      return;
    }
    play();
    reopenOnUserPlay(sender);
    return;
  } else if (msg.type === MessageTypes.SHORTCUT_CANCELLED) {
    if (sender.tab && typeof msg.key === 'string' && typeof msg.code === 'string') {
      onCancelledShortcut(msg, sender.tab);
    }
    return;
  }

  // An extension page outside any tab sends none of the messages below.
  const senderTab = sender.tab;
  if (!senderTab) {
    return;
  }
  const tab = /** @type {TabHolder & TabExtras} */ (Tabs.getTabOrCreate(/** @type {number} */ (senderTab.id)));
  const frame = /** @type {FrameHolder & FrameExtras} */ (tab.getFrameOrCreate(/** @type {number} */ (sender.frameId)));
  restorePlayerFrame(tab, frame, sender);

  if (msg.type === MessageTypes.PLAYER_LOADED) {
    const opener = playerOpener(msg.url || sender.url);
    if (tab.isPlayerOfGoneDocument(frame, msg.parentFrameId, opener)) {
      if (Logging) console.log('Ignoring a player whose page is gone', frame);
      tab.forgetFrame(frame);
      sendResponse(null);
      return;
    }
    if (!frame.parent && msg.parentFrameId !== undefined) {
      // Taken on trust, a page framing the player page could make any frame hold a player.
      isPlayerParentProven(tab, frame, msg.parentFrameId, opener).then((proven) => {
        // Or gone while its page was asked: accepted, every later stream of the page was dropped as the player's.
        if (!proven || !frame.isTracked()) {
          if (Logging) console.log('Ignoring a player whose page did not open it, or that is gone', frame);
          tab.forgetFrame(frame);
          // Its page's opening is over with it: left set, that frame opened no player again.
          const page = proven ? tab.getFrame(msg.parentFrameId) : null;
          if (page?.playerOpening && !page.hasPlayer()) {
            page.playerOpening = false;
            noteOpenMissed(page, 'gone');
          }
          sendResponse(null);
          return;
        }
        frame.setParentFrame(tab.getFrameOrCreate(msg.parentFrameId));
        acceptPlayer(tab, frame, sender, sendResponse);
      }).catch((e) => {
        // The player waits for an answer; without a proof it is no page's player.
        console.error('Checking the page of a player failed', e);
        tab.forgetFrame(frame);
        sendResponse(null);
      });
      return true;
    }
    acceptPlayer(tab, frame, sender, sendResponse);
    return true;
  } else if (msg.type === MessageTypes.FRAME_ADDED) {
    // Sources this frame already has for its new URL (Vimeo, via onHeadersReceived) survive the reset.
    const preservedSources = frame.getSources().filter((s) => s.url === msg.url);
    const documentKey = typeof msg.document === 'string' ? msg.document : null;

    // The page the frame showed is gone, whether or not its FRAME_REMOVED came first.
    tab.noteDocumentReplaced(frame, documentKey);

    const playerCount = frame.resetSelfAndChildren();
    frame.url = msg.url;
    frame.documentKey = documentKey;

    preservedSources.forEach((s) => {
      frame.getSources().push(s);
    });
    // A page back from the back-forward cache fetches nothing: what it had detected is kept for it, and nothing opens.
    tab.restoreGoneDocument(frame);

    tab.playerCount -= playerCount;
    tab.playerCount = Math.max(0, tab.playerCount);
    checkURLMatch(frame);
    // A page loaded while a player plays holds its media too.
    if (tab.playingPlayers.size > 0) {
      sendPageMediaHold(tab);
    }
    if (frame.frameId === 0 && documentKey) {
      noteContinuationPage(tab, documentKey);
    }
    if (tab.continuationOptions?.autoPlay) {
      startPagePlayers(tab);
    }
    // A fullscreen carried to this page that no player took over yet: Escape here ends it.
    if (frame.frameId === 0 && tab.carryAwaited) {
      tellPageCarried(tab, true);
    }
  } else if (msg.type === MessageTypes.FRAME_REMOVED) {
    const removed = msg.frameId !== undefined ? tab.getFrame(msg.frameId) : frame;
    const going = removed ? frameAndInside(removed) : [];
    if (removed) releaseOverlayGuards(tab, removed);
    // The players among them whose page stays (read now: forgetting a frame empties it).
    const lonePlayers = going.filter((gone) => gone.isPlayer && gone.parent && !going.includes(gone.parent))
        .map((player) => ({player, page: /** @type {FrameHolder} */ (player.parent)}));
    tab.forgetRemovedFrame(removed, msg.document);
    // A player gone while its page stays: a play the user starts there opens it again.
    for (const {player, page} of lonePlayers) {
      if (tab.getFrame(player.frameId) !== player && tab.getFrame(page.frameId) === page && !page.hasPlayer()) {
        page.openMissed = Math.max(page.openMissed, 1);
        page.openGone = true;
      }
    }
    // A player's FRAME_REMOVED may come after its page's; a gone next-episode page ends its instructions whatever comes next.
    if (removed && removed.frameId === 0 && tab.getFrame(0) !== removed && typeof msg.document === 'string' &&
        tab.continuationPage === msg.document && tab.continuationArrived &&
        tab.continuationOptions && !tab.continuationOptions.mpvNext) {
      endContinuation(tab);
    }
    let wasPlaying = false;
    let keptChanged = false;
    for (const gone of going) {
      if (tab.getFrame(gone.frameId) === gone) continue; // a late message: the frame shows a newer page
      wasPlaying = tab.playingPlayers.delete(gone.frameId) || wasPlaying;
      if (gone.frameId in tab.playerPageFrames) {
        delete tab.playerPageFrames[gone.frameId];
        keptChanged = true;
      }
    }
    if (keptChanged) Tabs.saveTabState(tab);
    // Also one this background no longer knew to be playing (it was started again).
    if (wasPlaying || BackgroundUtils.isUrlPlayerUrl(sender.url || '')) {
      sendPageMediaHold(tab);
    }
  } else if (msg.type === MessageTypes.PLAYER_PLAYING) {
    // Only FastStream's player page says so; a page cannot send the background messages.
    if (BackgroundUtils.isUrlPlayerUrl(sender.url || '')) {
      if (msg.playing === true) {
        tab.playingPlayers.add(frame.frameId);
      } else {
        tab.playingPlayers.delete(frame.frameId);
      }
      sendPageMediaHold(tab);
    }
  } else if (msg.type === MessageTypes.PAGE_QUALITY_PROBE || msg.type === MessageTypes.PAGE_QUALITY_SELECT) {
    // To the page frame the player's source came from: the one the player is in. What the page loads for a quality
    // it switches to is no new stream: a frame with a player is not watched (onHeadersReceived).
    const page = typeof msg.frameId === 'number' ? tab.getFrame(msg.frameId) : null;
    if (!BackgroundUtils.isUrlPlayerUrl(sender.url || '') || !page || page.isPlayer ||
        (page !== frame.parent && page !== frame.pageFrame)) {
      sendResponse(null);
      return;
    }
    const request = msg.type === MessageTypes.PAGE_QUALITY_SELECT ?
      {type: msg.type, id: msg.id, index: msg.index} :
      {type: msg.type, url: msg.url, playerFrameId: frame.frameId};
    chrome.tabs.sendMessage(tab.tabId, request, {frameId: page.frameId}, (answer) => {
      BackgroundUtils.checkMessageError('page_quality');
      sendResponse(answer ?? null);
    });
    return true;
  } else if (msg.type === MessageTypes.REQUEST_FRESH_LINK) {
    // Not in a private window or a container: the background's fetch goes with the normal window's cookies and proxy.
    const store = senderTab.cookieStoreId;
    if (!BackgroundUtils.isUrlPlayerUrl(sender.url || '') || typeof msg.url !== 'string' ||
        senderTab.incognito || (store && store !== 'firefox-default')) {
      sendResponse(null);
      return;
    }
    fetchFreshLink(freshLinkPages(tab, frame, msg.url), msg.url).then(sendResponse, (e) => {
      console.warn('No new link for a refused stream', e);
      sendResponse(null);
    });
    return true;
  } else if (msg.type === MessageTypes.BUFFER_STASH) {
    // For the page BUFFER_TAKE told it: by now the page's frame is the next page's.
    const key = BackgroundUtils.isUrlPlayerUrl(sender.url || '') ? playerBufferKey(msg.page, sender, msg.identifier) : null;
    if (key && typeof msg.url === 'string' && Array.isArray(msg.entries)) {
      const handOff = {
        url: msg.url,
        session: typeof msg.session === 'string' && /^[\w-]+$/.test(msg.session) ? msg.session : null,
        entries: msg.entries,
      };
      // A private window's and "RAM only"'s stay in RAM (BufferKeep.mjs): nothing of them reaches the disk.
      ensureOptions().then(() => {
        const ramOnly = !!senderTab?.incognito || Options.bufferToDisk === false;
        const near = typeof msg.near === 'string' && msg.near ? playerNearKey(msg.near, sender) : null;
        bufferStash.put(key, handOff, bufferKeepMs(Options.bufferKeep, ramOnly), {ramOnly, near});
      }).catch((e) => console.warn('Could not keep a handed-over buffer', e));
    }
  } else if (msg.type === MessageTypes.BUFFER_TAKE) {
    const page = (frame.parent || frame).url;
    const key = BackgroundUtils.isUrlPlayerUrl(sender.url || '') ? playerBufferKey(page, sender, msg.identifier) : null;
    if (!key) {
      sendResponse(null);
      return;
    }
    // The tab's page: where a buffer is looked for when the hoster's frame or the stream's link came anew in another
    // form; one under another link is lent, the taker checks its data first and says so (BUFFER_LENT).
    const near = tab.url || '';
    // After the options, as BUFFER_STASH's put: a hand-off just made is there.
    ensureOptions().then(async () => {
      const own = await bufferStash.take(key);
      if (own || !near || typeof msg.url !== 'string') return {handOff: own, lent: null};
      return await bufferStash.lendNear(playerNearKey(near, sender), msg.url, `${tab.tabId}/${frame.frameId}`, key) ??
        {handOff: null, lent: null};
    }).then(({handOff, lent}) => sendResponse({page, near, handOff, ...(lent ? {lent} : {})}), (e) => {
      console.warn('Could not take back a handed-over buffer', e);
      sendResponse({page, near, handOff: null});
    });
    return true;
  } else if (msg.type === MessageTypes.BUFFER_LENT) {
    // The word of the player a buffer was lent to: its video's, or back in the stash for its own.
    sendResponse(BackgroundUtils.isUrlPlayerUrl(sender.url || '') && typeof msg.lent === 'number' &&
      bufferStash.endLend(msg.lent, msg.same === true, `${tab.tabId}/${frame.frameId}`));
    return;
  } else if (msg.type === MessageTypes.PLAYER_OPEN_GONE) {
    // The page took the player iframe out before it loaded: no PLAYER_LOADED will end the opening.
    if (frame.playerOpening && frame.playerOpeningAttempt === msg.attempt) {
      frame.playerOpening = false;
      // Not tried again by itself: the page took the player out, and would again.
      noteOpenMissed(frame, 'gone');
    }
  } else if (msg.type === MessageTypes.REQUEST_SOURCES) {
    sendSources(frame);
  } else if (msg.type === MessageTypes.LOADED_MEDIA) {
    if (msg.live) {
      // Only by the page that told it, still shown; a background started again since has no name for it yet (recoverFrameSources).
      const unnamed = !frame.documentKey;
      setTimeout(() => {
        if (frame.isTracked() && (frame.documentKey === msg.document || (unnamed && !frame.documentKey))) {
          recoverFrameSources(frame, msg);
        }
      }, LiveMediaReportWaitMs);
    } else {
      recoverFrameSources(frame, msg);
    }
  } else if (msg.type === MessageTypes.CLEAR_SOURCES) {
    // The player's list only mirrors this background's stores, which push it again: clear them all, and what was handed (handedTo).
    for (const f of tab.getFrames()) {
      f.getSources().length = 0;
      f.forgetHandedToPlayer();
    }
    // Other tabs' streams too: those they hold now stay cleared here.
    tab.clearedSources = new WeakSet();
    for (const other of Tabs.tabs.values()) {
      for (const f of other.getFrames()) {
        for (const found of [...f.getSources(), ...f.getSubtitles()]) tab.clearedSources.add(found);
      }
    }
    sendResponse('cleared');
    return;
  } else if (msg.type === MessageTypes.SET_HEADERS) {
    if (msg.commands.length) {
      // A tab that sends a message has an id. The rule's lifetime is capped (RuleEntry).
      ruleManager.addHeaderRule(msg.url, /** @type {number} */ (senderTab.id), msg.commands, msg.lifetimeMs).then((rule) => {
        if (Logging) console.log('Added rule', msg, rule);
        sendResponse();
      }).catch((e) => {
        // Answered all the same: unanswered, the player's request failed.
        console.warn('Header rule refused', e);
        sendResponse();
      });
      return true;
    }
  } else if (msg.type === MessageTypes.DETECTED_SOURCE) {
    const mode = BackgroundUtils.detectedSourceMode(msg);
    if (mode) {
      const headers = msg.headers || {};
      onSourceRecieved({
        url: msg.url,
        requestId: -1,
        customHeaders: headers,
      }, frame, mode);
    }
  } else if (msg.type === MessageTypes.DOWNLOAD) {
    const url = msg.url;
    const filename = sanitizeDownloadFilename(msg.filename);
    if (senderTab.cookieStoreId && senderTab.cookieStoreId !== 'firefox-default') {
      chrome.tabs.create({
        url: BackgroundUtils.getPlayerUrl(),
        // The playing tab's window: Firefox refuses a private or container cookie store in another kind of window.
        windowId: senderTab.windowId,
        cookieStoreId: senderTab.cookieStoreId,
        active: false,
      }, (tabobj2) => {
        void chrome.runtime.lastError; // refused: answered below, no unchecked error
        if (!tabobj2) {
          sendResponse(null);
          return;
        }
        const tab2 = Tabs.getTabOrCreate(/** @type {number} */ (tabobj2.id));
        // Answered once: by the player's HANDLE_DOWNLOAD answer, or by the timeout below.
        let answered = false;
        const answer = /** @param {boolean|null|undefined} value - The player's answer (true: its download started), or null. */ (value) => {
          if (answered) return false;
          answered = true;
          sendResponse(value);
          return true;
        };
        tab2.downloadInfo = {
          url: url,
          filename: filename,
          resolve: answer,
        };
        // The hidden tab's player may never load or answer: the caller would hang.
        setTimeout(() => {
          if (answer(null)) {
            tab2.downloadInfo = null;
            chrome.tabs.remove(/** @type {number} */ (tabobj2.id)).catch(() => {});
          }
        }, 30000);
      });
    } else {
      chrome.downloads.download({
        url: url,
        filename: filename,
      }).then((downloadId) => {
        sendResponse(downloadId);
      }).catch((e) => {
        // false: the user cancelled the Save As dialog Firefox showed ("Download canceled by
        // the user"); null: Firefox refused the download.
        sendResponse(/cancell?ed by the user/i.test(String(e?.message)) ? false : null);
      });
    }
    return true;
  } else if (msg.type === MessageTypes.SEND_TO_PLAYER) {
    const pframe = tab.getFrame(msg.frameId);
    if (!pframe || !pframe.isPlayer) {
      sendResponse(null);
      return;
    }

    chrome.tabs.sendMessage(pframe.tab.tabId, {
      type: MessageTypes.MESSAGE_FROM_PAGE,
      data: msg.data,
    }, {
      frameId: pframe.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('message_from_page');

      sendResponse(response);
    });
    return true;
  } else if (msg.type === MessageTypes.REQUEST_FULLSCREEN) {
    return handleFullscreenRequest(frame, msg, sendResponse);
  } else if (msg.type === MessageTypes.REQUEST_WINDOWED_FULLSCREEN) {
    return handleWindowedFullscreenRequest(frame, msg, sendResponse);
  } else if (msg.type === MessageTypes.REQUEST_KEYBOARD) {
    // Unless the user types in the page or looks elsewhere (content.js PAGE_TYPING).
    chrome.tabs.sendMessage(frame.tab.tabId, {type: MessageTypes.PAGE_TYPING}, {frameId: 0}, (typing) => {
      void chrome.runtime.lastError;
      sendResponse(typing === false);
    });
    return true;
  } else if (msg.type === MessageTypes.REQUEST_WINDOW_FULLSCREEN) {
    setCarriedFullscreen(frame, !!msg.force).then(sendResponse, (e) => {
      console.error('The window\'s fullscreen failed', e);
      sendResponse('error');
    });
    return true;
  } else if (msg.type === MessageTypes.EXIT_CARRIED_FULLSCREEN) {
    // Escape in the page: the player that carried the fullscreen ends it; one that never took it over leaves it here.
    const tab = frame.tab;
    const playerFrameId = tab.carriedFullscreenFrameId;
    const endHere = () => {
      tab.carryAwaited = false;
      tab.carriedFullscreenFrameId = null;
      tellPageCarried(tab, false);
      chrome.tabs.get(tab.tabId).then((t) => restoreWindowState(tab, t.windowId), () => {});
    };
    if (tab.carryAwaited || typeof playerFrameId !== 'number') {
      endHere();
    } else {
      // A player whose frame went answers nothing, a new one false: ended here then.
      chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.EXIT_CARRIED_FULLSCREEN}, {frameId: playerFrameId}, (ended) => {
        if (chrome.runtime.lastError || ended !== true) endHere();
      });
    }
    return;
  } else if (msg.type === MessageTypes.REQUEST_MINIPLAYER) {
    return handleMiniplayerRequest(frame, msg, sendResponse);
  } else if (msg.type === MessageTypes.REQUEST_PLAYLIST_NAVIGATION) {
    // Once the tab state is back: the end's request often wakes the event page.
    ensureOptions().then(() => {
      restorePlayerFrame(tab, frame, sender);
      const pageFrame = frame.pageFrame;
      // A player in the top frame has no page around it.
      if (!pageFrame || frame.frameId === 0) {
        sendResponse('error');
        return;
      }

      chrome.tabs.sendMessage(pageFrame.tab.tabId, {
        type: MessageTypes.PLAYLIST_NAVIGATION,
        direction: msg.direction,
      }, {
        frameId: pageFrame.frameId,
      }, (response) => {
        BackgroundUtils.checkMessageError('playlist_navigation');
        if (response === 'clicked') {
          const continuation = msg.continuationOptions;
          tab.continuationOptions = continuation;
          // Not on its page yet: the navigation the click started comes next.
          tab.continuationArrived = false;
          tab.continuationPage = null;
          // Nor kept for good: on a site that changes videos without a load, the user's own next video took them.
          clearTimeout(tab.continuationTimer);
          tab.continuationTimer = setTimeout(() => {
            if (tab.continuationOptions === continuation) endContinuation(tab);
          }, ContinuationKeepMs);
        }
        sendResponse(response);
      });
    }).catch((e) => {
      console.error('Going on to the next episode failed', e);
      sendResponse('error');
    });
    return true;
  } else if (msg.type === MessageTypes.REQUEST_PLAYLIST_POLL) {
    // As the request for the next episode: once the kept tab state is back.
    ensureOptions().then(() => {
      restorePlayerFrame(tab, frame, sender);
      const pageFrame = frame.pageFrame;
      if (!pageFrame || frame.frameId === 0) {
        sendResponse('error');
        return;
      }

      chrome.tabs.sendMessage(pageFrame.tab.tabId, {
        type: MessageTypes.PLAYLIST_POLL,
      }, {
        frameId: pageFrame.frameId,
      }, (response) => {
        BackgroundUtils.checkMessageError('playlist_poll');
        sendResponse(response);
      });
    }).catch((e) => {
      console.error('Asking the page for its next episode failed', e);
      sendResponse('error');
    });
    return true;
  } else {
    return;
  }

  sendResponse('ok');
  return undefined;
});

/**
 * @param {FrameHolder} playerFrame
 * @param {FrameHolder} finalFrame
 * @param {{type: string, force?: boolean, size?: number, styles?: Object<string, string>, autoExit?: boolean}} data
 * @return {Promise<*>}
 */
async function cascadedFullscreen(playerFrame, finalFrame, data) {
  const trace = traceFrames(playerFrame, finalFrame);
  if (trace.length < 2) {
    return 'error';
  }

  // Through askFrame: a page that never lets go of its event loop held the request for good. The first waits longer: content.js answers once fullscreen is entered.
  const result = await askFrame(playerFrame.tab.tabId, {
    ...data,
    frameId: trace[trace.length - 2].frameId,
    playerFrameId: playerFrame.frameId,
  }, {frameId: finalFrame.frameId}, 'cascade_fullscreen_' + data.type, 3 * FrameAnswerWaitMs);

  if (result !== 'enter' && result !== 'exit') {
    return result;
  }

  const newValue = result === 'enter';
  const promises = [];
  for (let i = 1; i < trace.length - 1; i++) {
    const currentFrame = trace[i];
    const lastFrame = trace[i - 1];
    promises.push(askFrame(currentFrame.tab.tabId, {
      type: MessageTypes.TOGGLE_WINDOWED_FULLSCREEN,
      force: newValue,
      frameId: lastFrame.frameId,
    }, {frameId: currentFrame.frameId}, 'toggle_fullscreen_windowed'));
  }

  await Promise.all(promises);

  return result;
}

/**
 * @param {FrameHolder} frame
 * @param {{force?: boolean}} msg
 * @param {(response?: *) => void} sendResponse
 * @return {true|undefined}
 */
function handleFullscreenRequest(frame, msg, sendResponse) {
  if (frame.frameId === 0) {
    sendResponse('error');
    return;
  }

  const fn = async () => {
    const fullScreenAllowedFrame = await getFrameWithFullscreenPermission(frame);

    if (!fullScreenAllowedFrame) {
      sendResponse('error');
      return;
    }

    const result = await cascadedFullscreen(frame, fullScreenAllowedFrame, {
      type: MessageTypes.TOGGLE_FULLSCREEN,
      force: msg.force,
    });

    sendResponse(result);
  };
  fn();
  return true;
}

/**
 * Firefox lets no page go fullscreen without a click: the window goes fullscreen instead, and the player fills the page.
 * @param {FrameHolder} frame
 * @param {boolean} on
 * @return {Promise<string>}
 */
async function setCarriedFullscreen(frame, on) {
  // Firefox for Android has no windows: the next episode plays in the page.
  if (!chrome.windows) return 'exit';
  const tab = frame.tab;
  const {windowId} = await chrome.tabs.get(tab.tabId);
  const win = await chrome.windows.get(windowId);
  if (on) {
    if (win.state !== 'fullscreen' && tab.windowStateBefore) {
      // The user left fullscreen outside FastStream (F11): the next episode plays windowed.
      tab.windowStateBefore = null;
      tab.carryAwaited = false;
      tab.carriedFullscreenFrameId = null;
      tellPageCarried(tab, false);
      return 'exit';
    }
    if (win.state !== 'fullscreen') {
      tab.windowStateBefore = win.state;
      await chrome.windows.update(windowId, {state: 'fullscreen'});
    }
    tab.carriedFullscreenFrameId = frame.frameId;
    tab.carryAwaited = false;
    tellPageCarried(tab, true);
    return 'enter';
  }
  tab.carriedFullscreenFrameId = null;
  tellPageCarried(tab, false);
  await restoreWindowState(tab, windowId);
  return 'exit';
}

/**
 * The first document frame 0 names after the click is the page they are for; another one ends them.
 * @param {TabHolder} tab
 * @param {string} documentKey
 */
function noteContinuationPage(tab, documentKey) {
  if (!tab.continuationOptions || tab.continuationOptions.mpvNext || !tab.continuationArrived ||
      tab.continuationPage === documentKey) {
    return;
  }
  if (tab.continuationPage === null) {
    tab.continuationPage = documentKey;
    return;
  }
  endContinuation(tab);
}

/** @param {TabHolder} tab */
function endContinuation(tab) {
  tab.continuationOptions = null;
  if (tab.carryAwaited) {
    tab.carryAwaited = false;
    tab.carriedFullscreenFrameId = null;
    chrome.tabs.get(tab.tabId).then((t) => restoreWindowState(tab, t.windowId), () => {});
  }
}

/**
 * @param {TabHolder} tab
 * @param {number} windowId
 */
async function restoreWindowState(tab, windowId) {
  const before = tab.windowStateBefore;
  if (!before) return;
  tab.windowStateBefore = null;
  try {
    const win = await chrome.windows.get(windowId);
    // Left fullscreen with F11 meanwhile: nothing to undo.
    if (win.state === 'fullscreen') await chrome.windows.update(windowId, {state: before});
  } catch (e) {
    // The window is gone.
  }
}

/**
 * @param {TabHolder} tab
 * @param {boolean} active
 */
function tellPageCarried(tab, active) {
  chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.CARRIED_FULLSCREEN, active}, {frameId: 0}, () => {
    void chrome.runtime.lastError;
  });
}

/**
 * @param {FrameHolder} frame
 * @param {{force?: boolean}} msg
 * @param {(response?: *) => void} sendResponse
 * @return {true|undefined}
 */
function handleWindowedFullscreenRequest(frame, msg, sendResponse) {
  if (frame.frameId === 0) {
    sendResponse('error');
    return;
  }

  const fn = async () => {
    const mainFrame = frame.tab.getFrameOrCreate(0);

    const result = await cascadedFullscreen(frame, mainFrame, {
      type: MessageTypes.TOGGLE_WINDOWED_FULLSCREEN,
      force: msg.force,
    });

    sendResponse(result);
  };
  fn();
  return true;
}

/**
 * @param {FrameHolder & FrameExtras} frame
 * @param {{force?: boolean, size: number, styles: Object<string, string>, autoExit: boolean}} msg
 * @param {(response?: *) => void} sendResponse
 * @return {true|undefined}
 */
function handleMiniplayerRequest(frame, msg, sendResponse) {
  if (frame.frameId === 0) {
    sendResponse('error');
    return;
  }

  const fn = async () => {
    const pageFrame = frame.pageFrame;
    if (!pageFrame) {
      sendResponse('error');
      return;
    }

    const result = await cascadedFullscreen(frame, pageFrame, {
      type: MessageTypes.TOGGLE_MINIPLAYER,
      force: msg.force,
      size: msg.size,
      styles: msg.styles,
      autoExit: msg.autoExit,
    });

    sendResponse(result);
  };
  fn();
  return true;
}

/**
 * @param {FrameHolder} frame
 * @return {Promise<?FrameHolder>}
 */
async function getFrameWithFullscreenPermission(frame) {
  let currentFrame = frame.parent;
  while (currentFrame) {
    const isFullscreenAllowed = await checkIsFullscreenAllowed(currentFrame);
    if (isFullscreenAllowed) {
      return currentFrame;
    }
    currentFrame = currentFrame.parent;
  }

  return null;
}

/**
 * @param {FrameHolder} frame
 * @param {FrameHolder} toFrame
 * @return {Array<FrameHolder>}
 */
function traceFrames(frame, toFrame) {
  if (frame === toFrame) {
    return [frame];
  }
  const frames = [];
  /** @type {?FrameHolder} */
  let currentFrame = frame;
  while (currentFrame && currentFrame !== toFrame) {
    frames.push(currentFrame);
    currentFrame = currentFrame.parent;
  }

  frames.push(toFrame);

  return frames;
}

/** @param {FrameHolder} frame */
async function checkIsFullscreenAllowed(frame) {
  return askFrame(frame.tab.tabId, {type: MessageTypes.TOGGLE_FULLSCREEN, queryPermissions: true},
      {frameId: frame.frameId}, 'check_fullscreen');
}

/** @param {FrameHolder} frame */
function checkURLMatch(frame) {
  const url = frame.url;
  const ext = CustomSourcePatternsMatcher.match(url);
  if (ext) {
    const mode = URLUtils.getModeFromExtension(ext);
    if (!mode) return;
    onSourceRecieved({
      url: url,
      requestId: -1,
    }, frame, mode);
  }
}


/**
 * @param {FrameHolder & FrameExtras} frame
 * @return {Promise<?FrameHolder>}
 */
async function getPageFrame(frame) {
  let currentFrame = frame;
  while (currentFrame && currentFrame.parent) {
    if (!currentFrame.linkPromise) {
      currentFrame.linkPromise = linkToParentFrame(currentFrame);
    }

    await currentFrame.linkPromise;

    const isFull = await checkIsFull(currentFrame);
    if (!isFull) {
      return currentFrame.parent;
    }
    currentFrame = currentFrame.parent;
  }

  return null;
}

const bufferStash = new BufferStash({dropSession: dropBufferSession,
  disk: typeof navigator.storage?.getDirectory === 'function' ? keptBufferDisk() : null});
// What players open as Firefox closed (or FastStream updated) left on the disk; a player's own start prunes too,
// but only once a video opens. Their heartbeats are past STALE_MS by then, and every live player's is not.
const SessionPruneAlarm = 'fsblob-prune';
const pruneSessionsLater = () => {
  Promise.resolve().then(() => chrome.alarms?.create(SessionPruneAlarm, {when: Date.now() + STALE_MS + 5000}))
      .catch((e) => console.warn('Could not schedule the clean-up of the disk', e));
};
chrome.runtime.onStartup?.addListener(pruneSessionsLater);
chrome.runtime.onInstalled.addListener(pruneSessionsLater);

/** @return {Promise<void>} */
async function pruneLeftSessions() {
  if (typeof navigator.storage?.getDirectory !== 'function') return;
  let fsblob;
  try {
    fsblob = await (await navigator.storage.getDirectory()).getDirectoryHandle('fsblob');
  } catch (e) {
    // No player ever wrote to the disk.
    if (/** @type {DOMException} */ (e)?.name === 'NotFoundError') return;
    throw e;
  }
  await pruneSessions(fsblob);
}

// A buffer kept on the disk past the event page's life goes at its time (KeptBufferDisk). The work is returned:
// Firefox keeps the event page up while a listener's promise is pending.
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === BufferKeepAlarm) {
    return bufferStash.ready.then(() => bufferStash.expire()).catch((e) => console.warn('Could not let kept buffers go', e));
  }
  if (alarm.name === SessionPruneAlarm) {
    return bufferStash.ready.then(pruneLeftSessions).catch((e) => console.warn('Could not clean up the disk', e));
  }
  return undefined;
});

/**
 * Keeps two videos on one address apart; the page BUFFER_TAKE told the player, as by its hand-off the frames are the next page's.
 * @param {*} pageUrl
 * @param {chrome.runtime.MessageSender} sender
 * @param {*} identifier
 * @return {?string}
 */
function playerBufferKey(pageUrl, sender, identifier) {
  if (typeof identifier !== 'string' || !identifier || typeof pageUrl !== 'string' || !pageUrl) {
    return null;
  }
  return bufferKey({
    pageUrl,
    identifier,
    incognito: !!sender.tab?.incognito,
    cookieStoreId: /** @type {chrome.tabs.Tab & {cookieStoreId?: string}} */ (sender.tab)?.cookieStoreId,
  });
}

/**
 * @param {string} topUrl - The tab's page.
 * @param {chrome.runtime.MessageSender} sender
 * @return {string}
 */
function playerNearKey(topUrl, sender) {
  return nearKey({
    topUrl,
    incognito: !!sender.tab?.incognito,
    cookieStoreId: /** @type {chrome.tabs.Tab & {cookieStoreId?: string}} */ (sender.tab)?.cookieStoreId,
  });
}

/**
 * @param {string} session
 * @return {Promise<void>}
 */
async function dropBufferSession(session) {
  const root = await navigator.storage.getDirectory();
  const fsblob = await root.getDirectoryHandle('fsblob');
  await fsblob.removeEntry(session, {recursive: true});
}

/**
 * The player's page first, then each frame that saw the stream; at most three, each fetched once.
 * @param {TabHolder} tab
 * @param {FrameHolder & FrameExtras} frame
 * @param {string} url
 * @return {string[]}
 */
function freshLinkPages(tab, frame, url) {
  const identifier = url.split(/[?#]/)[0];
  /** @type {string[]} */
  const pages = [];
  const add = (/** @type {FrameHolder|null|undefined} */ page) => {
    if (page && /^https?:/i.test(page.url) && !pages.includes(page.url)) pages.push(page.url);
  };
  add(frame.pageFrame || frame.parent);
  for (const other of tab.getFrames()) {
    if (other.getSources().some(/** @param {TrackedSource} source */ (source) =>
      [source.url, source.requestedUrl].some((link) => link?.split(/[?#]/)[0] === identifier))) {
      add(other);
    }
  }
  return pages.slice(0, 3);
}

/**
 * @param {TabHolder} tab
 * @param {FrameHolder & FrameExtras} frame
 */
function keepPlayerPageFrame(tab, frame) {
  if (!frame.pageFrame) return;
  tab.playerPageFrames = {...tab.playerPageFrames, [frame.frameId]: frame.pageFrame.frameId};
  Tabs.saveTabState(tab);
}

/**
 * Firefox unloaded the idle event page while it played: its page frame comes from the tab's kept state.
 * @param {TabHolder} tab
 * @param {FrameHolder & FrameExtras} frame
 * @param {chrome.runtime.MessageSender} sender
 */
function restorePlayerFrame(tab, frame, sender) {
  if (frame.pageFrame || !BackgroundUtils.isUrlPlayerUrl(sender.url || '')) return;
  const pageFrameId = tab.playerPageFrames[frame.frameId];
  if (typeof pageFrameId !== 'number') return;
  // Counted as acceptPlayer counts one: uncounted, the next player in the tab played without a click too.
  if (!frame.isPlayer) {
    frame.isPlayer = true;
    tab.playerCount++;
  }
  frame.pageFrame = tab.getFrameOrCreate(pageFrameId);
}

/**
 * @param {FrameHolder} frame
 * @return {FrameHolder[]}
 */
function frameAndInside(frame) {
  const all = [frame];
  for (const each of all) all.push(...each.children);
  return all;
}

/**
 * Each frame above, guarding the iframe since the player opened, lets go unless another player lives under it.
 * @param {TabHolder} tab
 * @param {FrameHolder} removed
 */
function releaseOverlayGuards(tab, removed) {
  /** @param {FrameHolder} frame @param {FrameHolder} above */
  const under = (frame, above) => {
    for (let f = /** @type {?FrameHolder} */ (frame); f; f = f.parent) {
      if (f === above) return true;
    }
    return false;
  };
  const players = [...tab.frames.values()].filter((f) => f.isPlayer);
  if (!players.some((f) => under(f, removed))) return;
  for (let child = removed; child.parent; child = child.parent) {
    if (players.some((f) => under(f, child) && !under(f, removed))) return;
    chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.RELEASE_OVERLAY_GUARD, frameId: child.frameId},
        {frameId: child.parent.frameId}, () => {
          void chrome.runtime.lastError;
        });
  }
}

/** @param {FrameHolder} frame */
async function checkIsFull(frame) {
  return askFrame(frame.tab.tabId, {type: MessageTypes.IS_FULL, frameId: frame.frameId},
      {frameId: /** @type {FrameHolder} */ (frame.parent).frameId}, 'is_full');
}

/**
 * Waits at most FrameAnswerWaitMs: a parent page that never let go of its event loop held the player's load answer.
 * @param {FrameHolder} frame
 * @return {Promise<void>}
 */
async function linkToParentFrame(frame) {
  if (!frame.parent) return;

  const key = crypto.randomUUID();

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, FrameAnswerWaitMs);
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.FRAME_LINK_RECEIVER,
      frameId: frame.frameId,
      key,
    }, {
      // Checked above: the promise's executor runs at once.
      frameId: /** @type {FrameHolder} */ (frame.parent).frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('link_frame_reciever');
      chrome.tabs.sendMessage(frame.tab.tabId, {
        type: MessageTypes.FRAME_LINK_SENDER,
        key,
      }, {
        frameId: frame.frameId,
      }, (response) => {
        BackgroundUtils.checkMessageError('link_frame_sender');
        clearTimeout(timer);
        resolve();
      });
    });
  });
}

/** @param {chrome.tabs.Tab|undefined} tab */
function getMediaInfoFromTab(tab) {
  if (!tab || BackgroundUtils.isUrlPlayerUrl(/** @type {string} */ (tab.url))) return;
  let hostname;
  try {
    hostname = new URL(/** @type {string} */ (tab.url)).hostname;
  } catch (e) {
    return;
  }
  return guessMediaInfo(tab.title || '', hostname);
}

/** @param {Object} [newOptions] */
async function loadOptions(newOptions) {
  newOptions = newOptions || await Utils.getOptionsFromStorage();
  Options = /** @type {PlayerOptions} */ (newOptions);
  // Firefox for Android runs no helper: MPV mode brought from a desktop's settings stays off.
  if (typeof chrome.runtime.connectNative !== 'function') Options.mpvMode = false;

  AutoEnableList.setEntries(Options.autoEnableURLs);

  MpvAllowlist.setEntries(Options.mpvAllowlist);
  Mpv.mpvPath = Options.mpvPath || '';
  Mpv.fullscreen = !!Options.mpvFullscreen;
  Mpv.singleInstance = !!Options.mpvSingleInstance;

  if (Options.mpvMode) {
    chrome.permissions.contains({
      permissions: ['nativeMessaging'],
    }, (hasNative) => {
      if (!hasNative && !Mpv.warnedAboutHost) {
        console.warn('MPV mode is enabled but the nativeMessaging permission is missing');
      }
    });
  }

  if (Options.playMP4URLs) {
    setupRedirectRule(1, ['mp4'], () => Options.playMP4URLs);
  } else {
    removeRule(1);
  }

  if (Options.playStreamURLs) {
    setupRedirectRule(2, ['m3u8', 'mpd'], () => Options.playStreamURLs);
  } else {
    removeRule(2);
  }

  loadCustomPatterns();
}


/**
 * @param {number} ruleID
 * @param {string[]} filetypes
 * @param {() => boolean} [wanted]
 */
async function setupRedirectRule(ruleID, filetypes, wanted = () => true) {
  const excludedRequestDomains = [(new URL(BackgroundUtils.getPlayerUrl())).hostname];

  for (const domain of AutoEnableList.excludedDomains()) {
    if (!excludedRequestDomains.includes(domain)) {
      excludedRequestDomains.push(domain);
    }
  }

  // Without the key (its storage failed) the player still plays the link, without its headers and mode.
  const key = await getAddressKey().catch((e) => {
    console.error('No player address key', e);
    return '';
  });
  // Turned off during the wait: not added again.
  if (!wanted()) return;

  /** @type {chrome.declarativeNetRequest.Rule} */
  const rule = {
    id: ruleID,
    action: {
      type: 'redirect',
      redirect: {regexSubstitution: BackgroundUtils.getPlayerUrl() + '?address=' + key + '#\\0'},
    },
    condition: {
      excludedRequestDomains,
      // Up to a query or fragment: `.+` ran through the `?`, and a search for index.m3u8 went to the player.
      regexFilter: '^[^?#]*\\.(' + filetypes.join('|') + ')([?#].*)?$',
      resourceTypes: ['main_frame'],
    },
  };
  return updateRedirectRule(ruleID, JSON.stringify(rule), {
    removeRuleIds: [rule.id],
    addRules: [rule],
  });
}

/** @param {number} ruleID */
async function removeRule(ruleID) {
  return updateRedirectRule(ruleID, RedirectRuleRemoved, {
    removeRuleIds: [ruleID],
  });
}

/**
 * @param {number} ruleID
 * @param {string} made
 * @param {chrome.declarativeNetRequest.UpdateRuleOptions} update
 */
async function updateRedirectRule(ruleID, made, update) {
  if (RedirectRulesMade.get(ruleID) === made) return;
  RedirectRulesMade.set(ruleID, made);
  return chrome.declarativeNetRequest.updateDynamicRules(update).catch((e) => {
    // Not given: the next load gives it again.
    if (RedirectRulesMade.get(ruleID) === made) RedirectRulesMade.delete(ruleID);
    throw e;
  });
}

async function loadCustomPatterns() {
  const customSourcePatterns = Options.customSourcePatterns;
  if (OptionsCache.customSourcePatterns !== customSourcePatterns) {
    OptionsCache.customSourcePatterns = customSourcePatterns;

    const matcher = new MultiRegexMatcher();
    await loadCustomPatternsFile(matcher, Options.customSourcePatterns);

    if (OptionsCache.customSourcePatterns !== customSourcePatterns) return;

    matcher.compile();
    CustomSourcePatternsMatcher = matcher;
  }
}

/**
 * @param {MultiRegexMatcher} matcher
 * @param {string} fileStr
 */
async function loadCustomPatternsFile(matcher, fileStr) {
  const {patterns, errors} = parseCustomSourcePatterns(fileStr);
  for (const {line, text, reason} of errors) {
    console.warn(`Custom source pattern on line ${line} left out (${reason}): ${text}`);
  }
  for (const {ext, regex, flags} of patterns) {
    try {
      matcher.addRegex(regex, flags, ext);
    } catch (e) {
      console.warn(e);
    }
  }
}

/**
 * @param {string} url
 * @param {FrameHolder} frame
 * @param {*} headers
 */
function handleSubtitles(url, frame, headers) {
  const subtitles = frame.getSubtitles();
  if (subtitles.find((a) => {
    return a.source === url;
  })) return;

  if (Logging) console.log('Found subtitle', url);
  const u = (new URL(url)).pathname.split('/').pop() || '';

  frame.addSubtitle({
    source: url,
    headers: headers,
    label: u.split('.')[0],
    time: Date.now(),
  });
}

/**
 * @param {FrameHolder} frame
 * @param {string} url
 */
function getSourceFromURL(frame, url) {
  return frame.getSources().find((a) => {
    return a.url === url;
  });
}

/**
 * @param {FrameHolder} frame
 * @param {string} url
 * @param {string} mode
 * @param {*} headers
 * @param {number} [time]
 * @param {?string} [requestedUrl]
 */
function addSource(frame, url, mode, headers, time = Date.now(), requestedUrl = null, typed = false) {
  frame.addSource({
    url, mode, headers, time,
    ...(requestedUrl && requestedUrl !== url ? {requestedUrl} : {}),
    ...(typed ? {typed: true} : {}),
  });
}

/**
 * @param {FrameHolder} frame
 * @param {string} url
 * @return {boolean}
 */
function isKnownPiece(frame, url) {
  const sources = frame.getSources();
  const index = sources.findIndex((source) => source.url === url);
  return index !== -1 && Lengths.lengthsOf(sources)[index] === PIECE_LENGTH;
}

// A player's pieces follow each other within seconds.
const NextPieceWithinMs = 15000;

/**
 * lesson-1.mp4 and lesson-2.mp4 are two videos when one of that shape was read as a film.
 * @param {FrameHolder} frame
 * @param {string} url
 * @param {string} mode
 * @return {boolean}
 */
function isRepeatPiece(frame, url, mode) {
  /** @type {(m: string) => boolean} */
  const isFile = (m) => m === PlayerModes.ACCELERATED_MP4 || m === PlayerModes.DIRECT;
  if (!isFile(mode)) return false;
  const shape = StreamLengths.shape(url);
  const sources = frame.getSources();
  const own = sources.find((source) => source.url === url);
  const alike = sources.filter((source) =>
    source.url !== url && isFile(source.mode) && StreamLengths.shape(source.url) === shape);
  if (alike.length === 0) return false;
  const lengths = alike.map((source) => Lengths.lengthOf(source.url));
  if (lengths.includes(PIECE_LENGTH)) return true;
  if (lengths.some((length) => typeof length === 'number')) return false;
  const now = own?.time ?? Date.now();
  return alike.some((source) => Math.abs(now - source.time) < NextPieceWithinMs);
}

/**
 * @param {TabHolder} tab
 * @param {number} frameId
 * @return {Promise<Array<Array<{url: string, label: string, height: number}>>>}
 */
function getPageQualities(tab, frameId) {
  if (tab.tabId < 0 || typeof frameId !== 'number') return Promise.resolve([]);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), PageQualitiesWaitMs);
    chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.GET_PAGE_QUALITIES}, {frameId}, (lists) => {
      BackgroundUtils.checkMessageError('get_page_qualities');
      clearTimeout(timer);
      resolve(Array.isArray(lists) ? lists : []);
    });
  });
}

/**
 * @param {TabHolder} tab
 * @param {Array<{url: string, requestedUrl?: string, frameId: number, qualities?: Array<Object>}>} sources
 * @return {Promise<void>}
 */
async function attachPageQualities(tab, sources) {
  const frameIds = [...new Set(sources.map((source) => source.frameId))];
  const answers = await Promise.all(frameIds.map((frameId) => getPageQualities(tab, frameId)));
  /** @type {Map<number, Array<Array<{url: string, label: string, height: number}>>>} */
  const lists = new Map();
  frameIds.forEach((frameId, i) => lists.set(frameId, answers[i]));
  for (const source of sources) {
    const list = listForSource(source, lists.get(source.frameId) || []);
    if (list) source.qualities = list;
  }
}


/** @typedef {import('./TabTracker.mjs').FrameHolder} FrameHolder */
/** @typedef {import('./TabTracker.mjs').TabHolder} TabHolder */
/** @typedef {import('./TabTracker.mjs').TrackedSource} TrackedSource */
/** @typedef {import('./TabTracker.mjs').TrackedSubtitle} TrackedSubtitle */
/** @typedef {import('./MpvMode.mjs').MpvWatch} MpvWatch */

/**
 * regexMatched: a list turned the tab on, not the user; mpvMatched: the MPV Allowlist started MPV on its site.
 * @typedef {Object} TabExtras
 * @property {boolean} [regexMatched]
 * @property {boolean} [mpvMatched]
 * @property {?{url: string, filename: string, resolve: (value: boolean|null|undefined) => boolean}} [downloadInfo]
 */

/**
 * @typedef {Object} FrameExtras
 * @property {FrameHolder} [pageFrame]
 * @property {Promise<void>} [linkPromise]
 * @property {ReturnType<typeof setTimeout>} [openTimeout]
 * @property {{document: ?string, taken: Promise<void>}} [captionsScrape]
 */

/**
 * @typedef {{url?: string, document?: string, live?: boolean,
 *   resources?: {url: string, media: boolean, cors?: boolean, time: number}[]}} MediaReport
 */

/**
 * @typedef {TrackedSource & {depth: number, frameId: number, duration?: number|null,
 *   qualities?: Array<{url: string, label: string, height: number}>}} CollectedSource
 */

/** @typedef {{src: string, duration: ?number, playing?: string, time?: number}} PlayedVideo */

/** @typedef {{autoPlay?: boolean, fullscreenState?: string, disableLoadProgress?: boolean, mpvNext?: boolean}} Continuation */

/**
 * @typedef {Awaited<ReturnType<MpvBackend['openStream']>>|{ok: false, vpn: true, error: string}|
 *   {ok: false, drm: true, error: string}|{ok: false, pageOnly: true, error: string}|
 *   {ok: false, dropped: true}|{ok: false, declined: true}} MpvHandOff
 */

/**
 * Not for stills alone (the seek bar's thumbnails), nor when the stream the player would play is copy-protected.
 * @param {FrameHolder} frame
 * @return {Promise<boolean>}
 */
async function hasVideoSource(frame) {
  const manifests = () => collectSources(frame).sources.filter((source) =>
    source.mode === PlayerModes.ACCELERATED_HLS || source.mode === PlayerModes.ACCELERATED_DASH);
  await Lengths.settle(manifests, SourceLengthWaitMs);
  const sources = collectSources(frame).sources;
  const lengths = Lengths.lengthsOf(sources);
  if (!lengths.some((length) => length !== STILLS_LENGTH)) {
    return false;
  }
  const played = StreamPick.pick(StreamLength.longest(sources.map((source, i) => ({...source, duration: lengths[i]}))));
  if (Lengths.isProtected(played.url)) {
    if (Logging) console.log('Copy-protected, left to the page\'s player:', played.url);
    noteProtectedVideo(frame.tab, true);
    return false;
  }
  return true;
}

/**
 * Not while a FastStream player of the tab is there, playing the video the user watches.
 * @param {TabHolder} tab
 * @param {boolean} copyProtected
 */
function noteProtectedVideo(tab, copyProtected) {
  // One still opening too: each frame's player opens on its own timer.
  if (copyProtected && [...tab.getFrames()].some((frame) => frame.isPlayer || frame.playerOpening)) {
    return;
  }
  if (tab.protectedVideo !== copyProtected) {
    tab.protectedVideo = copyProtected;
    BackgroundUtils.updateTabIcon(tab);
    Tabs.saveTabState(tab);
  }
}

/**
 * @param {TabHolder} tab
 * @return {boolean}
 */
function tabHasSources(tab) {
  for (const frame of tab.getFrames()) {
    if (!frame.isPlayer && frame.getSources().length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Firefox unloads the idle background and its detected streams, while a page asks for its manifest once.
 * @param {TabHolder} tab
 */
function recoverSources(tab) {
  try {
    chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.REPORT_LOADED_MEDIA}, () => {
      // Each frame answers with a message of its own, not here.
      void chrome.runtime.lastError;
    });
  } catch (e) {
    // The tab is gone.
  }
}

/**
 * Each URL goes through a request's rules by URL alone; the page's default Referer and Origin stand in for the lost headers.
 * @param {FrameHolder & FrameExtras} frame
 * @param {MediaReport} msg
 */
function recoverFrameSources(frame, msg) {
  // The answer of a page since navigated away from: the frame's streams are the next one's.
  if (frame.documentKey && msg.document !== frame.documentKey) {
    return;
  }
  if (typeof msg.url === 'string' && !frame.url) {
    frame.url = msg.url;
  }
  // Since the background started again, the page has not told it its name (FRAME_ADDED).
  if (typeof msg.document === 'string' && !frame.documentKey) {
    frame.documentKey = msg.document;
  }
  if (frame.hasPlayer() || !Array.isArray(msg.resources)) {
    return;
  }

  // The report is the page's to write: a page on the internet must not have a local-network address it names read.
  const pageUrl = typeof msg.url === 'string' ? msg.url : frame.url;
  const pageIsLocal = typeof pageUrl === 'string' && isLocalAddress(pageUrl);
  for (const resource of msg.resources) {
    const url = resource && typeof resource.url === 'string' ? resource.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    if (!pageIsLocal && isLocalAddress(url)) continue;
    const media = !!resource.media;
    // A media element sends no Origin, unless it loads CORS (crossorigin), as content.js says.
    const headers = pageHeaders(typeof msg.url === 'string' ? msg.url : frame.url, url, media && !resource.cors);
    const ext = urlType(url, CustomSourcePatternsMatcher);
    if (BackgroundUtils.isSubtitles(ext)) {
      handleSubtitles(url, frame, headers);
      continue;
    }

    const mode = URLUtils.getModeFromExtension(ext) || (media ? PlayerModes.ACCELERATED_MP4 : modeFromQuery(url, CustomSourcePatternsMatcher));
    if (!mode) continue;
    if (getSourceFromURL(frame, url)) {
      // Known already, and the page's video has it now: an open that was missed may not be.
      if (msg.live) reopenMissed(frame);
      continue;
    }
    onSourceRecieved({
      url,
      requestId: -1,
      customHeaders: headers,
      time: typeof resource.time === 'number' ? resource.time : undefined,
    }, frame, mode);
  }
}

/**
 * With the browser's User-Agent too: mpv's own ("libmpv") is refused by CDNs.
 * @param {string|undefined} pageUrl
 * @param {string} url
 * @param {boolean} media
 * @return {Array<{name: string, value: string}>}
 */
function pageHeaders(pageUrl, url, media) {
  if (!pageUrl) {
    return [];
  }
  let page;
  let target;
  try {
    page = new URL(pageUrl);
    target = new URL(url);
  } catch (e) {
    return [];
  }
  if (!/^https?:$/.test(page.protocol)) {
    return [];
  }
  const userAgent = {name: 'User-Agent', value: navigator.userAgent};
  if (page.origin === target.origin) {
    return [{name: 'Referer', value: page.href.split('#')[0]}, userAgent];
  }
  const headers = [{name: 'Referer', value: page.origin + '/'}];
  if (!media) {
    headers.push({name: 'Origin', value: page.origin});
  }
  headers.push(userAgent);
  return headers;
}

/**
 * @param {FrameHolder} frame
 * @param {boolean} [remove]
 */
function collectSources(frame, remove = false) {
  /** @type {Array<TrackedSubtitle & {depth: number, frameId: number}>} */
  const subtitles = [];
  /** @type {Array<CollectedSource>} */
  const sources = [];

  /** @type {?FrameHolder} */
  let currentFrame = frame;
  let depth = 0;

  while (currentFrame) {
    const currentSubtitles = currentFrame.getSubtitles();
    for (const sub of currentSubtitles) {
      subtitles.push({
        ...sub,
        depth,
        frameId: currentFrame.frameId,
      });
    }

    const currentSources = currentFrame.getSources();
    for (const source of currentSources) {
      sources.push({
        ...source,
        depth,
        frameId: currentFrame.frameId,
      });
    }

    if (remove) {
      currentSources.length = 0;
      currentSubtitles.length = 0;
    }

    if (sources.length !== 0) break;

    currentFrame = currentFrame.parent;
    depth++;
  }

  sources.sort((a, b) => {
    return a.time - b.time;
  });

  return {subtitles, sources};
}

const StartPagePlayerEveryMs = 2000;
const StartPagePlayerForMs = 20000;
// Each autoplay next's own 20 s: a later page load did not start another.
const startPagePlayerUntil = new WeakMap();

/**
 * A hoster's player may sit idle until clicked. Every 2 s for 20 s, only the frame with the tab's largest video.
 * @param {TabHolder} tab
 */
export function startPagePlayers(tab) {
  const continuation = tab.continuationOptions;
  if (!continuation || (tab.pagePlayerStarter && tab.pagePlayerContinuation === continuation)) return;
  // One still asking for an earlier next (two quick next keys) never asked this page.
  clearInterval(tab.pagePlayerStarter);
  tab.pagePlayerContinuation = continuation;
  if (!startPagePlayerUntil.has(continuation)) {
    startPagePlayerUntil.set(continuation, Date.now() + StartPagePlayerForMs);
  }
  let asking = false;
  const ask = async () => {
    // In MPV mode only for MPV autoplay (mpvNext), and only until the stream went to mpv.
    const mpvDone = tab.isMpv && (!continuation.mpvNext || tab.mpvAutoOpened);
    if (tab.continuationOptions !== continuation || !continuation.autoPlay || !tab.isOn || mpvDone ||
        Date.now() > startPagePlayerUntil.get(continuation) || !Tabs.tabs.has(tab.tabId)) {
      clearInterval(tab.pagePlayerStarter);
      tab.pagePlayerStarter = undefined;
      return;
    }
    if (asking) return;
    asking = true;
    try {
      const frames = Array.from(tab.frames.values());
      const sizes = await Promise.all(frames.map((frame) => getVideoSize(frame)));
      let largest = -1;
      for (let i = 0; i < frames.length; i++) {
        if (sizes[i] > 0 && (largest < 0 || sizes[i] > sizes[largest])) largest = i;
      }
      if (largest < 0) return;
      const frameId = frames[largest].frameId;
      chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.START_PAGE_PLAYER}, {frameId}, (started) => {
        void chrome.runtime.lastError;
        if (started && Logging) console.log('[autoplay next] started the page\'s player:', started, frameId);
      });
    } finally {
      asking = false;
    }
  };
  tab.pagePlayerStarter = setInterval(ask, StartPagePlayerEveryMs);
}

/** @param {FrameHolder} frame */
async function sendSources(frame) {
  const continuationOptions = frame.tab.continuationOptions;
  frame.tab.continuationOptions = null;
  // Shown once, by the first player that asks (MpvMode.playHereInstead).
  const notice = frame.tab.playerNotice;
  if (notice) {
    frame.tab.playerNotice = null;
    Tabs.saveTabState(frame.tab);
  }
  const send = /** @param {Array<Object>} subtitles @param {Array<Object>} sources @param {?Object} video */ (subtitles, sources, video) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.SOURCES,
      subtitles: subtitles,
      sources: sources,
      video,
      autoSetSource: true,
      continuationOptions: continuationOptions,
      ...(notice ? {notice} : {}),
    }, {
      frameId: frame.frameId,
    }, () => {
      BackgroundUtils.checkMessageError('sources');
    });
  };

  // A player loading again in its frame gets what its first load got, taken out of the frames then.
  const handed = frame.parent ? frame.parent.handedTo(frame.frameId) : null;
  if (handed && collectSources(frame).sources.length === 0) {
    send(handed.subtitles, handed.sources, handed.video);
    return;
  }

  // The one the page's video played, or the longest: a little time for lengths still read; a lone playlist too (it may be stills).
  /** @type {?{src: string, duration: ?number}} */
  let video = null;
  const detected = collectSources(frame).sources;
  const several = detected.length > 1;
  if (several || detected.some((source) => source.mode === PlayerModes.ACCELERATED_HLS)) {
    await Lengths.settle(() => collectSources(frame).sources, SourceLengthWaitMs);
    if (several && frame.parent) {
      const known = new Set(collectSources(frame).sources.map((source) => source.url));
      video = await getPlayedVideo(frame);
      await Lengths.settle(() => collectSources(frame).sources.filter((source) => !known.has(source.url)), SourceLengthWaitMs);
    }
  }

  const {subtitles, sources} = collectSources(frame, true);
  const lengths = Lengths.lengthsOf(sources);
  sources.forEach((source, i) => {
    source.duration = lengths[i];
  });
  await attachPageQualities(frame.tab, sources);

  if (frame.parent && sources.length) {
    frame.parent.noteHandedToPlayer(frame.frameId, {subtitles, sources, video});
  }
  send(subtitles, sources, video);
}

/** @param {FrameHolder} frame */
export async function scrapeCaptionsTags(frame) {
  const tabId = frame.tab.tabId;
  const frameId = frame.frameId;
  if (tabId < 0) return null;

  return askFrame(tabId, {type: MessageTypes.SCRAPE_CAPTIONS}, {frameId: frameId}, 'scrape_captions', CaptionsAnswerWaitMs);
}

// content.js reads at most 64 MB at a time but asks again for each new stream: kept without end otherwise.
export const ScrapedCaptionsKeptMax = 64 * 1024 * 1024;

/**
 * Past ScrapedCaptionsKeptMax, read tracks go oldest first, this answer's last; files seen loaded (no text) stay.
 * @param {FrameHolder} frame
 * @param {*} subs
 */
export function takeScrapedCaptions(frame, subs) {
  if (!Array.isArray(subs)) {
    return;
  }
  const subtitles = frame.getSubtitles();
  subs.forEach((s) => {
    const index = subtitles.findIndex((ss) => ss.source === s.source);
    if (index === -1) {
      subtitles.push(s);
    } else {
      subtitles[index] = s;
    }
  });
  /** @param {*} s @return {number} */
  const textLength = (s) => (typeof s?.data === 'string' ? s.data.length : 0);
  let kept = subtitles.reduce((sum, s) => sum + textLength(s), 0);
  // A track read again keeps its place: this answer's tracks go only after all others.
  const current = new Set(subs.map((s) => s?.source));
  for (const spareCurrent of [true, false]) {
    for (let i = 0; kept > ScrapedCaptionsKeptMax && i < subtitles.length;) {
      const length = textLength(subtitles[i]);
      if (length > 0 && !(spareCurrent && current.has(subtitles[i].source))) {
        kept -= length;
        subtitles.splice(i, 1);
      } else {
        i++;
      }
    }
  }
}

/**
 * @param {FrameHolder} player
 * @return {Promise<?{src: string, duration: ?number}>}
 */
async function getPlayedVideo(player) {
  return new Promise((resolve) => {
    // Content scripts share the page's event loop: a page that never lets go would hold the player.
    const timer = setTimeout(() => resolve(null), PlayedVideoWaitMs);
    chrome.tabs.sendMessage(player.tab.tabId, {
      type: MessageTypes.GET_PLAYED_VIDEO,
      frameId: player.frameId,
    }, {
      frameId: /** @type {FrameHolder} */ (player.parent).frameId,
    }, (video) => {
      BackgroundUtils.checkMessageError('get_played_video');
      clearTimeout(timer);
      resolve(video || null);
    });
  });
}

/**
 * As tabs.sendMessage, but undefined once FrameAnswerWaitMs passed with no answer.
 * @param {number} tabId
 * @param {Object} message
 * @param {{frameId: number}} target
 * @param {string} label
 * @param {number} [waitMs]
 * @return {Promise<*>}
 */
export function askFrame(tabId, message, target, label, waitMs = FrameAnswerWaitMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), waitMs);
    chrome.tabs.sendMessage(tabId, message, target, (answer) => {
      BackgroundUtils.checkMessageError(label);
      clearTimeout(timer);
      resolve(answer);
    });
  });
}

/** @param {FrameHolder} frame */
async function getVideoSize(frame) {
  return askFrame(frame.tab.tabId, {type: MessageTypes.GET_VIDEO_SIZE}, {frameId: frame.frameId}, 'get_video_size');
}

/**
 * @param {string|undefined} url
 * @return {?string}
 */
function playerOpener(url) {
  if (!url) return null;
  try {
    return new URL(url).searchParams.get('opener');
  } catch (e) {
    return null;
  }
}

/**
 * When this background does not know that page's name (it started again since), the frame's content script is asked.
 * @param {TabHolder} tab
 * @param {FrameHolder} frame
 * @param {*} parentFrameId
 * @param {?string} opener
 * @return {Promise<boolean>}
 */
async function isPlayerParentProven(tab, frame, parentFrameId, opener) {
  const proof = tab.playerParentProof(frame, parentFrameId, opener);
  if (proof !== 'ask') {
    return proof === 'proven';
  }
  // No answer in time is no proof.
  const answer = await askFrame(tab.tabId, {
    type: MessageTypes.IS_PLAYER_OPENER,
    document: opener,
  }, {frameId: parentFrameId}, 'is_player_opener');
  if (answer !== true) {
    return false;
  }
  const parent = tab.getFrameOrCreate(parentFrameId);
  if (!parent.documentKey) {
    parent.documentKey = opener;
  }
  return true;
}

/**
 * @param {TabHolder & TabExtras} tab
 * @param {FrameHolder & FrameExtras} frame
 * @param {chrome.runtime.MessageSender} sender
 * @param {Function} sendResponse
 */
function acceptPlayer(tab, frame, sender, sendResponse) {
  if (Logging) console.log('Found FastStream window', frame);
  // Not counted twice: restorePlayerFrame may have counted it already.
  const counted = frame.isPlayer;
  frame.isPlayer = true;

  if (tab.downloadInfo) {
    // Taken now: the DOWNLOAD's 30 s timeout can end it while the player saves.
    const info = tab.downloadInfo;
    tab.downloadInfo = null;
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.HANDLE_DOWNLOAD,
      url: info.url,
      filename: info.filename,
    }, {
      frameId: frame.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('download');
      info.resolve(response);

      chrome.tabs.remove(frame.tab.tabId).catch(() => {});
    });
    sendResponse(null);
    return;
  }

  if (frame.playerOpening) {
    frame.playerOpening = false;
  } else if (frame.parent) {
    frame.parent.playerOpening = false;
  }
  // The player is here: nothing missed any more, in its own frame (a redirect) or its page's.
  for (const opened of [frame, frame.parent]) {
    if (opened) {
      opened.openMissed = 0;
      opened.openGone = false;
    }
  }
  if (!counted) {
    tab.playerCount++;
  }
  const isMainPlayer = tab.playerCount === 1;

  getPageFrame(frame).then((pageFrame) => {
    if (pageFrame) {
      frame.pageFrame = pageFrame;
    } else {
      frame.pageFrame = tab.getFrameOrCreate(0);
    }
    keepPlayerPageFrame(tab, frame);

    const response = {
      mediaInfo: getMediaInfoFromTab(sender?.tab),
      isMainPlayer,
      ...pageOfPlayer(tab, frame),
    };

    sendResponse(response);
  }).catch((e) => {
    // The player waits for this answer before it starts; the top frame stands in.
    console.error('Finding the page frame of a player failed', e);
    frame.pageFrame = tab.getFrameOrCreate(0);
    keepPlayerPageFrame(tab, frame);
    sendResponse({
      mediaInfo: getMediaInfoFromTab(sender?.tab),
      isMainPlayer,
      ...pageOfPlayer(tab, frame),
    });
  });
}

/**
 * @param {TabHolder} tab
 * @param {FrameHolder & FrameExtras} frame
 * @return {{tabId: number, pageFrameId: number}}
 */
function pageOfPlayer(tab, frame) {
  const page = frame.pageFrame && frame.pageFrame !== frame ? frame.pageFrame : null;
  return page ? {tabId: tab.tabId, pageFrameId: page.frameId} : {tabId: -1, pageFrameId: -1};
}

/** @param {FrameHolder} frame */
async function openPlayer(frame) {
  if (frame.playerOpening || frame.hasPlayer()) {
    return;
  }

  frame.playerOpening = true;
  frame.openTriedAt = Date.now();
  // So a report of an earlier attempt never ends this one (PLAYER_OPEN_GONE).
  frame.playerOpeningAttempt = ++playerOpeningAttempts;
  // Another frame's video, or the page's next, is one FastStream plays: no "DRM" over it.
  noteProtectedVideo(frame.tab, false);

  if (Logging) console.log('Opening player', frame);

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.OPEN_PLAYER,
      url: BackgroundUtils.getPlayerUrl(),
      noRedirect: frame.frameId === 0,
      frameId: frame.frameId,
      parentFrameId: frame.parent ? frame.parent.frameId : -1,
      attempt: frame.playerOpeningAttempt,
    }, {
      frameId: frame.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('player');
      if (Logging) console.log('Player opening answered', response, frame.frameId);

      if (!BackgroundUtils.isPlayerOpeningResponse(response)) {
        frame.playerOpening = false;
        // No answer at all: the frame went on to another page, whose own streams open it.
        if (typeof response === 'string') noteOpenMissed(frame, response);
      }

      resolve(response);
    });
  });
}

/**
 * content.js found no video on screen ('no_video'), its players were removed ('error'), or the page took the iframe out ('gone').
 * @param {FrameHolder & FrameExtras} frame
 * @param {string} answer
 */
function noteOpenMissed(frame, answer) {
  frame.openMissed++;
  frame.openGone = answer === 'gone';
  if (frame.openGone || frame.openMissed > ReopenMissedTimes) return;
  clearTimeout(frame.openTimeout);
  frame.openTimeout = setTimeout(() => reopenMissed(frame, 0), ReopenMissedFirstMs * 2 ** (frame.openMissed - 1));
}

/**
 * Only byUser puts back a player the page took out: its own requests would put it back to be taken out again.
 * @param {FrameHolder & FrameExtras} frame
 * @param {number} [wait]
 * @param {boolean} [byUser]
 */
function reopenMissed(frame, wait, byUser = false) {
  if (!frame.openMissed || frame.playerOpening || frame.hasPlayer() || !frame.isTracked() ||
      !frame.tab.isOn || frame.tab.isMpv || (frame.openGone && !byUser)) {
    return;
  }
  const least = wait ?? Math.min(ReopenMissedEveryMs * 2 ** (frame.openMissed - 1), ReopenMissedLongestMs);
  if (Date.now() - frame.openTriedAt < least) return;
  // Now: the check before openPlayer can wait for lengths, and the next request would start a second try.
  frame.openTriedAt = Date.now();
  openPlayerIfVideo(frame);
}

/** @param {chrome.runtime.MessageSender} sender */
async function reopenOnUserPlay(sender) {
  await ensureOptions();
  const tab = sender.tab?.id !== undefined ? Tabs.getTab(sender.tab.id) : null;
  if (!tab || !tab.isOn || tab.isMpv || typeof sender.frameId !== 'number') return;
  for (let frame = tab.getFrame(sender.frameId); frame; frame = frame.parent) {
    if (frame.openMissed) {
      reopenMissed(frame, ReopenOnPlayEveryMs, true);
      return;
    }
  }
}

/** @param {FrameHolder & FrameExtras} frame */
async function openPlayerIfVideo(frame) {
  // OPEN_PLAYER goes by frame id, to whatever page now has it: an untracked frame opens nothing.
  if (!frame.isTracked()) {
    return;
  }
  // MPV counts as on too: this would open a player under it.
  if (!frame.tab.isOn || frame.tab.isMpv) {
    return;
  }
  // Not on the seek bar's thumbnails alone: the video's stream would then be dropped as the player's own.
  if (!await hasVideoSource(frame)) {
    return;
  }
  // Again after the wait: a tab gone to another site dropped the frame.
  if (frame.isTracked() && frame.tab.isOn && !frame.tab.isMpv) {
    openPlayer(frame);
  }
}

/** @param {FrameHolder} frame */
async function sendSourcesToMainFramePlayers(frame) {
  // Runs for every stream detected: the tabs are queried only when one has a main player.
  if (!Array.from(Tabs.tabs.values()).some((tab) => tab.isOn && tab.getMainPlayer())) {
    return;
  }
  const tabs = await BackgroundUtils.queryTabs();
  // Only to player tabs on the same side of private browsing, and in the same container.
  const from = tabs.find(/** @param {chrome.tabs.Tab} t */ (t) => t.id === frame.tab.tabId);
  if (!from) {
    return;
  }

  for (let i = 0; i < tabs.length; i++) {
    if (!!tabs[i].incognito !== !!from.incognito) continue;
    if ((tabs[i].cookieStoreId || null) !== (from.cookieStoreId || null)) continue;
    const tab = Tabs.getTab(tabs[i].id);
    if (!tab || !tab.isOn) continue;
    const mainPlayerFrame = tab.getMainPlayer();
    if (mainPlayerFrame) {
      // What was found since its player cleared its list.
      const since = (/** @type {object} */ found) => !tab.clearedSources.has(found);
      chrome.tabs.sendMessage(tab.tabId, {
        type: MessageTypes.SOURCES,
        subtitles: frame.getSubtitles().filter(since),
        sources: frame.getSources().filter(since),
        autoSetSource: false,
      }, () => {
        BackgroundUtils.checkMessageError('sources');
      });
    }
  }
}

/**
 * @param {{url: string, requestId: string|number, customHeaders?: *, time?: number,
 *   responseHeaders?: Array<{name: string, value?: string}>}} details
 * @param {FrameHolder & FrameExtras} frame
 * @param {string} mode
 */
async function onSourceRecieved(details, frame, mode) {
  // Before any await: deleteHeaderCache, a second onHeadersReceived listener, runs at the first one.
  const customHeaders = details.customHeaders || frame.tab.requestHeaders.get(details.requestId);

  const url = details.url;

  // Before the first await too: the page's stand-in headers for the same stream must not win.
  if (getSourceFromURL(frame, url)) {
    // Asked for again: an open that found no video on screen before may find it now.
    reopenMissed(frame);
    return;
  }

  // A recovered stream keeps when the page asked for it; a redirected one, its first address.
  // Served as the type it is: mpv opens it by its address (MpvHlsPackage).
  const typed = !!details.responseHeaders && modeFromContentType(details.responseHeaders) === mode;
  addSource(frame, url, mode, customHeaders, details.time,
      details.requestId !== undefined ? frame.tab.redirectOrigin(details.requestId) : null, typed);

  await ensureOptions();
  // Not for a known piece: a page's own player fetches thousands in an evening, each a read and a header rule.
  if (frame.tab.isOn && !isKnownPiece(frame, url)) {
    Lengths.probe({url, mode, headers: customHeaders});
  }

  // Not with MPV mode switched off (leaveMpvWhenOff).
  if (frame.tab.isOn && frame.tab.isMpv && Options.mpvMode) {
    if (frame.tab.mpvOnPlay && !(frame.tab.mpvNextEpisodeUntil > Date.now())) {
      // The shortcut's MPV: only tracked for onUserPlay, unless a play is waiting for this stream.
      const tab = frame.tab;
      const candidate = {frame, document: frame.documentKey, url, mode, headers: customHeaders};
      if (tab.mpvPlayChecking) {
        // Next in line should that one be another video's: dropped, the episode's own went unsent.
        tab.mpvPlayChecking.push(candidate);
      } else if (tab.mpvPlayPendingUntil > Date.now()) {
        await sendPendingPlay(tab, candidate);
      }
      return;
    }

    // The first stream of a page only, unless known to show no video: each would open its own mpv window.
    if (!frame.tab.mpvAutoOpened && !showsNoVideo({url, mode}, frame)) {
      if (frame.tab.mpvNextEpisodeUntil > Date.now()) {
        pickNextEpisodeForMpv(frame.tab);
      } else {
        autoOpenInMpv(frame.tab, url, customHeaders);
      }
    }
    return;
  }

  // Another piece of the same stream: the first piece's captions answer is reused, not asked again.
  let scrape = frame.captionsScrape;
  if (!scrape || scrape.document !== frame.documentKey || !isRepeatPiece(frame, url, mode)) {
    scrape = {
      document: frame.documentKey,
      taken: scrapeCaptionsTags(frame).then((subs) => takeScrapedCaptions(frame, subs)),
    };
    frame.captionsScrape = scrape;
  }
  await scrape.taken;

  if (frame.tab.isOn) {
    clearTimeout(frame.openTimeout);
    frame.openTimeout = setTimeout(() => openPlayerIfVideo(frame), Options.replaceDelay);
  }

  sendSourcesToMainFramePlayers(frame);

  if (Logging) console.log('Found source', details, frame);

  return;
}

/**
 * foundBefore: later streams open the player by themselves, after the page's captions.
 * @param {TabHolder} tab
 * @param {number} [foundBefore]
 */
export async function openPlayersWithSources(tab, foundBefore = Infinity) {
  if (!tabHasSources(tab)) {
    // Each recovered stream opens the player as a detected one does, after the captions and replaceDelay.
    recoverSources(tab);
    return;
  }

  let framesWithSources = [];
  for (const frame of tab.getFrames()) {
    if (!frame.isPlayer && frame.getSources().some(/** @param {TrackedSource} source */ (source) => !(source.time >= foundBefore))) {
      framesWithSources.push(frame);
    }
  }

  if (framesWithSources.length > 0) {
    // Not on the seek bar's thumbnails alone (hasVideoSource).
    framesWithSources = (await Promise.all(framesWithSources.map(async (frame) => {
      // The page measured: a new one in the frame keeps the frame (reset in place).
      const documentKey = frame.documentKey;
      return await hasVideoSource(frame) ? {frame, documentKey, videoSize: await getVideoSize(frame)} : null;
    }))).filter((entry) => entry !== null);

    // A click meanwhile that turned the tab off or to MPV decides.
    if (!tab.isOn || tab.isMpv) {
      return;
    }

    // A frame without an answer sizes 0, not undefined: NaN made the order arbitrary.
    framesWithSources.sort((a, b) => {
      return (b.videoSize || 0) - (a.videoSize || 0);
    });

    for (let i = 0; i < framesWithSources.length; i++) {
      // A frame dropped or showing another page since: OPEN_PLAYER goes by frame id.
      const {frame, documentKey} = framesWithSources[i];
      if (!frame.isTracked() || frame.documentKey !== documentKey) continue;
      openPlayer(frame);
    }
  }
}

/**
 * Sent to every frame: the video usually lives in an iframe.
 * @param {number} tabId
 * @return {void}
 */
export function pauseTabMedia(tabId) {
  if (!Options.mpvPausePage || typeof tabId !== 'number' || tabId < 0) {
    return;
  }
  try {
    chrome.tabs.sendMessage(tabId, {
      type: MessageTypes.PAUSE_MEDIA,
    }, () => {
      // A frame without the content script is normal here.
      BackgroundUtils.checkMessageError('pause_media');
    });
  } catch (e) {
    if (Logging) console.log('[MPV] pauseTabMedia failed:', e);
  }
}

/**
 * @template {keyof PlayerOptions} K
 * @param {K} key
 * @param {PlayerOptions[K]} value
 */
export async function saveOption(key, value) {
  // Merged over DefaultOptions (Utils, which calls them an Object).
  const options = /** @type {PlayerOptions} */ (await Utils.getOptionsFromStorage());
  options[key] = value;
  await Utils.setConfig('options', JSON.stringify(options));
  await loadOptions(options);
  const time = Date.now();
  // An open options page hears UPDATE_OPTIONS; LOAD_OPTIONS left it showing, and saving back, the old value.
  chrome.runtime.sendMessage({type: MessageTypes.UPDATE_OPTIONS, time}).catch(() => {
    // No options page open.
  });
  sendOptionsToTabs(time);
}

/**
 * Once the tabs are known again: right after a wake none were.
 * @param {number} time
 */
function sendOptionsToTabs(time) {
  ensureOptions().then(() => BackgroundUtils.queryTabs()).then((tabs) => {
    tabs.forEach(/** @param {chrome.tabs.Tab} tab */ (tab) => {
      if (Tabs.getTab(tab.id)) {
        // A number: the tracker found a tab by it.
        chrome.tabs.sendMessage(/** @type {number} */ (tab.id), {
          type: MessageTypes.UPDATE_OPTIONS,
          time,
        }, /** @param {unknown} response - Not read. */ (response) => {
          BackgroundUtils.checkMessageError('options', true);
        });
      }
    });
  }).catch((e) => console.error('Sending the new options to the tabs failed', e));
}

/** @param {TabHolder} tab */
export function closeReopenedTab(tab) {
  if (!tab?.mpvReopened) return;
  tab.mpvReopened = false;
  chrome.tabs.get(tab.tabId).then((info) => {
    if (info && !info.active) return chrome.tabs.remove(tab.tabId);
    return undefined;
  }).catch(() => {
    // Gone already.
  });
}

/**
 * The URL as sent, as the URL parser writes it, before mpv's # tags; another quality sent along counts.
 * @param {*} path
 * @param {string} url
 * @param {?Array<{url: string}>} [qualities]
 * @return {boolean}
 */
export function isSentStream(path, url, qualities = null) {
  if (typeof path !== 'string' || typeof url !== 'string') return false;
  const playing = path.split('#')[0];
  const parsedWithoutHash = /** @param {string} candidate */ (candidate) => {
    try {
      const parsed = new URL(candidate);
      parsed.hash = '';
      return parsed.href;
    } catch (e) {
      return null;
    }
  };
  if (playing === url.split('#')[0] || playing === parsedWithoutHash(url)) return true;
  return (Array.isArray(qualities) ? qualities : []).some((entry) => parsedWithoutHash(entry?.url) === playing);
}

/** @param {MpvWatch} state */
export function notifySeriesEnd(state) {
  state.watcher?.notify(chrome.i18n.getMessage('player_next_video_label') || 'Next video',
      chrome.i18n.getMessage('mpv_episode_series_end') || 'the last episode of the series: autoplay stops',
      MpvNoticeSeconds);
}

/**
 * A closed tab's holder lives on in callbacks: saving its state put the closed tab back into storage.session.
 * @param {TabHolder} tab
 * @return {boolean}
 */
export function isTabOpen(tab) {
  return Tabs.getTab(tab.tabId) === tab;
}

/**
 * @param {number} tabId
 * @return {Promise<string|undefined>}
 */
export async function tabTitle(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return (t && t.title) || undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * On a page Back gave back whose own stream is a blob: the page's known stream goes after MpvPlayKnownAfterMs.
 * @param {TabHolder} tab
 * @param {number} frameId
 * @param {string} src
 * @param {?PlayedVideo} video
 */
function autoOpenKnownLater(tab, frameId, src, video) {
  // The page the play came from: within the wait the tab can show another page.
  const documentIn = () => tab.getFrame(frameId)?.documentKey;
  const page = {url: tab.url, document: documentIn()};
  // isTabOpen: a tab closed within the wait still looked like itself, and its stream went to mpv.
  const waiting = () => isTabOpen(tab) && tab.isOn && tab.isMpv && !tab.mpvOnPlay && !tab.mpvAutoOpened &&
    tab.url === page.url && documentIn() === page.document;
  setTimeout(async () => {
    if (!waiting()) {
      return;
    }
    const source = await findPlayedSource(tab, frameId, src, video);
    if (source && waiting()) {
      autoOpenInMpv(tab, source.url, source.headers);
    }
  }, MpvPlayKnownAfterMs);
}

// Firefox's transient activation (dom.user_activation.transient.timeout), as content.js counts a press.
const PressCountsMs = 5000;
// A frame answers within milliseconds unless its page keeps it busy.
const PressAnswerWaitMs = 500;
// Within this of the press, a frame made by it counts: the click's handler can run after the frame began.
const PressOrderSlackMs = 100;

/**
 * A play in a frame that saw no press is the user's when a frame above it saw one within PressCountsMs before the
 * play and before the frame's page began: a play button that loads its player into a new frame below gives that
 * frame no activation (docs/notes/mpv.md). An ad frame that was there before the click does not count. Only for a
 * tab whose MPV takes the user's plays. Times are Date.now()'s, which every frame's performance.timeOrigin shares.
 * @param {chrome.runtime.MessageSender} sender
 * @param {*} playedAt - When the video played.
 * @param {*} documentStart - When the playing frame's page began.
 * @return {Promise<boolean>}
 */
async function pressedAbove(sender, playedAt, documentStart) {
  const now = Date.now();
  if (typeof playedAt !== 'number' || typeof documentStart !== 'number' || !(playedAt <= now + 1000) ||
      !(now - playedAt <= PressCountsMs) || !(documentStart <= playedAt)) {
    return false;
  }
  await ensureOptions();
  const tab = sender.tab?.id !== undefined ? Tabs.getTab(sender.tab.id) : null;
  if (!Options.mpvMode || !tab || !tab.isOn || !tab.isMpv || !tab.mpvOnPlay || typeof sender.frameId !== 'number' ||
      sender.frameId === 0) {
    return false;
  }
  const above = [];
  for (let frame = tab.getFrame(sender.frameId)?.parent; frame; frame = frame.parent) {
    above.push(frame.frameId);
  }
  // The frames' parents are known from their requests: a woken background lost those of frames already there.
  if (!above.includes(0)) above.push(0);
  const pressedAt = await Promise.all(above.map((frameId) =>
    askFrame(tab.tabId, {type: MessageTypes.LAST_PRESS}, {frameId}, 'last_press', PressAnswerWaitMs)));
  return pressedAt.some((at) => typeof at === 'number' && at <= playedAt && playedAt - at <= PressCountsMs &&
    documentStart >= at - PressOrderSlackMs);
}

/**
 * With no stream yet, the next one within MpvPlayPendingMs is taken. In the allowlist's MPV a play counts only on a page Back gave back.
 * A YouTube video goes as its page (youTubeVideo), in either MPV: mpv's yt-dlp finds its streams.
 * @param {chrome.runtime.MessageSender} sender
 * @param {string} src
 * @param {?PlayedVideo} video
 * @param {string} [pageAddress] - The frame's address when the video started.
 */
async function onUserPlay(sender, src, video, pageAddress = '') {
  await ensureOptions();

  if (!Options.mpvMode || !sender.tab || typeof sender.frameId !== 'number') {
    return;
  }

  const tab = Tabs.getTab(sender.tab.id);
  // The page's own address: YouTube moves to the next video by pushState, and the tab's can still be the last one's.
  const youTube = youTubeVideo(pageAddress);
  if (youTube && tab && tab.isOn && tab.isMpv) {
    if (Logging) console.log('[MPV] user started a YouTube video:', youTube.url);
    sendPlayedToMpv(tab, {url: youTube.url, headers: undefined}, video, youTube.url);
    return;
  }
  const waiting = /** @param {boolean} onPlay */ (onPlay) => !!tab && tab.isOn && tab.isMpv && tab.mpvOnPlay === onPlay &&
    (onPlay || !tab.mpvAutoOpened);
  if (!tab || !waiting(tab.mpvOnPlay)) {
    return;
  }
  const onPlay = tab.mpvOnPlay;
  const frame = tab.getFrame(sender.frameId);
  if (!onPlay && !(frame && frame.restoredFromCache)) {
    return;
  }

  // The page the video plays in: the tab may load another while the lengths are read.
  const page = {url: tab.url, document: frame ? frame.documentKey : undefined};
  const source = await findPlayedSource(tab, sender.frameId, src, video);
  // The tab may have left MPV while the lengths were read, or a stream went meanwhile.
  if (!waiting(onPlay)) {
    return;
  }
  const frameNow = tab.getFrame(sender.frameId);
  if (tab.url !== page.url || (frameNow ? frameNow.documentKey : undefined) !== page.document) {
    return;
  }
  if (Logging) console.log('[MPV] user started a video:', src, source && source.url);
  if (!onPlay) {
    if (source && source.url === src) {
      // The file the video plays, among the page's streams.
      autoOpenInMpv(tab, source.url, source.headers);
    } else {
      autoOpenKnownLater(tab, sender.frameId, src, video);
    }
  } else if (source) {
    sendPlayedToMpv(tab, source, video);
  } else {
    // None yet, or another video's: the next stream of a fitting length decides.
    tab.mpvPlayedVideo = video || null;
    tab.mpvPlayPendingUntil = Date.now() + MpvPlayPendingMs;
    Tabs.saveTabState(tab);
    // Nothing of the tab known: Firefox stopped the idle background; the page says what it loaded.
    if (!tabHasSources(tab)) {
      recoverSources(tab);
    }
  }
}

/**
 * The first whose length can be the video's: the first stream after a play can be a preview's or an ad's.
 * @param {TabHolder} tab
 * @param {{frame: FrameHolder, document: ?string, url: string, mode: string, headers: *}} first
 * @return {Promise<void>}
 */
async function sendPendingPlay(tab, first) {
  const until = tab.mpvPlayPendingUntil;
  const url = tab.url;
  const queue = [first];
  tab.mpvPlayChecking = queue;
  tab.mpvPlayPendingUntil = 0;
  Tabs.saveTabState(tab);
  try {
    while (queue.length > 0) {
      const candidate = /** @type {typeof first} */ (queue.shift());
      await Lengths.settle(() => [candidate], SourceLengthWaitMs);
      // A new page, a reload or MPV started again drop the play (and this queue).
      if (tab.mpvPlayChecking !== queue || tab.url !== url) {
        return;
      }
      // Another page, another video's length, or no video of its own (thumbnails, a piece).
      if (candidate.frame.documentKey !== candidate.document ||
          StreamPick.conflicts(tab.mpvPlayedVideo, Lengths.lengthOf(candidate.url)) ||
          showsNoVideo(candidate, candidate.frame)) {
        continue;
      }
      if (tab.isOn && tab.isMpv && tab.mpvOnPlay) {
        sendPlayedToMpv(tab, candidate, tab.mpvPlayedVideo);
      }
      return;
    }
    // Each was another video's: the next one may be the video's, while the wait lasts.
    tab.mpvPlayPendingUntil = until;
    Tabs.saveTabState(tab);
  } finally {
    if (tab.mpvPlayChecking === queue) {
      tab.mpvPlayChecking = null;
    }
  }
}

/**
 * Its own URL first (a preloaded file); else by length, the longest over a short ad; a pick plainly another length is none.
 * @param {TabHolder} tab
 * @param {number} frameId
 * @param {string} src
 * @param {?PlayedVideo} video
 * @return {Promise<?TrackedSource>}
 */
async function findPlayedSource(tab, frameId, src, video) {
  /** @type {TrackedSource|null|undefined} */
  let byUrl = null;
  if (/^https?:\/\//i.test(src)) {
    for (const frame of tab.getFrames()) {
      byUrl = getSourceFromURL(frame, src);
      if (byUrl) {
        break;
      }
    }
  }

  // TabTracker's map is not typed: one of the tab's frames, or none.
  const frame = /** @type {FrameHolder|undefined} */ (tab.getFrame(frameId));
  const others = frame ? frame.getSources().filter((source) => source !== byUrl) : [];
  if (byUrl && others.length === 0) {
    return byUrl;
  }
  if (!frame) {
    return null;
  }

  // A stream asked for before this tab's MPV started has no length read: read now, even alone.
  if (frame.getSources().length > 1 || StreamPick.lengthOf(video ? video.duration : null) !== null) {
    await Lengths.settle(() => frame.getSources(), SourceLengthWaitMs);
  }

  const sources = frame.getSources();
  const lengths = Lengths.lengthsOf(sources);
  /** @type {Array<{source: *, url: string, duration?: ?number}>} */
  const measured = StreamLength.withoutStills(sources.map((source, i) => ({source, url: source.url, duration: lengths[i]})));
  const videoLength = StreamPick.lengthOf(video ? video.duration : null);
  if (byUrl) {
    // Unless a far longer stream plays beside it: then the video is a preroll or a preview.
    const length = StreamPick.lengthOf(Lengths.lengthsOf([byUrl])[0]) ?? videoLength;
    if (!StreamPick.outrun(measured.filter((entry) => entry.source !== byUrl), length)) {
      return byUrl;
    }
    return newestOfLongest(sources, video);
  }

  const picked = newestOfLongest(sources, video);
  // Another length is not its stream, unless the video is the ad.
  if (picked && !StreamPick.outrun(measured, videoLength) &&
      StreamPick.conflicts(video, Lengths.lengthsOf([picked])[0])) {
    return null;
  }
  return picked;
}

/**
 * Of ties the newest; never stills (mpv would show thumbnails), nor a piece of a stream.
 * @param {Array<TrackedSource>} sources
 * @param {?PlayedVideo} [video]
 * @return {?TrackedSource}
 */
export function newestOfLongest(sources, video = null) {
  const lengths = Lengths.lengthsOf(sources);
  /** @type {Array<{source: *, url: string, duration?: ?number}>} */
  const measured = StreamLength.withoutStills(sources.map((source, i) => ({source, url: source.url, duration: lengths[i]})))
      .filter((entry) => entry.duration !== PIECE_LENGTH);
  const longest = StreamPick.played(measured, video) || StreamLength.longest(measured);
  /** @type {*} */
  let newest = null;
  for (const {source} of longest) {
    if (!newest || source.time > newest.time) {
      newest = source;
    }
  }
  return newest;
}

/**
 * @param {{url: string, mode: string}} source
 * @param {FrameHolder} frame
 * @return {boolean}
 */
function showsNoVideo(source, frame) {
  const length = Lengths.lengthsOf([source, ...frame.getSources()])[0];
  return length === PIECE_LENGTH || length === STILLS_LENGTH;
}

/**
 * Opening a player pauses only what is inside its box: a site's player outside it played on.
 * @param {TabHolder} tab
 */
function sendPageMediaHold(tab) {
  for (const frameId of tab.playingPlayers) {
    if (!tab.getFrame(frameId)) {
      tab.playingPlayers.delete(frameId);
    }
  }
  chrome.tabs.sendMessage(tab.tabId, {
    type: MessageTypes.HOLD_PAGE_MEDIA,
    hold: tab.playingPlayers.size > 0,
  }, () => {
    // A frame without a content script is normal here.
    BackgroundUtils.checkMessageError('hold_page_media', true);
  });
}

/**
 * @param {?TabHolder} tab
 * @param {string} url
 * @return {Promise<?{url: string, list: Array<Object>}>}
 */
export async function pageQualityChoice(tab, url) {
  if (!tab) return null;
  for (const frame of tab.getFrames()) {
    const source = frame.getSources().find(/** @param {TrackedSource} s */ (s) => s.url === url || s.requestedUrl === url);
    if (!source) continue;
    const list = listForSource(source, await getPageQualities(tab, frame.frameId));
    if (!list) continue;
    const best = pickQuality(list, desiredHeight(Options.defaultQuality));
    return {url: best ? best.url : url, list};
  }
  return null;
}

/**
 * A master whose variants cannot play alone goes as the master (mpv's hls-bitrate=max), as do its audio and subtitles playlists.
 * @param {?TabHolder} tab
 * @param {string} url
 * @return {Promise<?{url: string, list: ?Array<Object>}>}
 */
export async function hlsQualityChoice(tab, url) {
  let hls = Lengths.hlsQualities(url);
  if (!hls) {
    // Every HLS playlist of the tab still read is waited for: a variant's read may end before the master's.
    const sources = tab ? [...tab.getFrames()].flatMap((frame) => frame.getSources()) : [];
    const hlsSources = sources.filter((s) => s.mode === PlayerModes.ACCELERATED_HLS);
    const pending = hlsSources.filter((s) => Lengths.lengthOf(s.url) === undefined);
    if (hlsSources.some((s) => s.url === url) && pending.length > 0) {
      let timer;
      await Promise.race([
        Promise.all(pending.map((source) => Lengths.probe(source))),
        new Promise((resolve) => {
          timer = setTimeout(resolve, HlsQualitiesWaitMs);
        }),
      ]);
      clearTimeout(timer);
      hls = Lengths.hlsQualities(url);
    }
  }
  if (!hls) return null;
  if (!hls.list) return hls.master !== url ? {url: hls.master, list: null} : null;
  const best = pickQuality(hls.list, desiredHeight(Options.defaultQuality));
  return {url: best ? best.url : hls.master, list: hls.list};
}

/** @type {Array<'requestHeaders'|'extraHeaders'|'blocking'>} */
const webRequestPerms = ['requestHeaders'];
// Detection reads a page load's Content-Type, to tell an HTML page from a stream.
/** @type {Array<'responseHeaders'|'extraHeaders'|'blocking'>} */
const webRequestPerms2 = ['responseHeaders'];


/**
 * No player opens there: kept, tab -1 collected every such stream for the session and sent them to every player tab.
 * @param {{tabId: number}} details
 * @return {boolean}
 */
function isTablessRequest(details) {
  return details.tabId === chrome.tabs.TAB_ID_NONE;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  VpnMirror.noteRequest(details);
  if (isTablessRequest(details)) return;
  const tab = Tabs.getTabOrCreate(details.tabId);
  const frame = tab.getFrameOrCreate(details.frameId);
  if (!frame.parent && details.parentFrameId !== -1) {
    const parentFrame = tab.getFrameOrCreate(details.parentFrameId);
    frame.setParentFrame(parentFrame);
  }
}, {
  urls: ['<all_urls>'],
});

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (isTablessRequest(details)) return;
  Tabs.getTabOrCreate(details.tabId).rememberRequestHeaders(details.requestId, details.requestHeaders);
}, {
  urls: ['<all_urls>'],
}, webRequestPerms);

// A redirect's first address: a page's player lists its files by it, and the stream is found at the redirect's end.
chrome.webRequest.onBeforeRedirect.addListener((details) => {
  if (isTablessRequest(details)) return;
  Tabs.getTabOrCreate(details.tabId).noteRedirect(details.requestId, details.url);
}, {
  urls: ['<all_urls>'],
  types: ['media', 'xmlhttprequest', 'other', 'main_frame', 'sub_frame'],
});


chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (isTablessRequest(details)) {
        return;
      }
      const tab = Tabs.getTabOrCreate(details.tabId);
      const frame = tab.getFrameOrCreate(details.frameId);
      if (frame.hasPlayer()) return;
      const found = classifyResponse(details, tab.redirectOrigin(details.requestId), CustomSourcePatternsMatcher);
      if (found.kind === 'subtitles') {
        VpnMirror.noteSource(details, {stream: false});
        handleSubtitles(details.url, frame, tab.requestHeaders.get(details.requestId));
      } else if (found.kind === 'source') {
        VpnMirror.noteSource(details);
        onSourceRecieved(details, frame, found.mode);
      }
    }, {
      urls: ['<all_urls>'],
    }, webRequestPerms2,
);

// A manifest whose address and Content-Type name no type (text/plain at /pl/7?token=...): told by its first bytes.
// Registered before deleteHeaderCache, which forgets the request's headers.
const filterResponseData = /** @type {*} */ (chrome.webRequest).filterResponseData;
if (typeof filterResponseData === 'function') {
  chrome.webRequest.onHeadersReceived.addListener(
      (details) => {
        if (isTablessRequest(details) || !worthSniffing(details)) return;
        const tab = Tabs.getTabOrCreate(details.tabId);
        const frame = tab.getFrameOrCreate(details.frameId);
        if (frame.hasPlayer()) return;
        if (classifyResponse(details, tab.redirectOrigin(details.requestId), CustomSourcePatternsMatcher).kind !== 'ignore') return;
        const customHeaders = tab.requestHeaders.get(details.requestId);
        const documentKey = frame.documentKey;
        sniffManifest((requestId) => filterResponseData(requestId), details.requestId).then((mode) => {
          if (!mode || !frame.isTracked() || frame.documentKey !== documentKey || frame.hasPlayer()) return;
          VpnMirror.noteSource(details);
          return onSourceRecieved({url: details.url, requestId: details.requestId, customHeaders}, frame, mode);
        }).catch((e) => {
          console.error('A manifest told by its first bytes was not taken', e);
        });
      }, {
        urls: ['<all_urls>'],
        types: ['xmlhttprequest', 'other'],
      }, ['blocking', 'responseHeaders'],
  );
}

chrome.webRequest.onHeadersReceived.addListener(deleteHeaderCache, {
  urls: ['<all_urls>'],
});


chrome.webRequest.onErrorOccurred.addListener(deleteHeaderCache, {
  urls: ['<all_urls>'],
});

/**
 * @param {{tabId: number, frameId: number, requestId: string}} details
 * @return {undefined}
 */
function deleteHeaderCache(details) {
  Tabs.forgetRequestHeaders(details.tabId, details.requestId);
}

ensureOptions();

Utils.printWelcome(ExtensionVersion);
