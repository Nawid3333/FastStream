// @ts-check
// Qualities only the page player's menu knows (page-quality-control.js), chosen once per file, before anything plays:
// asked as the file is detected, the page switched to the quality the setting asks for, and FastStream's player or
// mpv starts on the file the page loads then. The rules are FastStreamClient.switchPageQuality's (picked
// automatically). docs/notes/player.md, "Qualities only the page player's menu knows".
import {MessageTypes} from '../player/enums/MessageTypes.mjs';
import {PlayerModes} from '../player/enums/PlayerModes.mjs';
import {closerTo, menuQualities, playableSwitch, sizeClass} from '../player/utils/PageQualityMenu.mjs';
import {pickQuality} from '../player/utils/PageQualityPick.mjs';
import {BackgroundUtils} from './BackgroundUtils.mjs';

/** @typedef {import('./TabTracker.mjs').TabHolder} TabHolder */
/** @typedef {import('./TabTracker.mjs').FrameHolder} FrameHolder */
/** @typedef {import('./TabTracker.mjs').TrackedSource} TrackedSource */
/** @typedef {import('../player/utils/PageQualityMenu.mjs').PageQuality} PageQuality */

// From the choice's start: a page whose menu is not found by then plays its own file.
export const MenuProbeCapMs = 2000;
// From the menu's answer: the page's switch (its menu opened again, the new file loaded) waited for this long.
export const MenuSwitchCapMs = 4000;
// How long a play the page reports meanwhile waits for its switch to answer (pageMenuSwitching).
export const MenuSwitchNoteMs = 10000;
// Files of one page whose menu is asked for: a page loads a few (an ad, the film), not dozens.
const MaxChoicesPerPage = 4;
// Hosters remembered as having no menu (NoMenu).
const MaxNoMenu = 100;

/**
 * @typedef {Object} MenuResult
 * @property {string} url - The file to play: the one switched to when taken, else the page's own.
 * @property {PageQuality[]} qualities - The menu's entries; the files known have their url.
 */

/**
 * @typedef {Object} MenuChoice
 * @property {string} url - The page's file it was asked for.
 * @property {?string} document - The frame's page then.
 * @property {?string} origin - The frame's page's origin: the hoster whose player's menu it asks.
 * @property {number} started
 * @property {number} probeCapMs - How long a start waits for the menu: none for a hoster whose page had none.
 * @property {boolean} gaveUp - Something started on the page's file without the menu's answer: the page stays as it is.
 * @property {?number} answeredAt - When the page's menu answered.
 * @property {Promise<?PageQuality[]>} entries - The menu's entries; null without a menu.
 * @property {Promise<?MenuResult>} result - Null without a menu.
 * @property {?string} pageFile - The file the page plays after its switch, taken or not.
 * @property {Array<(url: string) => void>} listeners - Told pageFile once known.
 */

/** @type {WeakMap<FrameHolder, MenuChoice[]>} */
const Choices = new WeakMap();

/** @type {WeakMap<TabHolder, Promise<void>>} */
const Switching = new WeakMap();

// The hosters whose page's player last had no quality menu: their next file starts at once, the menu still asked
// meanwhile (found, the hoster is waited for again; a start already made switches through the player's own probe).
// In memory only.
/** @type {Set<string>} */
const NoMenu = new Set();

/**
 * @param {FrameHolder} frame
 * @return {?string}
 */
function originOf(frame) {
  try {
    const url = new URL(frame.url || '');
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch (e) {
    return null;
  }
}

/**
 * @param {?string} origin
 * @param {*} answer - The probe's: null when it found no video to ask about (no word on the menu).
 * @param {?PageQuality[]} entries
 */
function noteMenu(origin, answer, entries) {
  if (!origin || !answer) return;
  NoMenu.delete(origin);
  if (entries) return;
  NoMenu.add(origin);
  if (NoMenu.size > MaxNoMenu) NoMenu.delete(/** @type {string} */ (NoMenu.values().next().value));
}

/**
 * @param {string} mode
 * @return {boolean} A single file: one through MSE switches to no file anything could play.
 */
function isFile(mode) {
  return mode === PlayerModes.ACCELERATED_MP4 || mode === PlayerModes.DIRECT;
}

/**
 * @param {number} tabId
 * @param {Object} message
 * @param {number} frameId
 * @return {Promise<*>}
 */
function askPage(tabId, message, frameId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, {frameId}, (answer) => {
      // A frame gone or without the content script: no menu.
      BackgroundUtils.checkMessageError('page_quality', true);
      resolve(answer ?? null);
    });
  });
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @return {Promise<?T>} Null once ms passed.
 */
