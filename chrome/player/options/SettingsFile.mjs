// @ts-check
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {KEYBINDS_VERSION} from './KeybindUtils.mjs';
import {bufferKeepSeconds} from './BufferKeep.mjs';

// Never imported (a shared file could name a program planted on this computer), never exported
// (it names the Windows account).
const LOCAL_ONLY = ['mpvPath'];

// -1 for none, or a whole amount from 0 up.
const LIMITS = ['maxSpeed', 'maxVideoSize', 'ramBudget', 'bufferAhead', 'bufferBehind'];

/**
 * @param {Object<string, *>} options - The saved options.
 * @return {Object<string, *>} A new object.
 */
export function settingsForExport(options) {
  const out = {...options};
  for (const name of LOCAL_ONLY) delete out[name];
  return out;
}

/**
 * A layout version above this build's is taken as this build's: kept, no later migration
 * would ever run for that user's keys.
 * @param {Object<string, *>} file - The file's settings object.
 * @return {Object<string, *>} A new object.
 */
export function importedForMigration(file) {
  const out = {...file};
  // A number test, not an integer one: JSON's 1e999 is Infinity.
  if (typeof out.keybindsVersion === 'number' && !(out.keybindsVersion <= KEYBINDS_VERSION)) {
    out.keybindsVersion = KEYBINDS_VERSION;
  }
  return out;
}

/**
 * Holds an imported file's numbers that no field limits (holdToFields does those) to what the
 * fields can save.
 * @param {Object<string, *>} options - Merged over DefaultOptions; changed in place.
 */
export function holdImportedNumbers(options) {
  /** @type {Object<string, *>} */
  const defaults = DefaultOptions;
  for (const name of LIMITS) {
    const value = options[name];
    options[name] = value === -1 || (Number.isFinite(value) && value >= 0) ? (value === -1 ? -1 : Math.floor(value)) : defaults[name];
  }
  options.videoZoom = Number.isFinite(options.videoZoom) ? Math.min(Math.max(options.videoZoom, 0.1), 2) : defaults.videoZoom;
  if (!Number.isFinite(options.videoDelay)) options.videoDelay = defaults.videoDelay;
  // One of the settings' steps: none other is kept (up to an hour).
  options.bufferKeep = bufferKeepSeconds(options.bufferKeep);
}
