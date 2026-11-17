// @ts-check
import {DefaultOptions} from './defaults/DefaultOptions.mjs';
import {KEYBINDS_VERSION} from './KeybindUtils.mjs';

// The options page's settings file: what an export writes, and what an import may take.

// This computer's, never another's: the import keeps the path set here (a file from someone
// else could name a program they had put on this computer), so the export leaves it out too.
// It named the Windows account (C:\Users\<name>\...) in a file meant to be shared (glm's
// review, 2026-11-16).
const LOCAL_ONLY = ['mpvPath'];

// Limits with "none" (-1) or an amount from 0 up, in bytes, bytes a second or seconds, as the
// page's fields save them (readLimit, the buffer fields).
const LIMITS = ['maxSpeed', 'maxVideoSize', 'ramBudget', 'bufferAhead', 'bufferBehind'];

/**
 * The settings an export writes: all of them but this computer's own.
 * @param {Object<string, *>} options - The saved options.
 * @return {Object<string, *>} A new object.
 */
export function settingsForExport(options) {
  const out = {...options};
  for (const name of LOCAL_ONLY) delete out[name];
  return out;
}

/**
 * The imported file as the migrations may read it: a layout version above this build's taken
 * as this build's. Kept, a file that said 1e9 was saved so, and no later layout change was ever
 * applied to that user's keys. A file of a newer build loses
 * nothing: this build knows no later change to apply.
 * @param {Object<string, *>} file - The file's settings object.
 * @return {Object<string, *>} A new object.
 */
export function importedForMigration(file) {
  const out = {...file};
  // JSON's 1e999 is Infinity, which is no integer: a number test, so it is held too (Claude's
  // review of #714).
  if (typeof out.keybindsVersion === 'number' && !(out.keybindsVersion <= KEYBINDS_VERSION)) {
    out.keybindsVersion = KEYBINDS_VERSION;
  }
  return out;
}

/**
 * Holds an imported file's numbers that no field limits (holdToFields does those) to what the
 * fields can save: a limit is -1 or a whole amount from 0 up, the zoom 10% to 200% (its slider),
 * the delay a finite number. Merged over the defaults, a number only had to be a number: -5 GB of
 * RAM, an Infinity of buffer (JSON's 1e999), a zoom of 1e9 went in as they were.
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
}
