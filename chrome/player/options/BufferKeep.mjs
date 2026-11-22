// @ts-check

// How long a gone player's buffer is kept for the next player of the same video on the same page (BufferStash),
// in seconds: the settings offer these steps alone, so no other value is saved, imported or kept.
export const BufferKeepChoices = [0, 20, 60, 300, 900, 1800, 3600];
export const BufferKeepDefault = 20;
// Up to this, the buffer stays in the background's RAM as it was handed over. A private window's always does
// (never on the disk), and the background's RAM goes with its event page, which Firefox unloads about 30 s
// after its last event.
export const BufferKeepRamOnlySeconds = 20;
// The longest a kept buffer is honoured, in a player's prune too: a later deadline is a broken one.
export const BufferKeepMaxMs = Math.max(...BufferKeepChoices) * 1000;

/**
 * @param {*} value - A saved or imported option.
 * @return {number} One of BufferKeepChoices.
 */
export function bufferKeepSeconds(value) {
  return BufferKeepChoices.includes(value) ? value : BufferKeepDefault;
}

/**
 * How long to keep a buffer handed over from a window of this kind.
 * @param {*} option - Options.bufferKeep.
 * @param {boolean} ramOnly - A private window: the buffer never reaches the disk.
 * @return {number} Milliseconds; 0 for none.
 */
export function bufferKeepMs(option, ramOnly) {
  const seconds = bufferKeepSeconds(option);
  return (ramOnly ? Math.min(seconds, BufferKeepRamOnlySeconds) : seconds) * 1000;
}

/**
 * A choice in the reader's language ("20 seconds", "1 hour"); none for 0.
 * @param {number} seconds - One of BufferKeepChoices.
 * @param {string} locale
 * @return {?string}
 */
export function bufferKeepLabel(seconds, locale) {
  if (seconds <= 0) return null;
  const [unit, amount] = seconds % 3600 === 0 ? ['hour', seconds / 3600] :
    seconds % 60 === 0 ? ['minute', seconds / 60] : ['second', seconds];
  try {
    return new Intl.NumberFormat(locale, {style: 'unit', unit, unitDisplay: 'long'}).format(amount);
  } catch (e) {
    return new Intl.NumberFormat('en', {style: 'unit', unit, unitDisplay: 'long'}).format(amount);
  }
}

// A buffer kept on the disk: its record, next to its files in its session directory (KeptBufferDisk.mjs). A player's
// prune leaves the directory alone until the record's time is up.
export const KeptRecordFile = '_kept.json';
