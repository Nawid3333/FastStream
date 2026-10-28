import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground} from './backgroundHarness.mjs';

// Who may send the background each message it answers (background.mjs's MessageSenders):
// FastStream's own pages only, or its content scripts too, which run in every page. Some
// handlers checked their sender and others did not: LOAD_OPTIONS, MPV_TEST, CLEAR_SOURCES and
// REQUEST_PLAYLIST_NAVIGATION, which only the options page or the player send, did what a
// content script asked (glm's review, 2026-10-28). One list, read before any handler, is the
// check now, and a new message cannot be answered without saying who may send it.

const chromeDir = path.resolve(import.meta.dirname, '../../chrome');
const PAGE = 'https://site.test/watch';
const PLAYER = 'moz-extension://bg-test/player/index.html';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

/** @return {Set<string>} The types runtime.onMessage's listener answers: its branches. */
function answeredTypes() {
  const source = fs.readFileSync(path.join(chromeDir, 'background/background.mjs'), 'utf8');
  const start = source.indexOf('chrome.runtime.onMessage.addListener(');
  const end = source.indexOf('\n});\n', start);
  return new Set([...source.slice(start, end).matchAll(/msg\.type === MessageTypes\.([A-Z_]+)/g)].map((m) => m[1]));
}

/** @return {Set<string>} The types the content scripts send (a message's `type:` field). */
function contentScriptTypes() {
  const manifest = JSON.parse(fs.readFileSync(path.join(chromeDir, 'manifest.json'), 'utf8'));
  const files = new Set(manifest.content_scripts.flatMap((entry) => entry.js));
  const types = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(chromeDir, file), 'utf8');
    for (const m of source.matchAll(/type:\s*(?:MessageTypes\.([A-Z_]+)|['"]([A-Z_]+)['"])/g)) types.add(m[1] || m[2]);
  }
  return types;
}

describe('Who may send the background a message', () => {
  it('is said for every type the listener answers, and for no other', async () => {
    bg = await loadBackground();
    const {MessageSenders} = await import('../../chrome/background/background.mjs');
    const answered = answeredTypes();
    // A pattern that stopped matching would make this pass on nothing.
    expect(answered.size).toBeGreaterThanOrEqual(30);
    expect([...answered].filter((type) => !(type in MessageSenders))).toEqual([]);
    expect(Object.keys(MessageSenders).filter((type) => !answered.has(type))).toEqual([]);
    expect(new Set(Object.values(MessageSenders))).toEqual(new Set(['own', 'any']));
  });

  it('is FastStream\'s own pages only for no type a content script sends', async () => {
    bg = await loadBackground();
    const {MessageSenders} = await import('../../chrome/background/background.mjs');
    const sent = contentScriptTypes();
    expect(sent.has('LOADED_MEDIA')).toBe(true);
    expect(sent.has('DETECTED_SOURCE')).toBe(true);
    expect([...sent].filter((type) => MessageSenders[type] === 'own')).toEqual([]);
  });

  it('ignores a content script that asks to read the options anew', async () => {
    bg = await loadBackground({tabs: [{id: 1, url: PAGE}]});
    await bg.message({type: 'LOAD_OPTIONS', time: 7}, {tabId: 1, url: PAGE});
    await bg.wait(1000);
    expect(bg.sent('UPDATE_OPTIONS')).toEqual([]);

    await bg.message({type: 'LOAD_OPTIONS', time: 8}, {tabId: 1, url: PLAYER});
    await bg.wait(1000);
    expect(bg.sent('UPDATE_OPTIONS').map((m) => m.message.time)).toEqual([8]);
  });

  it('ignores a content script that asks for the mpv test, which tells the mpv path', async () => {
    bg = await loadBackground({options: {mpvMode: true, mpvPath: 'C:/mpv/mpv.exe'},
      onNative: (m) => ({ok: true, mpv: true, path: m.mpvPath})});
    expect(await bg.message({type: 'MPV_TEST'}, {tabId: 1, url: PAGE})).toBe(undefined);
    await bg.wait(500);
    expect(bg.native).toEqual([]);
  });

  it('answers its own pages as before, and a content script\'s own messages too', async () => {
    bg = await loadBackground();
    expect(await bg.message({type: 'PING'}, {tabId: 1, url: PLAYER})).toBe('PONG');
    expect(await bg.message({type: 'PING'}, {tabId: 1, url: PAGE})).toBe(undefined);
    // LOADED_MEDIA is a content script's: answered from a page.
    expect(await bg.message({type: 'LOADED_MEDIA', resources: []}, {tabId: 1, url: PAGE})).not.toBe(undefined);
  });
});
