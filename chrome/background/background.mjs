// @ts-check
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {STILLS_LENGTH, StreamLength} from '../player/utils/StreamLength.mjs';
import {StreamPick} from '../player/utils/StreamPick.mjs';
import {StringUtils} from '../player/utils/StringUtils.mjs';
import {URLUtils} from '../player/utils/URLUtils.mjs';
import {Utils} from '../player/utils/Utils.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';
import {parseCustomSourcePatterns} from './CustomSourcePatterns.mjs';
import {sanitizeDownloadFilename} from './DownloadFilename.mjs';
import {KeyShortcut} from './KeyShortcut.mjs';
import {modeFromContentType, modeFromMediaType} from './ManifestTypes.mjs';
import {MessageTypes} from '../player/enums/MessageTypes.mjs';
import {MpvBackend} from './MpvBackend.mjs';
import {MultiRegexMatcher} from './MultiRegexMatcher.mjs';
import {RuleManager} from './NetRequestRuleManager.mjs';
import {StreamLengths} from './StreamLengths.mjs';
import {TabTracker} from './TabTracker.mjs';
import {UrlMatchList} from './UrlMatchList.mjs';

let Options = {};
const OptionsCache = {};

// "Auto-enable URLs": prefix, `~` regex and `!` exclusion like the MPV allowlist, and
// `-domain` to exclude a whole site, from the redirect of manifest links too.
const AutoEnableList = new UrlMatchList({domainEntriesExclude: true});
const MpvAllowlist = new UrlMatchList();
const Mpv = new MpvBackend();

// Guards the manual "send to mpv" button against repeat clicks.
const ManualMpvRepeatMs = 3000;
let LastManualMpvUrl = '';
let LastManualMpvTime = 0;

// The shortcut's MPV waits for the user to start a video (onUserPlay). A play
// whose stream is not detected yet takes the next one within MpvPlayPendingMs;
// the same video played again within MpvPlayRepeatMs is the player repeating
// itself, not a second request.
const MpvPlayPendingMs = 15000;
const MpvPlayRepeatMs = 10000;
// The allowlist's MPV, on a page Back gave back: how long a play whose stream is not
// known waits for it to be detected before the page's known stream goes
// (autoOpenKnownLater).
const MpvPlayKnownAfterMs = 3000;

// How long a tab stays "armed" after content.js reports focus moving into
// one of its player iframes (see the tabs.onCreated listener below). Short
// on purpose: a popup/popunder script reacting to that same blur event fires
// within tens of ms, while a deliberate unrelated action from the user
// (e.g. middle-clicking a different link) takes noticeably longer to
// physically happen - so this window trades a little bit of the former for
// a lot less risk of the latter.
const PopupGuardArmMs = 700;
// How long the guard stays armed after actually closing a tab, to catch a
// popup/popunder script that opens more than one tab off a single click
// without leaving the guard live long enough to catch unrelated activity.
const PopupGuardChainMs = 400;

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
function resolveMpvContentType(explicit, url) {
  if (explicit === 'anime' || explicit === 'movie') {
    return explicit;
  }
  return MpvAllowlist.getContentType(url) || 'movie';
}

// Resolves once options have been read from storage. Clicks and navigation
// events can arrive before the initial load completes (fresh install,
// add-on reload); awaiting this prevents them from acting on an empty
// Options object, where mpvMode and the allowlist would read as disabled.
// The toolbar state saved before the event page was last unloaded comes back
// on the same promise, for the same reason: an allowlisted site's reload would
// otherwise find no record of the user's choice and auto-start MPV again.
/** @type {?Promise<*>} */
let OptionsLoadPromise = null;
function ensureOptions() {
  if (!OptionsLoadPromise) {
    OptionsLoadPromise = Promise.all([
      loadOptions(),
      Tabs.restoreTabStates(),
    ]).catch((e) => {
      console.error('Loading the options failed', e);
      // The next event tries again. Kept, the failure stood until the event page unloaded,
      // and every event acted on no options: MPV mode and both URL lists off.
      OptionsLoadPromise = null;
    });
  }
  return OptionsLoadPromise;
}
const ExtensionVersion = chrome.runtime.getManifest().version;
// The debug lines (`if (Logging)`) are on for a temporary install - the e2e suites'
// (installAddOn(xpi, true)) and a developer's (web-ext run, about:debugging) - and off for
// an installed release. The e2e configs print the background's console into each spec's
// driver log, which CI keeps for a failed or retried spec: what the background detected,
// opened and sent to mpv. getSelf() needs no permission; it answers within a tick, before
// any page the tests open sends a request.
let Logging = false;
chrome.management.getSelf().then((self) => {
  Logging = self.installType === 'development';
}).catch(console.error);
const Tabs = new TabTracker();
const ruleManager = new RuleManager();

// How long each detected stream plays, so that the longest of a page's streams plays and
// not the ad (StreamLength.longest). The reads go out from this background, in no tab:
// the rule that gives them the page's headers matches on that.
const Lengths = new StreamLengths({
  setHeaders: (url, commands) => ruleManager.addHeaderRule(url, chrome.tabs.TAB_ID_NONE, commands),
});
// The longest a player waits for the lengths still being read.
const SourceLengthWaitMs = 2500;
// The longest a player waits for the page to say what its video played (getPlayedVideo).
// The page answers within milliseconds unless its own scripts keep it busy; then the
// longest decides, as before the question.
const PlayedVideoWaitMs = 1000;


let CustomSourcePatternsMatcher = new MultiRegexMatcher();

BackgroundUtils.openWelcomePageOnInstall();

// After the restore, or a woken event page would reset every tab's icon to Off.
ensureOptions().then(() => BackgroundUtils.queryTabs()).then((ctabs) => {
  ctabs.forEach((tabobj) => {
    const tab = Tabs.getTabOrCreate(tabobj.id);
    try {
      BackgroundUtils.updateTabIcon(tab, true);
    } catch (e) {
      console.error(e);
    }
  });
}).catch((e) => console.error('Updating the tab icons failed', e));

const EmptyTabUrls = ['about:blank', 'about:home', 'about:newtab', 'about:privatebrowsing'];

// How many players openPlayer has asked for, to number each attempt (frame.playerOpeningAttempt).
let playerOpeningAttempts = 0;

/**
 * Whether the tab has FastStream's in-page player up, or on its way.
 *
 * frame.playerOpening flips true the moment OPEN_PLAYER is sent, well before
 * PLAYER_LOADED sets frame.isPlayer - checking isPlayer alone leaves a window
 * where the overlay iframe already exists on the page but goes undetected, so
 * a stale overlay survives an Off that should have torn it down, or stays up
 * while mpv plays the same stream in its own window.
 *
 * @param {Object} tab - TabHolder to check.
 * @return {boolean} True when an in-page player is open or opening.
 */
function hasOrOpeningPlayer(tab) {
  for (const frame of tab.getFrames()) {
    if (frame.playerOpening || frame.isPlayer) {
      return true;
    }
  }
  return false;
}

// How long the tab gets to say it holds a player. Each frame answers at once or not at
// all, so this only runs out for a tab without one.
const HasPlayerTimeoutMs = 1000;

/**
 * Whether the tab has an in-page player, asking the tab itself when this background
 * knows of none. What it knows lives in memory, and a background that was stopped and
 * started again knows nothing, while the player stays on the page. Idling does not do
 * that while a player is open - an open extension page keeps the event page running
 * (measured 2026-09-28: 60 s idle, still running; closed, it stopped) - but Firefox can
 * still stop it, after a hang or with about:debugging's Terminate. Off then left the
 * player playing under a toolbar that said Off.
 *
 * @param {Object} tab - TabHolder to check.
 * @return {Promise<boolean>}
 */
async function tabHasPlayer(tab) {
  if (hasOrOpeningPlayer(tab)) {
    return true;
  }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), HasPlayerTimeoutMs);
    chrome.tabs.sendMessage(tab.tabId, {type: MessageTypes.HAS_PLAYER}, (response) => {
      // No content script (a blank or privileged page) is a tab without a player.
      void chrome.runtime.lastError;
      clearTimeout(timer);
      resolve(response === true);
    });
  });
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
 * @param {Object} tab - TabHolder to switch.
 * @param {boolean} [onPlay] - Wait for the user to start a video.
 * @return {Promise<void>}
 */