function within(promise, ms) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  return Promise.race([promise, new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, ms));
  })]).finally(() => clearTimeout(timer));
}

/**
 * A page switch still waited for in the tab: the file it loads plays in the page, and its play is no new video.
 * @param {TabHolder} tab
 * @return {?Promise<void>}
 */
export function pageMenuSwitching(tab) {
  return Switching.get(tab) || null;
}

/**
 * @param {FrameHolder} frame
 * @return {MenuChoice[]} The frame's page's.
 */
function choicesOf(frame) {
  const document = frame.documentKey ?? null;
  let list = Choices.get(frame);
  if (!list || list.some((choice) => choice.document !== document)) {
    list = (list || []).filter((choice) => choice.document === document);
    Choices.set(frame, list);
  }
  return list;
}

/**
 * Whether a file is the one the page switched to for a choice: no file of its own to ask about or to list.
 * @param {FrameHolder} frame
 * @param {string} url
 * @return {boolean}
 */
export function isPageMenuFile(frame, url) {
  return choicesOf(frame).some((choice) => choice.pageFile === url);
}

/**
 * The choice for a page's file, made once: asked of the page frame it plays in, the first time.
 * @param {FrameHolder} frame
 * @param {TrackedSource} source
 * @param {number} wanted - desiredHeight's: Infinity for the highest.
 * @return {?MenuChoice} Null for a stream that is no single file, or a file switched to.
 */
export function startMenuChoice(frame, source, wanted) {
  if (frame.isPlayer || frame.tab.tabId < 0 || !isFile(source.mode) || !/^https?:/.test(source.url)) return null;
  const list = choicesOf(frame);
  const known = list.find((choice) => choice.url === source.url);
  if (known) return known;
  if (list.length >= MaxChoicesPerPage || isPageMenuFile(frame, source.url) ||
      (source.requestedUrl && isPageMenuFile(frame, source.requestedUrl))) {
    return null;
  }
  /** @type {(entries: ?PageQuality[]) => void} */
  let gotEntries = () => {};
  const origin = originOf(frame);
  /** @type {MenuChoice} */
  const choice = {
    url: source.url, document: frame.documentKey ?? null, origin, started: Date.now(),
    probeCapMs: origin && NoMenu.has(origin) ? 0 : MenuProbeCapMs, gaveUp: false, answeredAt: null,
    entries: new Promise((resolve) => {
      gotEntries = resolve;
    }),
    result: Promise.resolve(null), pageFile: null, listeners: [],
  };
  choice.result = makeChoice(choice, frame, source.requestedUrl || null, wanted, gotEntries).catch((e) => {
    console.warn('Choosing the page player\'s menu quality failed', e);
    gotEntries(null);
    return null;
  });
  list.push(choice);
  return choice;
}

/**
 * The choice for a file a tab plays, as startMenuChoice; made now when not made yet.
 * @param {?TabHolder} tab
 * @param {string} url
 * @param {number} wanted
 * @return {?MenuChoice}
 */
export function menuChoiceFor(tab, url, wanted) {
  if (!tab) return null;
  for (const frame of tab.getFrames()) {
    if (frame.isPlayer) continue;
    const source = frame.getSources().find(/** @param {TrackedSource} s */ (s) => s.url === url || s.requestedUrl === url);
    if (source) return startMenuChoice(frame, source, wanted);
  }
  return null;
}

/**
 * @param {MenuChoice} choice
 * @param {FrameHolder} frame
 * @param {?string} requested - The file's address before a redirect: the one the page's video names.
 * @param {number} wanted
 * @param {(entries: ?PageQuality[]) => void} gotEntries
 * @return {Promise<?MenuResult>}
 */
