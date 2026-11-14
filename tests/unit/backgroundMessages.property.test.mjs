import fc from 'fast-check';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {loadBackground, response} from './backgroundHarness.mjs';

// What a page can make the background hear. A content script runs in every page, and what it
// tells the background is made from the page: the addresses of its videos and frames, what
// its player lists, the name it gave its document. The background must take any of it, in any
// order, without throwing and without losing its work for the tab: after any such messages,
// a page that plays a stream still gets its player.
//
// And nothing a content script sends may do what only FastStream's own pages may ask for
// (background.mjs's MessageSenders): whatever the message holds.

const PAGE = 'https://site.test/watch';
const STREAM = 'https://cdn.test/v/master.m3u8';
const PLAYLIST = '#EXTM3U\n#EXTINF:60,\na.ts\n#EXT-X-ENDLIST\n';

let bg;

afterEach(() => {
  bg?.unload();
  bg = null;
  vi.restoreAllMocks();
});

// Anything JSON can carry, and some values of the kinds the handlers read: addresses,
// document names, frame ids, lists.
const text = fc.oneof(fc.string({maxLength: 40}), fc.constantFrom(PAGE, STREAM, 'page-1', 'about:blank',
    'moz-extension://bg-test/player/index.html?opener=page-1', 'blob:https://site.test/1', 'javascript:alert(1)', '', '\u0000'));
const scalar = fc.oneof(text, fc.integer({min: -3, max: 12}), fc.double(), fc.boolean(), fc.constant(null), fc.constant(undefined));
const value = fc.oneof({depthSize: 'small'}, scalar, fc.array(scalar, {maxLength: 4}),
    fc.dictionary(fc.constantFrom('url', 'src', 'time', 'media', 'cors', 'label', 'height', 'live'), scalar, {maxKeys: 4}),
    fc.array(fc.dictionary(fc.constantFrom('url', 'src', 'time', 'media', 'cors', 'label', 'height'), scalar, {maxKeys: 4}), {maxLength: 3}));
// The fields the background reads from a content script's messages.
const FIELDS = ['url', 'document', 'frameId', 'parentFrameId', 'src', 'video', 'resources', 'live', 'mode', 'headers',
  'sources', 'time', 'force', 'direction', 'continuationOptions', 'playing', 'key', 'active', 'options', 'value'];
const payload = fc.dictionary(fc.constantFrom(...FIELDS), value, {maxKeys: 6});
// Where a content script's message can come from: the tab's frames, a frame never heard of,
// another tab, one the background never saw.
const sender = fc.record({tabId: fc.constantFrom(1, 1, 1, 2, 99), frameId: fc.constantFrom(0, 0, 0, 3, 5, 7, -1, 1e9)});

/**
 * An auto-enabled page, named in its top frame.
 * @return {Promise<{any: string[], own: string[]}>} The message types, by who may send them.
 */
async function onPage() {
  bg = await loadBackground({
    options: {autoEnableURLs: ['https://site.test/']},
    tabs: [{id: 1, url: PAGE}, {id: 2, url: 'https://other.test/'}],
    fetch: async (url) => (url === STREAM ? response(PLAYLIST) : response('', 404)),
    onTabMessage: ({message}) => (message.type === 'OPEN_PLAYER' ? 'replace' : undefined),
  });
  await bg.navigated(1, PAGE);
  await bg.frameAdded(1, 0, PAGE, 'page-1');
  const {MessageSenders} = await import('../../chrome/background/background.mjs');
  const types = Object.keys(MessageSenders);
  return {any: types.filter((type) => MessageSenders[type] === 'any'), own: types.filter((type) => MessageSenders[type] === 'own')};
}

describe('The background, told anything by a content script', () => {
  it('never throws, and still opens the player for a page that plays a stream', async () => {
    const {any} = await onPage();
    bg.unload();
    bg = null;
    expect(any.length).toBeGreaterThanOrEqual(8);
    const messages = fc.array(fc.record({type: fc.constantFrom(...any), fields: payload, from: sender}), {minLength: 1, maxLength: 8});
    await fc.assert(fc.asyncProperty(messages, async (list) => {
      await onPage();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        for (const {type, fields, from} of list) {
          await bg.message({...fields, type}, {...from, url: PAGE});
        }
        await bg.wait(8000);
        // A page that names itself and plays a stream, after all that: its player opens.
        await bg.navigated(1, PAGE);
        await bg.frameAdded(1, 0, PAGE, 'page-after');
        bg.sentToTabs.length = 0;
        await bg.request({tabId: 1, url: STREAM}, {responseHeaders: [{name: 'Content-Type', value: 'application/vnd.apple.mpegurl'}]});
        await bg.wait(3000);
        expect(bg.sent('OPEN_PLAYER').filter((m) => m.tabId === 1).length).toBeGreaterThanOrEqual(1);
        // Nothing the background itself calls a failure of its own code.
        const thrown = errors.mock.calls.filter((call) => call.some((part) => part instanceof TypeError || part instanceof ReferenceError));
        expect(thrown).toEqual([]);
      } finally {
        errors.mockRestore();
        bg.unload();
        bg = null;
      }
    }), {numRuns: 150});
  }, 180000);

  it('does nothing a content script may not ask for, whatever the message holds', async () => {
    const {own} = await onPage();
    bg.unload();
    bg = null;
    expect(own.length).toBeGreaterThanOrEqual(20);
    const messages = fc.array(fc.record({type: fc.constantFrom(...own), fields: payload, from: sender}), {minLength: 1, maxLength: 6});
    await fc.assert(fc.asyncProperty(messages, async (list) => {
      await onPage();
      try {
        // What the page's own start set off (the question what it loaded) is past.
        await bg.wait(3000);
        bg.sentToTabs.length = 0;
        const before ={native: bg.native.length, windows: bg.windowUpdates.length, runtime: bg.runtimeSent.length};
        for (const {type, fields, from} of list) {
          // From a page's content script: its sender's address is the page's.
          const answer = await bg.message({...fields, type}, {...from, url: PAGE});
          expect(answer, type).toBeUndefined();
        }
        await bg.wait(3000);
        expect(bg.sentToTabs.map((m) => m.message.type)).toEqual([]);
        expect({native: bg.native.length, windows: bg.windowUpdates.length, runtime: bg.runtimeSent.length}).toEqual(before);
      } finally {
        bg.unload();
        bg = null;
      }
    }), {numRuns: 150});
  }, 180000);
});
