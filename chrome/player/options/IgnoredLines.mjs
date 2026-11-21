// @ts-check
import {parseCustomSourcePatterns} from '../../background/CustomSourcePatterns.mjs';
import {UrlMatchList} from '../../background/UrlMatchList.mjs';
import {Localize} from '../modules/Localize.mjs';

/**
 * The lines a URL list (Auto-enable URLs, the mpv list) leaves out: neither a comment nor an
 * entry it can read.
 * @param {string} text - The field's text.
 * @return {number[]} Line numbers from 1.
 */
export function ignoredUrlLines(text) {
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
 * @return {number[]} Line numbers from 1.
 */
export function ignoredPatternLines(text) {
  return parseCustomSourcePatterns(text).errors.map((error) => error.line);
}

/**
 * Under a list's field (its id + "ignored"): the lines it leaves out, or nothing.
 * @param {HTMLTextAreaElement} input
 * @param {number[]} lines
 */
export function showIgnoredLines(input, lines) {
  const hint = document.getElementById(input.id + 'ignored');
  if (!hint) return;
  hint.textContent = lines.length ? Localize.getMessage('options_list_ignored_lines', [lines.join(', ')]) : '';
  hint.hidden = !lines.length;
}
