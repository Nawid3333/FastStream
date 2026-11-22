// @ts-check
import {Localize} from '../modules/Localize.mjs';
import {EnvUtils} from '../utils/EnvUtils.mjs';

// The background's own parsers are imported when needed, never at load: the web build has no
// background folder (nor lists to fill in), and a static import kept the whole options page from
// loading there.

/**
 * The lines a URL list (Auto-enable URLs, the mpv list) leaves out: neither a comment nor an
 * entry it can read.
 * @param {string} text - The field's text.
 * @return {Promise<number[]>} Line numbers from 1.
 */
export async function ignoredUrlLines(text) {
  const {UrlMatchList} = await import('../../background/UrlMatchList.mjs');
  /** @type {number[]} */
  const lines = [];
  String(text).split('\n').forEach((line, i) => {
    const entry = line.trim();
    if (entry && !entry.startsWith('#') && !UrlMatchList.parseEntry(entry)) lines.push(i + 1);
  });
  return lines;
}

/**
 * The lines the custom source patterns leave out.
 * @param {string} text - The field's text.
 * @return {Promise<number[]>} Line numbers from 1.
 */
export async function ignoredPatternLines(text) {
  const {parseCustomSourcePatterns} = await import('../../background/CustomSourcePatterns.mjs');
  return parseCustomSourcePatterns(text).errors.map((error) => error.line);
}

/**
 * Under a list's field (its id + "ignored"): the lines it leaves out, or nothing. Only in the
 * extension. Never rejects.
 * @param {HTMLTextAreaElement} input
 * @param {(text: string) => Promise<number[]>} find - ignoredUrlLines or ignoredPatternLines.
 * @return {Promise<void>}
 */
export async function showIgnoredLines(input, find) {
  const hint = document.getElementById(input.id + 'ignored');
  if (!hint || !EnvUtils.isExtension()) return;
  const text = input.value;
  let lines;
  try {
    lines = await find(text);
  } catch (e) {
    console.error('Reading the list failed', e);
    return;
  }
  // Changed meanwhile: the call for the new text shows its lines.
  if (input.value !== text) return;
  hint.textContent = lines.length ? Localize.getMessage('options_list_ignored_lines', [lines.join(', ')]) : '';
  hint.hidden = !lines.length;
}
