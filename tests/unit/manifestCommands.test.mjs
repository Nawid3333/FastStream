import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// A shortcut runs by one of two paths: Firefox's own (commands.onCommand), or, when the
// page cancelled the key, content.js's report (onCancelledShortcut). A command wired into
// only one of them works on most sites and silently does nothing on the others.
//
// Ctrl+Shift+F must not be the toolbar button (_execute_action) again. A click on MPV
// goes to Off, so after the MPV key the key turned FastStream off, and getting the
// in-page player took a second press (2026-09-28).
//
// The MPV key is Alt+F since 2026-10-04 (Ctrl+Shift+U before), the owner's choice.

const read = (file) => fs.readFileSync(path.resolve(import.meta.dirname, '../..', file), 'utf8');
const manifest = JSON.parse(read('chrome/manifest.json'));
const background = read('chrome/background/background.mjs');
const messages = JSON.parse(read('chrome/_locales/en/messages.json'));

/**
 * The body of a top-level listener or function in background.mjs, up to its closing line.
 * @param {string} start - The text its first line starts with.
 * @return {string}
 */
function block(start) {
  const from = background.indexOf(start);
  if (from === -1) throw new Error(`background.mjs has no "${start}"`);
  const end = background.indexOf('\n}', from);
  return background.slice(from, end);
}

describe('manifest commands', () => {
  const names = Object.keys(manifest.commands);

  it('gives Ctrl+Shift+F and Alt+F a command of their own each', () => {
    const keys = Object.fromEntries(names.map((name) =>
      [name, manifest.commands[name].suggested_key?.default]));
    expect(keys).toEqual({toggle_player: 'Ctrl+Shift+F', toggle_mpv: 'Alt+F'});
  });

  it('runs every command on both paths', () => {
    const onCommand = block('chrome.commands.onCommand.addListener(');
    const onCancelled = block('async function onCancelledShortcut(');
    expect(names.filter((name) => !onCommand.includes(`command === '${name}'`))).toEqual([]);
    expect(names.filter((name) => !onCancelled.includes(`command.name === '${name}'`))).toEqual([]);
  });

  it('describes every command, in English at least', () => {
    for (const name of names) {
      const description = manifest.commands[name].description;
      const key = /^__MSG_(\w+)__$/.exec(description || '');
      expect(key, name).not.toBeNull();
      expect(messages[key[1]]?.message, name).toBeTruthy();
    }
  });
});
