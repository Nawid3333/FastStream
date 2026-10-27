// The page's right-click menu (ContextMenu.mjs, his wish of 2026-10-24) in the real Firefox.
// The unit tests drive the background with a stand-in menus API; this asks Firefox whether
// the background's items are there. Firefox lists no menu items, but menus.update() on an id
// fails for an item that does not exist ("Could not find any MenuItem with id"), so an
// update that succeeds is an item the background made. A make that Firefox refused (a URL
// pattern, a context or a property it does not take) leaves none.

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {OPENER_URL} from '../wdio.extension.conf.mjs';

const IDS = ['faststream-player', 'faststream-mpv', 'faststream-link-player', 'faststream-link-mpv'];

describe('The right-click menu', function() {
  it('is made by the background, in a Firefox with the menus API\'s onShown and refresh', async function() {
    await browser.url(OPENER_URL);
    const found = await inExtensionPage((ids, done) => {
      const menus = chrome.menus || chrome.contextMenus;
      const probe = () => Promise.all(ids.map((id) => menus.update(id, {}).then(() => 'made', (e) => `missing: ${e.message}`)));
      // The background makes the items anew at each of its starts, once the options are read
      // (background.mjs), and this can ask right after the browser started, before that: all
      // four "missing" in a run of the flaky week (#583). Asked again until all are there, or
      // for 10 s, so items Firefox refused are still missing at the end.
      const until = Date.now() + 10000;
      const ask = () => probe().then((states) => (states.every((state) => state === 'made') || Date.now() > until ?
        states : new Promise((wait) => setTimeout(wait, 250)).then(ask)));
      ask().then((states) => done({
        api: !!chrome.menus,
        items: Object.fromEntries(ids.map((id, i) => [id, states[i]])),
        onShown: typeof menus.onShown?.addListener === 'function',
        refresh: typeof menus.refresh === 'function',
      }), (e) => done({error: e.message}));
    }, IDS);
    expect(found).toEqual({
      api: true,
      items: Object.fromEntries(IDS.map((id) => [id, 'made'])),
      onShown: true,
      refresh: true,
    });
  });
});
