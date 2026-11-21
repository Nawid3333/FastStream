// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {keyDisplayName} from '../options/KeybindUtils.mjs';
import {StringUtils} from '../utils/StringUtils.mjs';

/**
 * The key an action is on, as the welcome page writes it, or null when it has none.
 * @param {?Map<string, string>|undefined} keybinds - Action to key string.
 * @param {string} action
 * @return {?string}
 */
function keyFor(keybinds, action) {
  const key = keybinds?.get(action);
  return key && key !== 'None' ? keyDisplayName(key) : null;
}

/**
 * Said when a video starts where it was left ("Play videos from last watched position"): a silent jump to the middle
 * reads as a bug, and Undo seek cannot take it back.
 * @param {number} seconds - Where it resumed.
 * @param {?Map<string, string>|undefined} keybinds
 * @return {string}
 */
export function resumedMessage(seconds, keybinds) {
  const time = StringUtils.formatTime(seconds);
  const key = keyFor(keybinds, 'GoToStart');
  return key ? Localize.getMessage('player_resumed_key', [time, key]) : Localize.getMessage('player_resumed', [time]);
}

/**
 * Said when the page's subtitle tracks were loaded and none was turned on ("Automatically enable best found subtitle
 * track" is off by default, or none is in the subtitle language).
 * @param {number} count
 * @param {?Map<string, string>|undefined} keybinds
 * @return {string}
 */
export function subtitlesMessage(count, keybinds) {
  const key = keyFor(keybinds, 'ToggleSubtitles');
  return key ? Localize.getMessage('player_subtitles_available_key', [String(count), key]) :
    Localize.getMessage('player_subtitles_available', [String(count)]);
}