async function startMpv(tab, onPlay = false) {
  tab.isOn = true;
  tab.isMpv = true;
  tab.mpvOnPlay = onPlay;
  BackgroundUtils.updateTabIcon(tab);

  if (await tabHasPlayer(tab)) {
    tab.resetForReload();
    chrome.tabs.reload(tab.tabId);
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
 * @param {Object} tab - TabHolder to switch.
 * @return {Promise<void>}
 */
async function stopMpv(tab) {
  tab.isOn = false;
  tab.isMpv = false;
  tab.mpvOnPlay = false;
  BackgroundUtils.updateTabIcon(tab);

  if (await tabHasPlayer(tab)) {
    tab.resetForReload();
    chrome.tabs.reload(tab.tabId);
  }
}

/**
 * The toolbar button, and the toggle_player shortcut (Ctrl+Shift+F unless the user
 * rebinds it) with playerKey.
 *
 * The button cycles MPV -> Off -> On -> MPV on a site on the MPV Allowlist, and turns
 * FastStream off or on everywhere else; from MPV a click is Off. The key is the in-page
 * player's own switch: from MPV - the allowlist's or the MPV key's - it goes straight
 * to the player, and otherwise turns the player off or on, on the allowlist too. So
 * each key turns on its own mode whatever mode the tab is in, and the last key pressed
 * decides. The key used to be the button (_execute_action), and after the MPV key it
 * turned FastStream off: getting the player took a second press.
 *
 * @param {Object} tabobj - The tab the button was clicked or the key pressed in.
 * @param {{playerKey?: boolean}} [how] - playerKey: the shortcut, not the button.
 */
async function onClicked(tabobj, {playerKey = false} = {}) {
  await ensureOptions();

  const tab = Tabs.getTabOrCreate(tabobj.id);

  // check permissions
  const hasPerms = await BackgroundUtils.checkPermissions();
  if (!hasPerms) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('perms.html'),
    });
    return;
  }

  if (tabobj.url) {
    tab.url = tabobj.url;
  }

  if (tab.url && !EmptyTabUrls.includes(tab.url)) {
    if (!BackgroundUtils.isUrlPlayerUrl(tab.url)) {
      if (playerKey && tab.isOn && tab.isMpv) {
        // MPV -> On. MPV never opens an in-page player, so there is none to take down
        // (a player on the page when MPV started was reloaded away), and the page's
        // video goes to the player from the sources already tracked, as Off -> On does.
        tab.isMpv = false;
        tab.mpvOnPlay = false;
        BackgroundUtils.updateTabIcon(tab);
        openPlayersWithSources(tab);
      } else if (!playerKey && Options.mpvMode && MpvAllowlist.matches(tab.url)) {
        // MPV mode only applies on allowlisted URLs; everywhere else the
        // toolbar keeps its original Off/On behavior.
        if (Logging) console.log('[MPV] toolbar cycle on allowlisted URL:', tab.url);
        // Cycle: MPV → Off → On → MPV. A click on the glowing purple icon
        // turns FastStream off outright (matching the ordinary Off/On
        // toggle's "click stops it" behavior everywhere else), rather than
        // falling back to the in-page player; a second click turns the
        // in-page player on; a third hands the stream to mpv again.
        if (tab.isMpv) {
          // MPV -> Off
          await stopMpv(tab);
        } else if (tab.isOn) {
          // On -> MPV
          await startMpv(tab);
        } else {
          // Off -> On
          tab.isOn = true;
          tab.regexMatched = true;
          BackgroundUtils.updateTabIcon(tab);
          openPlayersWithSources(tab);
        }
      } else {
        tab.isOn = !tab.isOn;
        tab.isMpv = false;

        BackgroundUtils.updateTabIcon(tab);

        if (tab.isOn) {
          openPlayersWithSources(tab);
        } else if (await tabHasPlayer(tab)) {
          // A player still loading counts: the MPV cycle already checks it, and without
          // it an Off clicked right after On left the player on the page.
          tab.resetForReload();
          chrome.tabs.reload(tab.tabId);
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

/**
 * The toggle_mpv shortcut (Alt+F unless the user rebinds it; Ctrl+Shift+U until
 * 2026-10-04): MPV on or
 * off for the tab, on any site. Unlike the toolbar cycle it does not need the
 * site on the MPV Allowlist - pressing it is the deliberate choice the
 * allowlist otherwise makes for the user. Off means FastStream off, the same
 * as the toolbar's MPV -> Off step. From the in-page player it goes straight to
 * MPV, as Ctrl+Shift+F goes from MPV straight to the player (onClicked).
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
 * @param {Object} tabobj - The tab that was active when the key was pressed.
 */
async function onToggleMpv(tabobj) {
  await ensureOptions();

  if (!Options.mpvMode) {
    return;
  }

  const hasPerms = await BackgroundUtils.checkPermissions();
  if (!hasPerms) {
    chrome.tabs.create({
      url: chrome.runtime.getURL('perms.html'),
    });
    return;
  }

  const tab = Tabs.getTabOrCreate(tabobj.id);
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

chrome.commands.onCommand.addListener((command, tabobj) => {
  if (!tabobj) {
    return;
  }
  if (command === 'toggle_player') {
    onClicked(tabobj, {playerKey: true});
  } else if (command === 'toggle_mpv') {
    onToggleMpv(tabobj);
  }
});

/**
 * A key press the page cancelled, which Firefox therefore never ran as a
 * shortcut (content.js reports only those). Runs the command it is bound to,
 * as Firefox would have: toggle_player (Ctrl+Shift+F by default) or toggle_mpv.
 * The bindings are read fresh, so a key rebound on about:addons counts at once.
 *
 * @param {Object} press - The key press; see KeyShortcut's KeyPress.
 * @param {Object} tabobj - The tab it was pressed in.
 */
async function onCancelledShortcut(press, tabobj) {
  const commands = await chrome.commands.getAll();
  const isMac = navigator.platform.startsWith('Mac');
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
  Tabs.removeTab(tabid);
});

// Closes a tab opened right after the user's click landed on a player
// iframe (see the POPUP_GUARD_ARM handler and content.js's 'blur' listener).
// Both actual popups (the new tab steals focus) and popunders (it doesn't)
// go through here - gating on the arm window rather than "is a player
// running in the opener tab" is what keeps this from touching a tab the user
// opens deliberately (e.g. middle-clicking a link elsewhere on the page),
// since that never blurs the top window the way a click into our iframe
// does. Two caveats this can't fully close: the arm message is an async
// chrome.runtime.sendMessage to the background - on a cold event page a
// popup/popunder that calls window.open() synchronously from the same blur
// handler can create its tab before the arm message is even processed, so
// the guard is more reliable once the page is already running from an earlier
// interaction. And because the signal is only "a click landed on the player
// recently", not "this exact tab-creation was caused by that click", a
// short window still means a deliberate action within it (e.g. a very fast
// middle-click elsewhere right after clicking the video) could get caught -
// PopupGuardArmMs is kept short specifically to make that collision rare
// without also making the common case (an ad script reacting to the same
// blur within tens of ms) unreliable.
chrome.tabs.onCreated.addListener(async (newTab) => {
  await ensureOptions();
  if (!Options.blockPopupsWhilePlaying) return;

  const openerTabId = newTab.openerTabId;
  if (typeof openerTabId !== 'number') return;

  const openerTab = Tabs.getTab(openerTabId);
  if (!openerTab || openerTab.popupGuardArmedUntil <= Date.now()) return;

  if (Logging) console.log('[PopupGuard] Closing tab opened right after a click on the player', openerTabId, newTab.id, newTab.url);
  chrome.tabs.remove(/** @type {number} */ (newTab.id));

  // Re-arm briefly rather than clearing outright: a single popup/popunder
  // script commonly chains two or three tabs off one click, and this still
  // keeps the guard from lingering long enough to catch an unrelated later
  // tab the user opens on their own.
  openerTab.popupGuardArmedUntil = Date.now() + PopupGuardChainMs;
});

chrome.tabs.onUpdated.addListener(async (tabid, changeInfo, tabobj) => {
  await ensureOptions();

  const tab = Tabs.getTabOrCreate(tabid);

  if (changeInfo.url) {
    const url = new URL(changeInfo.url);
    const oldURL = tab.url ? new URL(tab.url) : null;
    if (oldURL && oldURL.hostname !== url.hostname) {
      // Keeps the new site's page when it named itself first (TabHolder.resetForNewSite).
      tab.resetForNewSite(changeInfo.url);
      // A different site is a fresh decision. mpvMatched is what stops the
      // allowlist from re-arming MPV mode after the user switched it off, so
      // it has to be dropped here or MPV stays off for the rest of the tab's
      // life. Cleared here rather than in tab.reset(), which also runs on the
      // toolbar's Off path, where re-arming would undo the click.
      tab.mpvMatched = false;
    }

    // Only the fragment changed (an anchor, #t=...): still the same page, whose player
    // plays on. Taken for a new page, the latch reset below let the page's next stream
    // request (a quality switch) open a second mpv window, and the in-page player was
    // taken down. content.js's link handler already keeps the player for such a link.
    const samePage = BackgroundUtils.isSamePageUrlChange(tab.url, changeInfo.url);
    tab.url = changeInfo.url;

    if (!samePage) {
      // The auto-open latch is per page, not per tab. The reset above only runs on
      // a hostname change, so without this a second episode on the same site is
      // detected and then dropped, because the tab still looks like it has
      // already handed a stream to mpv.
      tab.mpvAutoOpened = false;
      tab.mpvSentUrls.clear();
      tab.mpvError = null;
      tab.mpvHostOutdated = false;
      tab.mpvDecoder = null;
      tab.mpvDecoderQuery = null;
      tab.mpvPlayPendingUntil = 0;
      tab.mpvPlayedVideo = null;
      tab.mpvPlayChecking = null;
      clearTimeout(tab.urlStartTimer);

      chrome.tabs.sendMessage(tabid, {
        type: MessageTypes.REMOVE_PLAYERS,
      }, {
        frameId: 0,
      }, () => {
        BackgroundUtils.checkMessageError('remove_players');
      });
    }

    const shouldAutoEnable = AutoEnableList.matches(changeInfo.url);

    const isPlayerUrl = BackgroundUtils.isUrlPlayerUrl(tab.url);
    const mpvSite = !!Options.mpvMode && MpvAllowlist.matches(tab.url);
    if (Logging) console.log('[MPV] check:', tab.url, 'mpvMode:', !!Options.mpvMode, 'mpvSite:', mpvSite);

    if (isPlayerUrl) {
      tab.isOn = true;
      tab.regexMatched = true;
      // The player page has no MPV mode. The MPV key's arm on a new tab would show
      // there (Ctrl+Shift+F on that tab opens this page), with nothing to send.
      tab.isMpv = false;
      tab.mpvOnPlay = false;
    } else if (mpvSite && !tab.mpvMatched) {
      // Visiting an allowlisted site auto-starts MPV mode.
      if (Logging) console.log('[MPV] auto-start on allowlisted URL:', tab.url);
      tab.regexMatched = true;
      tab.mpvMatched = true;
      tab.isOn = true;
      tab.isMpv = true;
      // The allowlist's own rule, even if the shortcut armed this tab.
      tab.mpvOnPlay = false;
      startWithTrackedLater(tab, changeInfo.url, () => tab.isMpv && !tab.mpvOnPlay && !tab.mpvAutoOpened,
          () => openMpvWithSources(tab));
    } else if (shouldAutoEnable && !tab.regexMatched && !(tab.isMpv && tab.mpvOnPlay)) {
      // Not for a tab armed with the MPV shortcut: the user's own choice for the tab
      // outranks the standing list, so the first video they start here still goes to mpv.
      tab.regexMatched = true;
      tab.isOn = true;
      // Allowlisted sites default to MPV mode; everything else uses the
      // in-page player.
      tab.isMpv = mpvSite;
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
});

// How long a start by address (the MPV allowlist, the auto-enable list) waits before it
// acts on the streams the tab already tracks (startWithTrackedLater).
const UrlStartSettleMs = 500;

/**
 * Starts MPV or the in-page player for a tab whose address just matched a list, from the
 * streams it tracks, once the new page had the time to name itself. tabs.onUpdated can come
 * before the new page's FRAME_ADDED, which drops the page before's streams: the trailer a
 * site's home page played went to mpv for the episode the user opened from it (an
 * allowlist entry for its /watch path), the episode's own stream found the page handed off
 * already, and was only tracked. A stream the new page asks for meanwhile goes by itself
 * (onSourceRecieved), and the start leaves it to that: it acts only on streams found before
 * the address changed (start gets that time). A page that changes its address itself
 * (pushState) names no new page, and what the tab tracked then is that page's.
 * @param {TabHolder} tab - The tab.
 * @param {string} url - The address that matched.
 * @param {() => boolean} stillWanted - Whether the start still applies then.
 * @param {(foundBefore: number) => *} start - The start, given the address change's time.
 */
function startWithTrackedLater(tab, url, stillWanted, start) {
  // The tab's next address change cancels it (tabs.onUpdated).
  const changedAt = Date.now();
  tab.urlStartTimer = setTimeout(() => {
    if (Tabs.getTab(tab.tabId) === tab && tab.url === url && tab.isOn && stillWanted()) {
      start(changedAt);
    }
  }, UrlStartSettleMs);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === MessageTypes.PING) {
    sendResponse(MessageTypes.PONG);
    return;
  } else if (msg.type === MessageTypes.LOAD_OPTIONS) {
    loadOptions();
    // sent to all tabs
    BackgroundUtils.queryTabs().then((tabs) => {
      tabs.forEach((tab) => {
        if (Tabs.getTab(tab.id)) {
          chrome.tabs.sendMessage(tab.id, {
            type: MessageTypes.UPDATE_OPTIONS,
            time: msg.time,
          }, (response) => {
            BackgroundUtils.checkMessageError('options', true);
          });
        }
      });
    }).catch((e) => console.error('Sending the new options to the tabs failed', e));
    return;
  } else if (msg.type === MessageTypes.MPV_TEST) {
    Mpv.testConnection().then(async (result) => {
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
    // Manual "send to mpv" (player button). The per-tab dedupe is bypassed so
    // a deliberate re-send always works, but repeat clicks inside a couple of
    // seconds are swallowed: each one spawns its own mpv window, and a user
    // who clicks again because nothing appeared yet should not end up with a
    // stack of them.
    if (Logging) console.log('[MPV] MPV_OPEN request:', msg.url);
    const now = Date.now();
    if (msg.url === LastManualMpvUrl &&
        now - LastManualMpvTime < ManualMpvRepeatMs) {
      if (Logging) console.log('[MPV] MPV_OPEN ignored, repeat click');
      sendResponse({ok: true});
      return true;
    }
    LastManualMpvUrl = msg.url;
    LastManualMpvTime = now;

    // The player builds these from VideoSource.headers, which strips
    // User-Agent (it is on VideoSource's header blacklist). Put the browser's
    // own back, or mpv identifies itself to the CDN as "libmpv".
    const headers = Array.isArray(msg.headers) ? msg.headers.slice() : [];
    if (!headers.some((h) => h && /^user-agent$/i.test(h.name))) {
      headers.push({name: 'User-Agent', value: navigator.userAgent});
    }

    const contentType = resolveMpvContentType(msg.contentType, sender.tab && sender.tab.url);

    Mpv.openStream(msg.url, null, headers, contentType, sender.tab && sender.tab.url,
        sender.tab && sender.tab.title, {startTime: msg.startTime, subtitles: msg.subtitles}).then((result) => {
      if (Logging) console.log('[MPV] MPV_OPEN result:', JSON.stringify(result));
      if (!result.ok) {
        // Let the user retry immediately when the launch actually failed.
        LastManualMpvTime = 0;
      }
      sendResponse(result);
    }).catch((e) => {
      // As a launch that failed: the player waits for an answer, and may try again at once.
      console.error('Sending the stream to mpv failed', e);
      LastManualMpvTime = 0;
      sendResponse({ok: false, error: String(e)});
    });
    return true;
  } else if (msg.type === MessageTypes.POPUP_GUARD_ARM) {
    if (sender.tab) {
      Tabs.getTabOrCreate(sender.tab.id).popupGuardArmedUntil = Date.now() + PopupGuardArmMs;
    }
    return;
  } else if (msg.type === MessageTypes.MPV_USER_PLAY) {
    onUserPlay(sender, typeof msg.src === 'string' ? msg.src : '', msg.video || null,
        typeof msg.page === 'string' ? msg.page : '');
    return;
  } else if (msg.type === MessageTypes.SHORTCUT_CANCELLED) {
    if (sender.tab && typeof msg.key === 'string' && typeof msg.code === 'string') {
      onCancelledShortcut(msg, sender.tab);
    }
    return;
  }

  // The messages below come from a page in a tab, a content script's or a player's; an
  // extension page outside any tab has none to give them.
  const senderTab = sender.tab;
  if (!senderTab) {
    return;
  }
  const tab = Tabs.getTabOrCreate(senderTab.id);
  const frame = tab.getFrameOrCreate(sender.frameId);

  if (msg.type === MessageTypes.PLAYER_LOADED) {
    const opener = playerOpener(msg.url || sender.url);
    if (tab.isPlayerOfGoneDocument(frame, msg.parentFrameId, opener)) {
      // Its page reloaded while it started (TabHolder.isPlayerOfGoneDocument): it goes
      // with that page, and is no player of the one there now.
      if (Logging) console.log('Ignoring a player whose page is gone', frame);
      tab.forgetFrame(frame);
      sendResponse(null);
      return;
    }
    if (!frame.parent && msg.parentFrameId !== undefined) {
      // The player names the frame it is in (TabHolder.playerParentProof): taken on trust,
      // a page framing the player page could make any frame of the tab hold a player.
      isPlayerParentProven(tab, frame, msg.parentFrameId, opener).then((proven) => {
        if (!proven) {
          if (Logging) console.log('Ignoring a player whose page did not open it', frame);
          tab.forgetFrame(frame);
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
    // Preserve sources key to this frame's new URL
    // This is needed because resetSelfAndChildren clears all sources, but we might have
    // already detected a source for this frame via onHeadersReceived (e.g. Vimeo)
    const preservedSources = frame.getSources().filter((s) => s.url === msg.url);
    const documentKey = typeof msg.document === 'string' ? msg.document : null;

    // The page the frame showed is gone, whether or not its FRAME_REMOVED came first.
    tab.noteDocumentReplaced(frame, documentKey);

    const playerCount = frame.resetSelfAndChildren();
    frame.url = msg.url;
    frame.documentKey = documentKey;

    // Restore preserved sources
    preservedSources.forEach((s) => {
      frame.getSources().push(s);
    });
    // A page back from Firefox's back-forward cache names itself again (content.js's
    // pageshow) and fetches nothing: what it had detected is kept for it. Only kept, for
    // the toolbar or a shortcut: nothing here opens a player or sends to mpv.
    tab.restoreGoneDocument(frame);

    tab.playerCount -= playerCount;
    tab.playerCount = Math.max(0, tab.playerCount);
    checkURLMatch(frame);
  } else if (msg.type === MessageTypes.FRAME_REMOVED) {
    tab.forgetRemovedFrame(msg.frameId !== undefined ? tab.getFrame(msg.frameId) : frame, msg.document);
  } else if (msg.type === MessageTypes.PLAYER_OPEN_GONE) {
    // The page took the player iframe out before its player loaded: no PLAYER_LOADED comes
    // to end the opening, and openPlayer refused this frame until the page navigated.
    if (frame.playerOpening && frame.playerOpeningAttempt === msg.attempt) {
      frame.playerOpening = false;
    }
  } else if (msg.type === MessageTypes.SEND_TO_CONTENT) {
    chrome.tabs.sendMessage(tab.tabId, {
      type: MessageTypes.MESSAGE_FROM_CONTENT,
      data: msg.data,
      destination: msg.destination,
    }, {
      frameId: frame.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('message_from_content');
    });
  } else if (msg.type === MessageTypes.REQUEST_SOURCES) {
    sendSources(frame);
  } else if (msg.type === MessageTypes.LOADED_MEDIA) {
    recoverFrameSources(frame, msg);
  } else if (msg.type === MessageTypes.CLEAR_SOURCES) {
    // The SourcesBrowser's "Clear Sources" button empties its own list, but
    // that list is only a mirror: this background's per-frame stores are the
    // source of truth, and sendSourcesToMainFramePlayers re-pushes them to
    // the player on every newly detected request - so a mirror-only clear
    // was visibly undone within seconds on any page still loading media.
    // Clear every frame's store (sources arrive on page frames, while this
    // message comes from the player's frame), so the clear sticks.
    // What a page frame handed its player goes too (handedTo), or the player's next
    // REQUEST_SOURCES got the cleared list back.
    for (const f of tab.getFrames()) {
      f.getSources().length = 0;
      f.forgetHandedToPlayer();
    }
    sendResponse('cleared');
    return;
  } else if (msg.type === MessageTypes.SET_HEADERS) {
    if (msg.commands.length) {
      ruleManager.addHeaderRule(msg.url, senderTab.id, msg.commands).then((rule) => {
        if (Logging) console.log('Added rule', msg, rule);
        sendResponse();
      }).catch((e) => {
        // Refused (a header set to nothing, say): answered all the same, so the request goes
        // out without it. Unanswered, the player's request failed.
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
    // Firefox refuses a name with a colon and some other characters, and the download then
    // silently did not happen: every screenshot ("@00:05") and any title with a colon.
    const filename = sanitizeDownloadFilename(msg.filename);
    // Check if cookieStoreId is set
    if (senderTab.cookieStoreId && senderTab.cookieStoreId !== 'firefox-default') {
      chrome.tabs.create({
        url: BackgroundUtils.getPlayerUrl(),
        cookieStoreId: senderTab.cookieStoreId,
        active: false,
      }, (tabobj2) => {
        if (!tabobj2) {
          sendResponse(null);
          return;
        }
        const tab2 = Tabs.getTabOrCreate(tabobj2.id);
        // Answered once: by the player's HANDLE_DOWNLOAD answer, or by the timeout below.
        let answered = false;
        const answer = (value) => {
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
        // If the player in this hidden tab never sends PLAYER_LOADED (blocked
        // page, redirect failure, site error before injection), or never answers
        // HANDLE_DOWNLOAD, the tab and the caller's sendResponse would otherwise
        // hang forever.
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
        sendResponse(null);
      });
    }
    return true;
  } else if (msg.type === MessageTypes.STORE_ANALYZER_DATA) {
    if (Logging) console.log('Analyzer data', msg.data);
    tab.analyzerData = msg.data;
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
  } else if (msg.type === MessageTypes.REQUEST_MINIPLAYER) {
    return handleMiniplayerRequest(frame, msg, sendResponse);
  } else if (msg.type === MessageTypes.REQUEST_PLAYLIST_NAVIGATION) {
    const pageFrame = frame.pageFrame;
    if (!pageFrame) {
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
        tab.continuationOptions = msg.continuationOptions;
      }
      sendResponse(response);
    });
    return true;
  } else if (msg.type === MessageTypes.REQUEST_PLAYLIST_POLL) {
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
    return true;
  } else {
    return;
  }

  sendResponse('ok');
});

async function cascadedFullscreen(playerFrame, finalFrame, data) {
  const trace = traceFrames(playerFrame, finalFrame);
  if (trace.length < 2) {
    return 'error';
  }

  const result = await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(playerFrame.tab.tabId, {
      ...data,
      frameId: trace[trace.length - 2].frameId,
      playerFrameId: playerFrame.frameId,
    }, {
      frameId: finalFrame.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('cascade_fullscreen_' + data.type);
      resolve(response);
    });
  });

  if (result !== 'enter' && result !== 'exit') {
    return result;
  }

  const newValue = result === 'enter';
  const promises = [];
  for (let i = 1; i < trace.length - 1; i++) {
    const currentFrame = trace[i];
    const lastFrame = trace[i - 1];
    promises.push(new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(currentFrame.tab.tabId, {
        type: MessageTypes.TOGGLE_WINDOWED_FULLSCREEN,
        force: newValue,
        frameId: lastFrame.frameId,
      }, {
        frameId: currentFrame.frameId,
      }, (response) => {
        BackgroundUtils.checkMessageError('toggle_fullscreen_windowed');
        resolve(response);
      });
    }));
  }

  await Promise.all(promises);

  return result;
}

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

function traceFrames(frame, toFrame) {
  if (frame === toFrame) {
    return [frame];
  }
  const frames = [];
  let currentFrame = frame;
  while (currentFrame && currentFrame !== toFrame) {
    frames.push(currentFrame);
    currentFrame = currentFrame.parent;
  }

  frames.push(toFrame);

  return frames;
}

async function checkIsFullscreenAllowed(frame) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.TOGGLE_FULLSCREEN,
      queryPermissions: true,
    }, {
      frameId: frame.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('check_fullscreen');
      resolve(response);
    });
  });
}

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

async function checkIsFull(frame) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.IS_FULL,
      frameId: frame.frameId,
    }, {
      frameId: frame.parent.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('is_full');
      resolve(response);
    });
  });
}

