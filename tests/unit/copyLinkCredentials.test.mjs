import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as acorn from 'acorn';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// Login headers and stream links (#185). A source's headers are the ones its page's
// request carried, Cookie and Authorization included. The copied link (a click on the time
// readout, the Sources browser's copy button) put them in the query, so whoever the link
// was pasted to got the session in clear; and a link handed to the player (pasted, or a
// page that opens the player on one) could make it send credentials of the link's
// choosing. Both now leave out Cookie, Authorization and Proxy-Authorization, whatever
// their case; every other header stays. InterfaceController imports the generated
// coloris.mjs, which does not exist when CI runs the unit tests, so the time readout's
// copy is checked from the source: it builds its link with VideoSource.toCopyURL, and no
// file but VideoSource.mjs writes the headers into a link.

const doc = new FakeDocument('<html><body></body></html>');
let copied = null;
doc.execCommand = (command) => {
  if (command === 'copy') copied = doc.activeElement.value;
  return true;
};
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {});
const el = () => doc.body.appendChild(doc.createElement('div'));
globalThis.__copyLinkDom = {playerContainer: el()};

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: globalThis.__copyLinkDom}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/AlertPolyfill.mjs', () => ({AlertPolyfill: {}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {}}));
vi.mock('../../chrome/player/ui/components/Dropdown.mjs', () => ({createDropdown: () => document.createElement('div')}));

const {VideoSource} = await import('../../chrome/player/VideoSource.mjs');
const {PlayerModes} = await import('../../chrome/player/enums/PlayerModes.mjs');
const {SourcesBrowser} = await import('../../chrome/player/ui/SourcesBrowser.mjs');

const STREAM = 'https://cdn.example/live/index.m3u8?token=abc';

/**
 * A source as the page's request gave it: login headers in mixed case, and others.
 * @return {VideoSource}
 */
function capturedSource() {
  const source = new VideoSource(STREAM, {}, PlayerModes.ACCELERATED_HLS);
  source.headers = {
    'Cookie': 'session=secret',
    'AUTHORIZATION': 'Bearer secret',
    'proxy-authorization': 'Basic secret',
    'referer': 'https://site.example/watch/1',
    'origin': 'https://site.example',
    'x-custom': 'kept',
  };
  return source;
}

const linkHeaders = (link) => JSON.parse(new URL(link).searchParams.get('faststream-headers'));
const kept = {'referer': 'https://site.example/watch/1', 'origin': 'https://site.example', 'x-custom': 'kept'};

beforeEach(() => {
  copied = null;
});

describe('VideoSource.toCopyURL', () => {
  it('leaves the login headers out of the link, and keeps the others and the mode', () => {
    const url = capturedSource().toCopyURL();
    expect(linkHeaders(url)).toEqual(kept);
    expect(url.searchParams.get('faststream-mode')).toBe(PlayerModes.ACCELERATED_HLS);
    expect(url.searchParams.get('token')).toBe('abc');
    expect(url.toString()).not.toContain('secret');
  });

  it('puts no headers in the link when the login ones were all there were', () => {
    const source = new VideoSource(STREAM, {Cookie: 'session=secret'}, PlayerModes.ACCELERATED_HLS);
    expect(source.toCopyURL().searchParams.has('faststream-headers')).toBe(false);
  });
});

describe('VideoSource.parseHeadersParam', () => {
  it('takes no login headers from a link, and the others as before', () => {
    const headers = {'Cookie': 'session=attacker', 'Authorization': 'Bearer attacker', 'PROXY-AUTHORIZATION': 'x', 'Referer': 'https://site.example/'};
    const link = `${STREAM}&faststream-headers=${encodeURIComponent(JSON.stringify(headers))}&faststream-mode=${PlayerModes.ACCELERATED_HLS}`;
    const source = new VideoSource(link, {}, PlayerModes.AUTO);
    source.parseHeadersParam();
    expect(source.headers).toEqual({referer: 'https://site.example/'});
    expect(source.url).toBe(STREAM);
    expect(source.mode).toBe(PlayerModes.ACCELERATED_HLS);
  });

  it('reads back what a copied link holds', () => {
    const source = new VideoSource(capturedSource().toCopyURL().toString(), {}, PlayerModes.AUTO);
    source.parseHeadersParam();
    expect(source.headers).toEqual(kept);
    expect(source.url).toBe(STREAM);
  });
});

describe('the time readout\'s copy', () => {
  const chromeDir = fileURLToPath(new URL('../../chrome', import.meta.url));
  const source = fs.readFileSync(path.join(chromeDir, 'player/ui/InterfaceController.mjs'), 'utf8');

  it('builds its link with VideoSource.toCopyURL', () => {
    let method = null;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.type === 'MethodDefinition' && node.key.name === 'copySourceLink') method = node;
      for (const key of Object.keys(node)) {
        if (key !== 'start' && key !== 'end') walk(node[key]);
      }
    };
    walk(acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'}));
    expect(method).not.toBe(null);
    expect(source.slice(method.start, method.end)).toContain('this.client.source.toCopyURL()');
    expect(source).toMatch(/DOMElements\.duration\.addEventListener\('click', \(e\) => \{\s*this\.copySourceLink\(\);/);
  });

  it('is the only way a link gets headers: no file but VideoSource.mjs writes them', () => {
    const writers = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.m?js$/.test(entry.name) && /faststream-headers['"],/.test(fs.readFileSync(full, 'utf8'))) {
          writers.push(path.relative(chromeDir, full).split(path.sep).join('/'));
        }
      }
    };
    walk(chromeDir);
    expect(writers).toEqual(['player/VideoSource.mjs']);
  });
});

describe('the Sources browser\'s copy button', () => {
  it('copies the link without the login headers', () => {
    const browser = {linkui: {sourcesList: el()}, updateSources: () => {}, client: {}};
    const source = capturedSource();
    SourcesBrowser.prototype.setupSourceListing.call(browser, source);
    const button = browser.linkui.sourcesList.querySelector('.linkui-source-copy-button');
    button.click();
    expect(copied).not.toBe(null);
    expect(linkHeaders(copied)).toEqual(kept);
    expect(copied).not.toContain('secret');
    expect(globalThis.__copyLinkDom.playerContainer.children).toEqual([]);
    // The player itself keeps sending what it captured.
    expect(source.headers.Cookie).toBe('session=secret');
  });
});