async function makeChoice(choice, frame, requested, wanted, gotEntries) {
  const tab = frame.tab;
  const answer = await askPage(tab.tabId, {type: MessageTypes.PAGE_QUALITY_PROBE, url: requested || choice.url},
      frame.frameId);
  choice.answeredAt = Date.now();
  const width = Number(answer?.width) || 0;
  const height = Number(answer?.height) || 0;
  const entries = menuQualities(answer, choice.url, width, height);
  noteMenu(choice.origin, answer, entries);
  gotEntries(entries);
  if (!entries) return null;
  const kept = {url: choice.url, qualities: entries};
  const playing = entries.find((entry) => entry.url === choice.url);
  const pick = /** @type {?PageQuality} */ (pickQuality(/** @type {Array<{url: string, label: string, height: number}>} */ (entries), wanted));
  const now = sizeClass(width, height) || playing?.height || 0;
  if (!pick || pick === playing || !pick.control || !closerTo(wanted, now, pick.height)) return kept;
  // Found after its cap: what plays started on the page's file already, and its player's own probe may switch.
  if (choice.gaveUp || choice.answeredAt - choice.started > MenuProbeCapMs) return kept;
  const own = /** @type {string[]} */ ([choice.url, requested].filter(Boolean));
  const select = askPage(tab.tabId, {type: MessageTypes.PAGE_QUALITY_SELECT, id: pick.control.id,
    index: pick.control.index}, frame.frameId).then((switched) => {
    const next = typeof switched?.url === 'string' && /^https?:/.test(switched.url) && !own.includes(switched.url) ?
      switched.url : null;
    if (next) {
      choice.pageFile = next;
      for (const listener of choice.listeners) {
        try {
          listener(next);
        } catch (e) {
          console.warn('Telling the file the page switched to failed', e);
        }
      }
    }
    return next ? {url: next, width: Number(switched.width) || 0, height: Number(switched.height) || 0} : null;
  });
  // Settled whatever the switch does: a play waiting for it is sent then.
  /** @type {Promise<void>} */
  const note = within(select, MenuSwitchNoteMs).catch(() => null).then(() => {
    if (Switching.get(tab) === note) Switching.delete(tab);
  });
  Switching.set(tab, note);
  const switched = await select;
  if (!switched || !own.some((played) => playableSwitch(switched.url, played))) return kept;
  // Without the page's size (a file slow to load), its label's: a label may name a file no bigger.
  const next = switched.height > 0 ? sizeClass(switched.width, switched.height) : pick.height;
  if (!closerTo(wanted, now, next)) return kept;
  pick.url = switched.url;
  return {url: switched.url, qualities: entries};
}

/**
 * Tells the file the page switched to for a choice, now or once it does: the page plays it, and its play is the
 * choice's file.
 * @param {MenuChoice} choice
 * @param {(url: string) => void} listener
 */
export function onPageMenuFile(choice, listener) {
  if (choice.pageFile) listener(choice.pageFile);
  else choice.listeners.push(listener);
}

/**
 * The choice as far as its caps allow: nothing once the menu did not answer within MenuProbeCapMs of the start (at
 * once for a hoster whose page had no menu), the page's own file once its switch did not within MenuSwitchCapMs of the
 * menu's answer.
 * @param {?MenuChoice} choice
 * @return {Promise<?MenuResult>}
 */
export async function awaitMenuChoice(choice) {
  if (!choice) return null;
  const entries = await within(choice.entries, choice.started + choice.probeCapMs - Date.now());
  if (!entries) {
    choice.gaveUp = true;
    return null;
  }
  const answeredAt = choice.answeredAt ?? Date.now();
  return await within(choice.result, answeredAt + MenuSwitchCapMs - Date.now()) || {url: choice.url, qualities: entries};
}

/**
 * Sources for FastStream's player, each a file whose menu was asked for at its detection: the file switched to, with
 * the menu's entries as its qualities (the player's quality menu lists them, and a pick switches through the page).
 * The file the page switched to is no source of its own beside the file it was switched from; alone (the list cleared
 * since), it is the page's file.
 * @param {TabHolder} tab
 * @param {Array<{url: string, requestedUrl?: string, mode: string, frameId: number, qualities?: ?Array<Object>}>} sources
 * @return {Promise<typeof sources>}
 */
export async function withMenuQualities(tab, sources) {
  const chosen = await Promise.all(sources.map((source) => {
    const frame = tab.getFrame(source.frameId);
    if (!frame || source.qualities || !isFile(source.mode)) return null;
    const choice = choicesOf(frame).find((known) => known.url === source.url);
    return awaitMenuChoice(choice || null);
  }));
  const given = new Set(sources.flatMap((source) => [source.url, source.requestedUrl || '']));
  /**
   * @param {FrameHolder} frame
   * @param {string|undefined} url
   * @return {boolean} Whether url is the file the page switched to from one of the batch.
   */
  const switchedFromGiven = (frame, url) => !!url &&
    choicesOf(frame).some((choice) => choice.pageFile === url && given.has(choice.url));
  const switched = new Set();
  sources.forEach((source, i) => {
    const result = chosen[i];
    if (!result) return;
    if (result.url !== source.url) {
      source.url = result.url;
      delete source.requestedUrl;
      switched.add(result.url);
    }
    source.qualities = result.qualities;
  });
  return sources.filter((source) => {
    const frame = tab.getFrame(source.frameId);
    return source.qualities || !frame ||
      !(switched.has(source.url) || switchedFromGiven(frame, source.url) || switchedFromGiven(frame, source.requestedUrl));
  });
}