/**
 * Introduces a frame to its parent frame's content script, which then knows the iframe.
 * @param {FrameHolder} frame - The frame.
 * @return {Promise<void>} Resolves once both have answered.
 */
async function linkToParentFrame(frame) {
  if (!frame.parent) return;

  // Generate random string
  const key = crypto.randomUUID();

  return await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.FRAME_LINK_RECEIVER,
      frameId: frame.frameId,
      key,
    }, {
      frameId: frame.parent.frameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('link_frame_reciever');
      chrome.tabs.sendMessage(frame.tab.tabId, {
        type: MessageTypes.FRAME_LINK_SENDER,
        key,
      }, {
        frameId: frame.frameId,
      }, (response) => {
        BackgroundUtils.checkMessageError('link_frame_sender');
        resolve();
      });
    });
  });
}

function getMediaInfoFromTab(tab) {
  if (!tab || BackgroundUtils.isUrlPlayerUrl(tab.url)) return;
  // Get name of website through tab url
  const url = new URL(tab.url);
  const hostname = url.hostname;
  const parts = hostname.split('.');
  const name = parts[parts.length - 2];

  if (!name) return;

  let title = tab.title || '';

  // First, remove any special characters
  title = title.replace(/[^a-zA-Z0-9 ]/g, '');

  // Remove any words too similar to the website name
  const words = title.split(' ').filter((word) => word.length > 0);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.length <= 3) {
      continue;
    }

    if (StringUtils.levenshteinDistance(word.toLowerCase(), name.toLowerCase()) < Math.ceil(name.length * 0.4)) {
      words.splice(i, 1);
      i--;

      // Check if previous word is "the" or "a" or etc...
      if (i > 0) {
        const prewordList = ['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from'];
        if (prewordList.includes(words[i].toLowerCase())) {
          words.splice(i, 1);
          i--;
        }
      }
    }
  }

  title = words.join(' ');

  /** @type {?number} */
  let season = null;
  /** @type {?number} */
  let episode = null;
  // Remove season #, episode #, s#, e#
  title = title.replace(/\bseason\s*([0-9]+)/gi, (match, p1) => {
    season = parseInt(p1);
    return '';
  });

  title = title.replace(/\bepisode\s*([0-9]+)/gi, (match, p1) => {
    episode = parseInt(p1);
    return '';
  });

  if (season === null) {
    title = title.replace(/\bs([0-9]+)/gi, (match, p1) => {
      season = parseInt(p1);
      return '';
    });
  }

  if (episode === null) {
    title = title.replace(/\be([0-9]+)/gi, (match, p1) => {
      episode = parseInt(p1);
      return '';
    });
  }

  // Remove year
  title = title.replace(/\b[0-9]{4}\b/g, '');

  // Remove words like TV, Movie, HD, etc...
  // List generated by AI
  const wordsToExclude = ['tv', 'movie', 'hd', 'full', 'free', 'online', 'stream', 'streaming', 'watch', 'now', 'watching', 'series', 'episode', 'season', 'anime', 'show', 'shows', 'episodes', 'seasons', 'part', 'parts', 'sub', 'dub', 'subdub', 'subbed', 'dubbed', 'english', 'subtitles', 'subtitle'];
  title = title.replace(new RegExp('\\b(' + wordsToExclude.join('|') + ')\\b', 'gi'), '');

  return {
    name: title.replace(/\s\s+/g, ' ').trim(),
    season: season,
    episode: episode,
  };
}

