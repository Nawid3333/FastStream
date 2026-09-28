import fs from 'node:fs';
import path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';

// The background marks a frame playerOpening when it asks content.js to open a player
// there, and clears it when the player announces itself. The mark also stops a second
// player being asked for. It was cleared on 'no_video' only: when the request failed -
// the frame had navigated away, or has no content script - the mark stayed, and that
// frame never got a player again. Only the answers that mean a player is coming keep it.

const root = path.resolve(import.meta.dirname, '../..');
let BackgroundUtils;

beforeAll(async () => {
  // BackgroundUtils reads the player URL when it loads.
  globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
  ({BackgroundUtils} = await import('../../chrome/background/BackgroundUtils.mjs'));
});

describe('isPlayerOpeningResponse', () => {
  it.each(['redirect', 'replaceall', 'replace'])('%s: a player is on its way', (response) => {
    expect(BackgroundUtils.isPlayerOpeningResponse(response)).toBe(true);
  });

  it.each(['no_video', undefined, null, '', 'ok', true])('%s: none is', (response) => {
    expect(BackgroundUtils.isPlayerOpeningResponse(response)).toBe(false);
  });
});

describe('the OPEN_PLAYER answers', () => {
  it('are the ones content.js sends', () => {
    const source = fs.readFileSync(path.join(root, 'chrome/content.js'), 'utf8');
    const handler = /function handlePlayerOpen\([\s\S]*?\n {2}function /.exec(source);
    expect(handler).not.toBeNull();
    const sent = new Set(Array.from(handler[0].matchAll(/sendResponse\('([a-z_]+)'\)/g), (m) => m[1]));
    // A new answer in content.js has to be sorted into "a player is coming" or not.
    expect([...sent].sort()).toEqual([...BackgroundUtils.PlayerOpeningResponses, 'no_video'].sort());
  });

  it('decide whether the background keeps the frame marked playerOpening', () => {
    const source = fs.readFileSync(path.join(root, 'chrome/background/background.mjs'), 'utf8');
    const openPlayer = /async function openPlayer\(frame\) \{[\s\S]*?\n\}/.exec(source);
    expect(openPlayer).not.toBeNull();
    expect(openPlayer[0]).toMatch(/if \(!BackgroundUtils\.isPlayerOpeningResponse\(response\)\) \{\s*frame\.playerOpening = false;/);
  });
});
