import {describe, expect, it} from 'vitest';
import {loadContentScript} from './contentDom.mjs';

// content.js's message handlers, run against a stand-in page (contentDom.mjs).

/**
 * The name content.js gave its page (FRAME_ADDED's document).
 * @param {Object} page - From loadContentScript.
 * @return {string}
 */
function pageName(page) {
  return page.sent.find((message) => message.type === 'FRAME_ADDED').document;
}

// A player naming a frame as its parent is taken for that frame's only when the frame's
// page opened it (#225). The background asks the frame's content script when it does not
// know the page's name itself.
describe('IS_PLAYER_OPENER', () => {
  it('answers yes for the name this page put in its players\' URLs', async () => {
    const page = loadContentScript();
    expect(await page.send({type: 'IS_PLAYER_OPENER', document: pageName(page)})).toBe(true);
  });

  it('answers no for any other name', async () => {
    const page = loadContentScript();
    for (const name of ['made-up', '', null, undefined]) {
      expect(await page.send({type: 'IS_PLAYER_OPENER', document: name}), String(name)).toBe(false);
    }
  });

  it('gives each page a name of its own', () => {
    expect(pageName(loadContentScript())).not.toBe(pageName(loadContentScript()));
  });
});