async function loadOptions(newOptions) {
  newOptions = newOptions || await Utils.getOptionsFromStorage();
  Options = newOptions;

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
    setupRedirectRule(1, ['mp4']);
  } else {
    removeRule(1);
  }

  if (Options.playStreamURLs) {
    setupRedirectRule(2, ['m3u8', 'mpd']);
  } else {
    removeRule(2);
  }

  loadCustomPatterns();
}


async function setupRedirectRule(ruleID, filetypes) {
  const excludedRequestDomains = [(new URL(BackgroundUtils.getPlayerUrl())).hostname];

  for (const domain of AutoEnableList.excludedDomains()) {
    if (!excludedRequestDomains.includes(domain)) {
      excludedRequestDomains.push(domain);
    }
  }

  /** @type {chrome.declarativeNetRequest.Rule} */
  const rule = {
    id: ruleID,
    action: {
      type: 'redirect',
      redirect: {regexSubstitution: BackgroundUtils.getPlayerUrl() + '#\\0'},
    },
    condition: {
      // exclude self
      excludedRequestDomains,
      // only match m3u8 or mpds, up to a query or a fragment
      regexFilter: '^.+\\.(' + filetypes.join('|') + ')([?#].*)?$',
      resourceTypes: ['main_frame'],
    },
  };
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [rule.id],
    addRules: [rule],
  });
}

async function removeRule(ruleID) {
  return chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleID],
  });
}

async function loadCustomPatterns() {
  const customSourcePatterns = Options.customSourcePatterns;
  if (OptionsCache.customSourcePatterns !== customSourcePatterns) {
    OptionsCache.customSourcePatterns = customSourcePatterns;

    const matcher = new MultiRegexMatcher();
    await loadCustomPatternsFile(matcher, Options.customSourcePatterns, true);

    if (OptionsCache.customSourcePatterns !== customSourcePatterns) return;

    matcher.compile();
    CustomSourcePatternsMatcher = matcher;
  }
}

async function loadCustomPatternsFile(matcher, fileStr, isPrimary = false) {
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

function getSourceFromURL(frame, url) {
  return frame.getSources().find((a) => {
    return a.url === url;
  });
}

function addSource(frame, url, mode, headers, time = Date.now()) {
  frame.addSource({
    url, mode, headers, time,
  });
}

/**
 * The type a URL names by itself: its file extension, or what a site's pattern says it
 * is (Vimeo's player config, the user's custom source patterns).
 * @param {string} url - A request's URL.
 * @return {string} The extension or type, for URLUtils.getModeFromExtension and
 *   BackgroundUtils.isSubtitles.
 */
function urlType(url) {
  let ext = URLUtils.get_url_extension(url);
  if (URLUtils.hostnameMatches(url, 'player.vimeo.com') && (url.includes('config?') || url.includes('video'))) {
    ext = 'vmpatch';
  }

  const output = CustomSourcePatternsMatcher.match(url);
  if (output) {
    ext = output;
  }
  return ext;
}

/**
 * The mode of a stream fetched through a proxy, which names it in the query string:
 * proxy?url=https://cdn/.../index.m3u8.
 * @param {string} url - The proxy request's URL.
 * @return {?string} The stream's player mode, or null when the query names none.
 */
function modeFromQuery(url) {
  for (const value of URLUtils.get_url_params(url).values()) {
    if (!URLUtils.is_url(value)) continue;
    let ext = URLUtils.get_url_extension(value);

    const output = CustomSourcePatternsMatcher.match(value);
    if (output) {
      ext = output;
    }

    const mode = URLUtils.getModeFromExtension(ext);
    if (mode) {
      return mode;
    }
  }
  return null;
}

/** @typedef {import('./TabTracker.mjs').FrameHolder} FrameHolder */
/** @typedef {import('./TabTracker.mjs').TabHolder} TabHolder */

/**
 * Whether a frame's streams include one that may show a video, and not only playlists of
 * stills: the seek bar's thumbnails, which a page may ask for just before its video
 * (StreamLength STILLS_LENGTH). The playlists' lengths are read first, when they are not
 * yet; a read takes one request, the one the player would make next.
 * @param {FrameHolder} frame - The frame a player would open in.
 * @return {Promise<boolean>} True unless every one of its streams is a playlist of stills.
 */
async function hasVideoSource(frame) {
  const playlists = () => collectSources(frame).sources.filter((source) => source.mode === PlayerModes.ACCELERATED_HLS);
  await Lengths.settle(playlists, SourceLengthWaitMs);
  const sources = collectSources(frame).sources;
  const lengths = Lengths.lengthsOf(sources);
  return lengths.some((length) => length !== STILLS_LENGTH);
}

/**
 * Whether this background knows a stream of the tab, outside its players.
 * @param {TabHolder} tab - The tab.
 * @return {boolean} True when a frame of it has one.
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
 * Asks the page's frames what they loaded, when this background knows no stream of the
 * tab. Firefox unloads the background after ~30 idle seconds, and the detected streams go
 * with it (TabTracker keeps the toggle state only), while a page asks for its manifest
 * once, when its video starts: FastStream turned on after that found nothing until the
 * page reloaded. A page back from the back-forward cache, or loaded before FastStream
 * was, is the same. Each frame answers with LOADED_MEDIA (recoverFrameSources).
 * @param {TabHolder} tab - The tab.
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
 * Takes in what a frame says it loaded (recoverSources): each URL goes through the rules a
 * request's does (onHeadersReceived), by the URL alone, in the order the page asked for
 * them. The requests' own headers are gone; the Referer and Origin the page sent by
 * default stand in for them (pageHeaders). A stream found is then taken in as a detected
 * one is (onSourceRecieved), which opens the player: after the page's <track> captions
 * are read, and after Options.replaceDelay, as for a stream the page asks for now.
 * @param {FrameHolder} frame - The frame that answered.
 * @param {{url?: string, document?: string, resources?: Array<Object>}} msg - Its LOADED_MEDIA.
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

  for (const resource of msg.resources) {
    const url = resource && typeof resource.url === 'string' ? resource.url : '';
    if (!/^https?:\/\//i.test(url)) continue;
    const media = !!resource.media;
    const headers = pageHeaders(typeof msg.url === 'string' ? msg.url : frame.url, url, media);
    const ext = urlType(url);
    if (BackgroundUtils.isSubtitles(ext)) {
      handleSubtitles(url, frame, headers);
      continue;
    }

    const mode = URLUtils.getModeFromExtension(ext) || (media ? PlayerModes.ACCELERATED_MP4 : modeFromQuery(url));
    if (!mode || getSourceFromURL(frame, url)) continue;
    onSourceRecieved({
      url,
      requestId: -1,
      customHeaders: headers,
      time: typeof resource.time === 'number' ? resource.time : undefined,
    }, frame, mode);
  }
}

/**
 * The Referer and Origin a page's request carries by default (strict-origin-when-cross-
 * origin): for a stream recovered from the page, whose own request headers are gone.
 * @param {string|undefined} pageUrl - The page; none gives no headers.
 * @param {string} url - The stream.
 * @param {boolean} media - Whether a media element loaded it, which sends no Origin.
 * @return {Array<{name: string, value: string}>} The headers.
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
  if (page.origin === target.origin) {
    return [{name: 'Referer', value: page.href.split('#')[0]}];
  }
  const headers = [{name: 'Referer', value: page.origin + '/'}];
  if (!media) {
    headers.push({name: 'Origin', value: page.origin});
  }
  return headers;
}

function collectSources(frame, remove = false) {
  const subtitles = [];
  const sources = [];

  let currentFrame = frame;
  let removed = false;
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

    if (!removed && remove) {
      if (currentSources.length !== 0) {
        removed = true;
      }
      currentSources.length = 0;
      currentSubtitles.length = 0;
    }

    if (sources.length !== 0) break;

    currentFrame = currentFrame.parent;
    depth++;
  }

  // Sort by time, oldest first
  sources.sort((a, b) => {
    return a.time - b.time;
  });

  return {subtitles, sources};
}

async function sendSources(frame) {
  const continuationOptions = frame.tab.continuationOptions;
  frame.tab.continuationOptions = null;
  const send = (subtitles, sources, video) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.SOURCES,
      subtitles: subtitles,
      sources: sources,
      video,
      autoSetSource: true,
      continuationOptions: continuationOptions,
    }, {
      frameId: frame.frameId,
    }, () => {
      BackgroundUtils.checkMessageError('sources');
    });
  };

  // A player loading again in its frame ("Reload Frame" on it) gets what its first load
  // got: that was taken out of the page's frames (collectSources), and it sat on the
  // welcome screen with nothing.
  const handed = frame.parent ? frame.parent.handedTo(frame.frameId) : null;
  if (handed && collectSources(frame).sources.length === 0) {
    send(handed.subtitles, handed.sources, handed.video);
    return;
  }

  // The player plays the one the page's video played, or the longest of them: a little
  // time for the lengths still being read. The video is asked about after that, when the
  // page's player has most likely set its length; then a wait for the sources detected
  // meanwhile, if any (one still unread from before is not waited for twice). A playlist
  // is read even when it is the only source: it may be one of stills, which the player
  // lists but does not play by itself (STILLS_LENGTH).
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

  if (frame.parent && sources.length) {
    frame.parent.noteHandedToPlayer(frame.frameId, {subtitles, sources, video});
  }
  send(subtitles, sources, video);
}

async function scrapeCaptionsTags(frame) {
  const tabId = frame.tab.tabId;
  const frameId = frame.frameId;
  if (tabId < 0) return null;

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, {
      type: MessageTypes.SCRAPE_CAPTIONS,
    }, {
      frameId: frameId,
    }, (sub) => {
      BackgroundUtils.checkMessageError('scrape_captions');
      resolve(sub);
    });
  });
}

/**
 * What the page's video that a player replaced played (content.js replacedVideo), asked
 * of the frame the player's iframe is in.
 * @param {Object} player - The player's frame.
 * @return {Promise<?{src: string, duration: ?number}>} Its file's URL and its length, or
 *   null when the player replaced no video (it fills the page), or the page did not answer
 *   within PlayedVideoWaitMs.
 */
async function getPlayedVideo(player) {
  return new Promise((resolve) => {
    // Content scripts share the page's event loop: a page that never lets go would hold
    // the player without sources.
    const timer = setTimeout(() => resolve(null), PlayedVideoWaitMs);
    chrome.tabs.sendMessage(player.tab.tabId, {
      type: MessageTypes.GET_PLAYED_VIDEO,
      frameId: player.frameId,
    }, {
      frameId: player.parent.frameId,
    }, (video) => {
      BackgroundUtils.checkMessageError('get_played_video');
      clearTimeout(timer);
      resolve(video || null);
    });
  });
}

async function getVideoSize(frame) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(frame.tab.tabId, {
      type: MessageTypes.GET_VIDEO_SIZE,
    }, {
      frameId: frame.frameId,
    }, (size) => {
      BackgroundUtils.checkMessageError('get_video_size');
      resolve(size);
    });
  });
}

/**
 * The page that opened a player, as content.js names it in the player's URL.
 * @param {string|undefined} url - The player's URL.
 * @return {?string} The name, or null when the URL has none.
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
 * Whether the frame a player names (PLAYER_LOADED's parentFrameId) holds the page that
 * opened it (TabHolder.playerParentProof). When this background does not know that page's
 * name (it started again since the page loaded), the frame's content script is asked.
 * @param {TabHolder} tab - The tab.
 * @param {FrameHolder} frame - The player's frame.
 * @param {*} parentFrameId - The frame it names.
 * @param {?string} opener - The page its URL names.
 * @return {Promise<boolean>}
 */
async function isPlayerParentProven(tab, frame, parentFrameId, opener) {
  const proof = tab.playerParentProof(frame, parentFrameId, opener);
  if (proof !== 'ask') {
    return proof === 'proven';
  }
  const answer = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.tabId, {
      type: MessageTypes.IS_PLAYER_OPENER,
      document: opener,
    }, {
      frameId: parentFrameId,
    }, (response) => {
      BackgroundUtils.checkMessageError('is_player_opener');
      resolve(response);
    });
  });
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
 * Takes a player that said it loaded (PLAYER_LOADED) for one, and answers it.
 * @param {Object} tab - TabHolder of the player.
 * @param {Object} frame - FrameHolder of the player, its parent set when it has one.
 * @param {chrome.runtime.MessageSender} sender - The message's sender.
 * @param {Function} sendResponse - The answer.
 */
function acceptPlayer(tab, frame, sender, sendResponse) {
  if (Logging) console.log('Found FastStream window', frame);
  frame.isPlayer = true;

  if (tab.downloadInfo) {
    // Taken now: the DOWNLOAD's 30 s timeout can end it while the player saves, and the
    // answer then found no download to give it to (a TypeError, and no answer at all).
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

      // Close tab
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
  tab.playerCount++;
  const isMainPlayer = tab.playerCount === 1;

  getPageFrame(frame).then((pageFrame) => {
    if (pageFrame) {
      frame.pageFrame = pageFrame;
    } else {
      frame.pageFrame = tab.getFrameOrCreate(0);
    }

    const response = {
      mediaInfo: getMediaInfoFromTab(sender?.tab),
      analyzerData: tab.analyzerData,
      isMainPlayer,
    };

    sendResponse(response);
  }).catch((e) => {
    // The player waits for this answer before it starts; the top frame stands in.
    console.error('Finding the page frame of a player failed', e);
    frame.pageFrame = tab.getFrameOrCreate(0);
    sendResponse({
      mediaInfo: getMediaInfoFromTab(sender?.tab),
      analyzerData: tab.analyzerData,
      isMainPlayer,
    });
  });
}

async function openPlayer(frame) {
  if (frame.playerOpening || frame.hasPlayer()) {
    return;
  }

  frame.playerOpening = true;
  // Named in content.js's report of a player iframe the page took out before it loaded
  // (PLAYER_OPEN_GONE), so a report of an earlier attempt never ends this one.
  frame.playerOpeningAttempt = ++playerOpeningAttempts;

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

      if (!BackgroundUtils.isPlayerOpeningResponse(response)) {
        frame.playerOpening = false;
      }

      resolve(response);
    });
  });
}

async function sendSourcesToMainFramePlayers(frame) {
  // query all tabs
  const tabs = await BackgroundUtils.queryTabs();
  // Only to player tabs on the same side of private browsing as the page: a private
  // window's streams, with the requests' cookies, showed in an ordinary window's player
  // tab, and the other way round. A tab no longer open says nothing of its side.
  const from = tabs.find((t) => t.id === frame.tab.tabId);
  if (!from) {
    return;
  }

  // for each tab
  for (let i = 0; i < tabs.length; i++) {
    if (!!tabs[i].incognito !== !!from.incognito) continue;
    const tab = Tabs.getTab(tabs[i].id);
    if (!tab || !tab.isOn) continue;
    // if the tab is a faststream tab
    const mainPlayerFrame = tab.getMainPlayer();
    if (mainPlayerFrame) {
      // send the source to the tab
      chrome.tabs.sendMessage(tab.tabId, {
        type: MessageTypes.SOURCES,
        subtitles: frame.getSubtitles(),
        sources: frame.getSources(),
        autoSetSource: false,
      }, () => {
        BackgroundUtils.checkMessageError('sources');
      });
    }
  }
}

async function onSourceRecieved(details, frame, mode) {
  // Read the cached request headers before anything else. deleteHeaderCache is
  // a second onHeadersReceived listener, so it runs the moment this function
  // yields at its first await; reading them after that always returns
  // undefined and the Referer/Origin the CDN needs is lost.
  const customHeaders = details.customHeaders || frame.tab.requestHeaders.get(details.requestId);

  await ensureOptions();

  const url = details.url;

  if (getSourceFromURL(frame, url)) return;

  // A stream recovered from the page (recoverFrameSources) keeps when the page asked for it.
  addSource(frame, url, mode, customHeaders, details.time);
  // Its length, read now: by the time a player asks for the page's streams, it is known.
  if (frame.tab.isOn) {
    Lengths.probe({url, mode, headers: customHeaders});
  }

  // MPV mode: relay the detected source to the native mpv host instead of
  // opening the in-page player.
  if (frame.tab.isOn && frame.tab.isMpv) {
    if (frame.tab.mpvOnPlay) {
      // The shortcut's MPV: streams are only tracked, for onUserPlay to pick
      // from - unless the user already pressed play and the player asked
      // for its stream only afterwards, in which case this is that stream.
      const tab = frame.tab;
      const candidate = {frame, document: frame.documentKey, url, mode, headers: customHeaders};
      if (tab.mpvPlayChecking) {
        // Another stream is being checked for the play: this one is next, should that one
        // be another video's. Dropped, an ad's manifest and then the episode's left the
        // play with nothing sent.
        tab.mpvPlayChecking.push(candidate);
      } else if (tab.mpvPlayPendingUntil > Date.now()) {
        await sendPendingPlay(tab, candidate);
      }
      return;
    }

    // Auto-open only the first stream found on this page. Later ones stay
    // tracked for the toolbar and the player's "send to mpv" button, but
    // they must not each spawn their own mpv window.
    if (!frame.tab.mpvAutoOpened) {
      autoOpenInMpv(frame.tab, url, customHeaders);
    }
    return;
  }

  // The page's own <track> elements, read by content.js. A track seen before is
  // replaced by its latest copy, anything new is added.
  const subs = await scrapeCaptionsTags(frame);
  if (Array.isArray(subs)) {
    const subtitles = frame.getSubtitles();
    subs.forEach((s) => {
      const index = subtitles.findIndex((ss) => ss.source === s.source);
      if (index === -1) {
        subtitles.push(s);
      } else {
        subtitles[index] = s;
      }
    });
  }

  if (frame.tab.isOn) {
    clearTimeout(frame.openTimeout);
    frame.openTimeout = setTimeout(async () => {
      // A frame the tab no longer tracks - forgotten, or dropped by the reset on a new
      // site with this page's streams still on it - opens nothing: OPEN_PLAYER goes by
      // frame id, to whatever page now has it. A new page in the frame keeps it tracked,
      // and a stream found before that page's FRAME_ADDED still opens (preservedSources).
      if (!frame.isTracked()) {
        return;
      }
      // MPV counts as on too: a switch to it within the delay found no player to
      // reload away, and this would open one under it.
      if (!frame.tab.isOn || frame.tab.isMpv) {
        return;
      }
      // Not on the seek bar's thumbnails alone, which a page may ask for before its video:
      // the player would take them, and the video's stream, asked for later, would be
      // dropped as one of the player's own.
      if (!await hasVideoSource(frame)) {
        return;
      }
      if (frame.tab.isOn && !frame.tab.isMpv) {
        openPlayer(frame);
      }
    }, Options.replaceDelay);
  }

  sendSourcesToMainFramePlayers(frame);

  if (Logging) console.log('Found source', details, frame);

  return;
}

/**
 * Opens the in-page player in each frame whose page has a video stream.
 * @param {TabHolder} tab - The tab.
 * @param {number} [foundBefore] - Only streams found before this time count (a start by
 *   address, startWithTrackedLater): a later one opens the player by itself, after the
 *   page's <track> captions are read (onSourceRecieved), and opened here as well it
 *   beat them and opened a second player.
 */
async function openPlayersWithSources(tab, foundBefore = Infinity) {
  if (!tabHasSources(tab)) {
    // Streams the page asked for before this background knew of it (recoverSources). Each
    // one found opens the player as a stream detected now does (onSourceRecieved): opened
    // here, it would beat the page's <track> captions and Options.replaceDelay of a stream
    // the page asks for meanwhile - as it does right after an auto-enable URL loads.
    recoverSources(tab);
    return;
  }

  let framesWithSources = [];
  for (const frame of tab.getFrames()) {
    if (!frame.isPlayer && frame.getSources().some((source) => !(source.time >= foundBefore))) {
      framesWithSources.push(frame);
    }
  }

  if (framesWithSources.length > 0) {
    // Not on the seek bar's thumbnails alone (hasVideoSource).
    framesWithSources = (await Promise.all(framesWithSources.map(async (frame) => {
      return await hasVideoSource(frame) ? {frame, videoSize: await getVideoSize(frame)} : null;
    }))).filter((entry) => entry !== null);

    // The page's videos were measured with a round trip to it; a click that turned the
    // tab off, or over to MPV, in the meantime decides.
    if (!tab.isOn || tab.isMpv) {
      return;
    }

    // A frame that did not answer (no content script) has no size: 0, not undefined, whose
    // NaN made the order arbitrary - and the first player opened is the one that plays.
    framesWithSources.sort((a, b) => {
      return (b.videoSize || 0) - (a.videoSize || 0);
    });

    for (let i = 0; i < framesWithSources.length; i++) {
      openPlayer(framesWithSources[i].frame);
    }
  }
}

/**
 * Stops whatever the page is still playing once a stream has been handed to
 * mpv. Without this the site keeps streaming in the background and the user
 * has to come back to the tab just to silence it.
 *
 * Sent to every frame: on these sites the video usually lives in an iframe,
 * not the top document.
 *
 * @param {number} tabId - Tab whose media should be paused.
 * @return {void}
 */
function pauseTabMedia(tabId) {
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
 * The allowlist's MPV: hands a page's stream to mpv, once per page
 * (tab.mpvAutoOpened), then pauses the page.
 *
 * @param {Object} tab - TabHolder the stream is in.
 * @param {string} url - The stream.
 * @param {*} headers - Its request headers, as detected.
 */
function autoOpenInMpv(tab, url, headers) {
  tab.mpvAutoOpened = true;
  Tabs.saveTabState(tab);
  if (Logging) console.log('[MPV] forwarding detected stream to mpv:', url);
  tabTitle(tab.tabId).then((title) =>
    Mpv.openStream(url, tab, headers, resolveMpvContentType(null, tab.url), tab.url, title)).then((result) => {
    if (Logging) console.log('[MPV] forward result:', url, JSON.stringify(result));
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseTabMedia(tab.tabId);
    } else {
      // The host never launched mpv, so let the next stream try.
      tab.mpvAutoOpened = false;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    console.error('Handing the stream to mpv failed', e);
    setMpvError(tab, {ok: false, error: String(e)});
  });
}

/**
 * Shows a failed MPV-mode hand-off on the tab's toolbar button ("!", and the reason in
 * its tooltip), or clears it after one that worked. Without it the page simply played
 * on in the browser, and nothing said why. An outdated host shows the same "!" after a
 * hand-off that worked, with a tooltip that says to install the host again: the copy a
 * PC runs is not updated by an extension update or a `git pull`, and nothing else in
 * MPV mode would say so (MpvBackend's RequiredHostVersion).
 * @param {Object} tab - TabHolder the stream was sent from.
 * @param {{ok: boolean, error?: string, noHost?: boolean, hostOutdated?: boolean}} result -
 *   The host's answer.
 */
function setMpvError(tab, result) {
  /** @type {?string} */
  let error = null;
  if (!result.ok) {
    error = result.noHost || !result.error ?
      'the FastStream mpv host did not answer - is it installed?' :
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
const MpvDecoderWaitMs = 20000;

/**
 * After a hand-off that worked, asks mpv which video decoder it plays the stream with,
 * for the toolbar button's tooltip: the hardware API, or a hint that mpv decodes in
 * software (with what to add to mpv.conf). Read-only: FastStream never overrides mpv.conf.
 * Only an mpv the host started for single-instance use has the pipe to ask over.
 * @param {Object} tab - TabHolder the stream was sent from.
 * @param {{ok: boolean}} result - The hand-off's answer.
 */
function followMpvDecoder(tab, result) {
  const query = {};
  tab.mpvDecoderQuery = query;
  setMpvDecoder(tab, null);
  if (!result.ok || !Mpv.singleInstance) {
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
 * @param {Object} tab - TabHolder.
 * @param {?Object} decoder - MpvBackend's MpvDecoder, or null.
 */
function setMpvDecoder(tab, decoder) {
  if (JSON.stringify(tab.mpvDecoder ?? null) === JSON.stringify(decoder)) {
    return;
  }
  tab.mpvDecoder = decoder;
  BackgroundUtils.updateTabIcon(tab);
  Tabs.saveTabState(tab);
}

/**
 * A tab's title, for mpv's window and top bar (the native host shows the stream's host
 * name without one).
 * @param {number} tabId - The tab.
 * @return {Promise<string|undefined>} Its title, or undefined when it cannot be read.
 */
async function tabTitle(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    return (t && t.title) || undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * The allowlist's MPV, after a play on a page Back gave back whose own stream is not
 * among the page's streams (an MSE player's blob:). The page may still ask for one
 * now (it moved on to another video without a load), and its detection sends it;
 * when none has gone within MpvPlayKnownAfterMs, the page's known stream goes.
 *
 * @param {Object} tab - TabHolder the video is in.
 * @param {number} frameId - Frame the video is in.
 * @param {string} src - The video element's currentSrc.
 * @param {?Object} video - What it plays (content.js playedVideo).
 */
function autoOpenKnownLater(tab, frameId, src, video) {
  // The page the play came from, as onUserPlay checks it: within the wait the tab can show
  // another page (Back once more gives one back with its streams), and that page's stream
  // went to mpv for this page's play.
  const documentIn = () => tab.getFrame(frameId)?.documentKey;
  const page = {url: tab.url, document: documentIn()};
  const waiting = () => tab.isOn && tab.isMpv && !tab.mpvOnPlay && !tab.mpvAutoOpened &&
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

/**
 * A video the user started, in a tab whose MPV came from the shortcut: hands
 * that video's stream to mpv and pauses the page.
 *
 * With no stream for it yet - a player that fetches only once play() was
 * called - the next stream detected in the tab within MpvPlayPendingMs is
 * taken as this one (see onSourceRecieved).
 *
 * In the allowlist's MPV, the first stream detected on a page goes to mpv by
 * itself. A play counts only on a page Back brought out of Firefox's
 * back-forward cache (frame.restoredFromCache), while none has gone on it: it
 * fetches nothing again, so its video plays what it had loaded and nothing is
 * detected. Its streams are the ones the background kept for it
 * (TabHolder.restoreGoneDocument). Anywhere else the play's own stream is
 * detected, and goes by itself: a site that plays its next episode in the same
 * page (a URL change without a load, which lets the page's MPV send again) still
 * has the last one's streams, and the play came before the new one's.
 *
 * A video on a YouTube watch page goes as the video's address, in the shortcut's MPV:
 * mpv's yt-dlp finds its streams, which FastStream cannot.
 *
 * @param {Object} sender - The message sender: its tab and frameId.
 * @param {string} src - The video element's currentSrc.
 * @param {?Object} video - What it plays (content.js playedVideo).
 * @param {string} pageUrl - The address of the video's page, as the page had it.
 */
async function onUserPlay(sender, src, video, pageUrl) {
  await ensureOptions();

  if (!Options.mpvMode || !sender.tab || typeof sender.frameId !== 'number') {
    return;
  }

  const tab = Tabs.getTab(sender.tab.id);
  const waiting = (onPlay) => !!tab && tab.isOn && tab.isMpv && tab.mpvOnPlay === onPlay &&
    (onPlay || !tab.mpvAutoOpened);
  if (!tab || !waiting(tab.mpvOnPlay)) {
    return;
  }
  const onPlay = tab.mpvOnPlay;
  const frame = tab.getFrame(sender.frameId);
  if (!onPlay && !(frame && frame.restoredFromCache)) {
    return;
  }

  // The page's address, not the tab's: YouTube moves to the next video by pushState, and
  // the tab's may still be the last video's.
  const youTube = onPlay ? MpvBackend.youTubeVideoUrl(pageUrl) : null;
  if (youTube) {
    if (Logging) console.log('[MPV] user started a YouTube video:', youTube);
    sendPlayedToMpv(tab, {url: youTube}, youTube);
    return;
  }

  // The page the video plays in: the tab may load another while the lengths are read, and
  // the next page's first stream went to mpv for a video of the page before (G3).
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
    sendPlayedToMpv(tab, source);
  } else {
    // None yet, or only another video's by length (findPlayedSource): the next stream the
    // page asks for decides, when its length can be the video's (onSourceRecieved).
    tab.mpvPlayedVideo = video || null;
    tab.mpvPlayPendingUntil = Date.now() + MpvPlayPendingMs;
    Tabs.saveTabState(tab);
  }
}

/**
 * The shortcut's MPV, after a play whose stream was not detected yet (onUserPlay): checks
 * the streams detected since, in the order the page asked for them, and sends the first
 * whose length can be the video's. The length tells: the first stream after the play
 * went unchecked once, a preview's or an ad's as well. Streams found while one is checked
 * wait their turn in tab.mpvPlayChecking. None that fits: the play waits on for the next,
 * while its time lasts.
 *
 * @param {TabHolder} tab - The tab the video plays in.
 * @param {{frame: FrameHolder, document: ?string, url: string, mode: string, headers: *}} first -
 *   The stream that came first, and the page its frame showed then.
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
      // Its length, being read since it was detected (onSourceRecieved's probe).
      await Lengths.settle(() => [candidate], SourceLengthWaitMs);
      // A new page, a reload or MPV started again drop the play (and this queue).
      if (tab.mpvPlayChecking !== queue || tab.url !== url) {
        return;
      }
      // Its frame went on to another page meanwhile, or its length is another video's.
      if (candidate.frame.documentKey !== candidate.document ||
          StreamPick.conflicts(tab.mpvPlayedVideo, Lengths.lengthOf(candidate.url))) {
        continue;
      }
      if (tab.isOn && tab.isMpv && tab.mpvOnPlay) {
        sendPlayedToMpv(tab, candidate);
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
 * The detected source a started video plays. Its own URL first: a progressive
 * file, often preloaded long before the click, which no later request would
 * detect again. Otherwise the stream as long as the video (StreamPick), or the
 * newest of the longest sources of the frame it plays in, since an MSE player's
 * src is a blob: and its manifest a request of that frame - and one that ran an
 * ad first has the ad's among them. Their
 * lengths may not be read yet: the page can have asked for them before this
 * tab's MPV started, when nothing read them. A short video beside a far longer
 * stream is an ad or a preview, found by URL or not: the longest decides. A
 * pick plainly another length than the video is none: the video's stream is
 * still to come.
 *
 * @param {Object} tab - TabHolder the video is in.
 * @param {number} frameId - Frame the video is in.
 * @param {string} src - The video element's currentSrc.
 * @param {?Object} video - What it plays (content.js playedVideo).
 * @return {Promise<Object|null>} The source, or null when none is detected yet.
 */
async function findPlayedSource(tab, frameId, src, video) {
  let byUrl = null;
  if (/^https?:\/\//i.test(src)) {
    for (const frame of tab.getFrames()) {
      byUrl = getSourceFromURL(frame, src);
      if (byUrl) {
        break;
      }
    }
  }

  const frame = tab.getFrame(frameId);
  const others = frame ? frame.getSources().filter((source) => source !== byUrl) : [];
  if (byUrl && others.length === 0) {
    return byUrl;
  }
  if (!frame) {
    return null;
  }

  // The lengths decide below, and a stream the page asked for before this tab's MPV started
  // has none read. One stream alone too, when the video's length is known: sent unread, an
  // ad's or a preview's went to mpv for a film the user started.
  if (frame.getSources().length > 1 || StreamPick.lengthOf(video ? video.duration : null) !== null) {
    await Lengths.settle(() => frame.getSources(), SourceLengthWaitMs);
  }

  const sources = frame.getSources();
  const lengths = Lengths.lengthsOf(sources);
  /** @type {Array<{source: *, url: string, duration?: ?number}>} */
  const measured = StreamLength.withoutStills(sources.map((source, i) => ({source, url: source.url, duration: lengths[i]})));
  const videoLength = StreamPick.lengthOf(video ? video.duration : null);
  if (byUrl) {
    // The file the video plays, unless a far longer stream plays beside it (StreamPick's
    // rule for a video it matches by length): then the video is a preroll ad or a preview
    // the same click started, and the longest decides.
    const length = StreamPick.lengthOf(Lengths.lengthsOf([byUrl])[0]) ?? videoLength;
    if (!StreamPick.outrun(measured.filter((entry) => entry.source !== byUrl), length)) {
      return byUrl;
    }
    return newestOfLongest(sources, video);
  }

  const picked = newestOfLongest(sources, video);
  // A stream plainly another length than the video is not its stream, unless the video is
  // the ad (a far longer stream beside it): an ad's or a preview's the page fetched before
  // went to mpv for a film. None yet then: the next stream the page asks for decides.
  if (picked && !StreamPick.outrun(measured, videoLength) &&
      StreamPick.conflicts(video, Lengths.lengthsOf([picked])[0])) {
    return null;
  }
  return picked;
}

/**
 * The newest of the streams a video plays (StreamPick.played), or else of the longest
 * sources: an ad runs for seconds, the video for minutes (StreamLength.longest). Of
 * streams that tie, the one the page asked for last is the one it plays now. Never a
 * playlist of stills (STILLS_LENGTH): mpv would show the seek bar's thumbnails.
 *
 * @param {Array<Object>} sources - Detected sources.
 * @param {?Object} [video] - What the page's video plays (content.js playedVideo).
 * @return {Object|null} One of them, or null when there are none.
 */
function newestOfLongest(sources, video = null) {
  const lengths = Lengths.lengthsOf(sources);
  /** @type {Array<{source: *, url: string, duration?: ?number}>} */
  const measured = StreamLength.withoutStills(sources.map((source, i) => ({source, url: source.url, duration: lengths[i]})));
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
 * Hands a video the user started to mpv, then pauses the page.
 *
 * The same video again within MpvPlayRepeatMs is the player repeating itself
 * (play() called twice, or resuming after pauseTabMedia), so it only pauses
 * the page again. openStream gets no tab: its per-page dedupe would swallow a
 * later, deliberate play of a video already sent (after closing mpv).
 *
 * @param {Object} tab - TabHolder the video is in.
 * @param {Object} source - Detected source: url and request headers.
 * @param {string} [pageUrl] - The video's page, which mpv resumes it by.
 */
function sendPlayedToMpv(tab, source, pageUrl = tab.url) {
  const now = Date.now();
  const last = tab.mpvLastPlaySend;
  if (last && last.url === source.url && now - last.time < MpvPlayRepeatMs) {
    pauseTabMedia(tab.tabId);
    return;
  }

  tab.mpvLastPlaySend = {url: source.url, time: now};
  Tabs.saveTabState(tab);
  tabTitle(tab.tabId).then((title) =>
    Mpv.openStream(source.url, null, source.headers, resolveMpvContentType(null, tab.url), pageUrl, title)).then((result) => {
    if (Logging) console.log('[MPV] user play result:', source.url, JSON.stringify(result));
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseTabMedia(tab.tabId);
    } else if (tab.mpvLastPlaySend && tab.mpvLastPlaySend.url === source.url) {
      // The host never launched mpv, so let the next play try again.
      tab.mpvLastPlaySend = null;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    console.error('Handing the played video to mpv failed', e);
    setMpvError(tab, {ok: false, error: String(e)});
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
 * @param {Object} tab - TabHolder whose tracked sources should open in mpv.
 * @return {boolean} True when a source was handed to mpv.
 */
function openMpvWithSources(tab) {
  if (!Options.mpvMode) {
    return false;
  }

  // Entering MPV mode is an explicit start, so forget what was already sent
  // for this tab. Without this the dedupe in openStream silently swallows a
  // re-entry that targets the same URL (toolbar cycled MPV -> Off -> On -> MPV).
  tab.mpvSentUrls.clear();

  const seen = new Set();
  const sources = [];

  for (const frame of tab.getFrames()) {
    for (const source of frame.getSources()) {
      if (!seen.has(source.url)) {
        seen.add(source.url);
        sources.push(source);
      }
    }
  }

  const source = newestOfLongest(sources);
  if (!source) {
    return false;
  }

  tab.mpvAutoOpened = true;
  Tabs.saveTabState(tab);
  tabTitle(tab.tabId).then((title) =>
    Mpv.openStream(source.url, tab, source.headers, resolveMpvContentType(null, tab.url), tab.url, title)).then((result) => {
    if (Logging) console.log('[MPV] openStream result:', source.url, JSON.stringify(result));
    setMpvError(tab, result);
    followMpvDecoder(tab, result);
    if (result.ok) {
      pauseTabMedia(tab.tabId);
    } else {
      // The host never launched mpv, so let the next detected stream try.
      tab.mpvAutoOpened = false;
      Tabs.saveTabState(tab);
    }
  }).catch((e) => {
    console.error('Handing the stream to mpv failed', e);
    setMpvError(tab, {ok: false, error: String(e)});
  });
  return true;
}

/** @type {Array<'requestHeaders'|'extraHeaders'|'blocking'>} */
const webRequestPerms = ['requestHeaders'];
// Detection reads a page load's Content-Type, to tell an HTML page from a stream.
/** @type {Array<'responseHeaders'|'extraHeaders'|'blocking'>} */
const webRequestPerms2 = ['responseHeaders'];

/**
 * Whether a response is an HTML page, by its Content-Type.
 * @param {Array<{name: string, value?: string}>} [headers] - webRequest's responseHeaders.
 * @return {boolean} True for text/html and application/xhtml+xml.
 */
function isHtmlResponse(headers) {
  const contentType = headers?.find((header) => header.name.toLowerCase() === 'content-type');
  const type = contentType?.value?.split(';')[0].trim().toLowerCase();
  return type === 'text/html' || type === 'application/xhtml+xml';
}

/**
 * Whether a request belongs to no tab: a service worker's, or this background's own
 * length reads (StreamLengths). No player opens there and nothing goes to mpv from it,
 * and no tab event ever resets what is kept for it: the holder of tab -1 collected
 * every stream such requests fetched, for the session, and sent the growing list, with
 * the requests' headers, to every player tab - from a private window or a container as
 * well, which it cannot tell.
 * @param {{tabId: number}} details - webRequest's details.
 * @return {boolean}
 */
function isTablessRequest(details) {
  return details.tabId === chrome.tabs.TAB_ID_NONE;
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
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

chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (isTablessRequest(details)) {
        return;
      }
      const url = details.url;
      const tab = Tabs.getTabOrCreate(details.tabId);
      const frame = tab.getFrameOrCreate(details.frameId);
      if (frame.hasPlayer()) return;

      if ((details.statusCode >= 400 && details.statusCode < 600) || details.statusCode === 204) {
        return; // Client or server error. Ignore it
      }
      const ext = urlType(url);

      if (BackgroundUtils.isSubtitles(ext)) {
        handleSubtitles(url, frame, tab.requestHeaders.get(details.requestId));
        return;
      }

      let mode = URLUtils.getModeFromExtension(ext);
      if (!mode) {
        // A manifest whose URL names no type: its Content-Type does (ManifestTypes).
        mode = modeFromContentType(details.responseHeaders);
      }
      if (!mode) {
        if (details.type === 'media') {
          mode = modeFromMediaType(details.responseHeaders);
          if (!mode) {
            return;
          }
        } else if ((details.type === 'main_frame' || details.type === 'sub_frame') &&
            isHtmlResponse(details.responseHeaders)) {
          // A page is not a stream, even when its query string names one: an embed page
          // (embed.php?file=https://cdn/.../index.m3u8) is HTML, and taking it for the
          // stream could open the player on the page itself. The stream the page plays is
          // detected by itself, when the page requests it. A page load answered with the
          // stream itself - a proxy link opened in a tab or an iframe - is not HTML, and
          // Firefox plays it in that load, with no request of its own to detect.
          return;
        } else {
          mode = modeFromQuery(url);
          if (!mode) {
            return;
          }
        }
      }

      onSourceRecieved(details, frame, mode);
    }, {
      urls: ['<all_urls>'],
    }, webRequestPerms2,
);

chrome.webRequest.onHeadersReceived.addListener(deleteHeaderCache, {
  urls: ['<all_urls>'],
});


chrome.webRequest.onErrorOccurred.addListener(deleteHeaderCache, {
  urls: ['<all_urls>'],
});

/**
 * Forgets a request's headers once its response or its error came.
 * @param {{tabId: number, frameId: number, requestId: string}} details - webRequest's.
 * @return {undefined}
 */
function deleteHeaderCache(details) {
  Tabs.forgetRequestHeaders(details.tabId, details.requestId);
}

ensureOptions();

// Link to a form to report bugs
// chrome.runtime.setUninstallURL('https://docs.google.com/forms/d/e/1FAIpQLSfldLYAi0xAW9tYKMcUsfYYk8KyOQDZlLFjqwwz1LajchpBvA/viewform?usp=sf_link');

Utils.printWelcome(ExtensionVersion);
