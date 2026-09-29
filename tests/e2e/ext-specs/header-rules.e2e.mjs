// A stream's Referer reaches the server, whatever characters its URL contains.
//
// Sites that check Referer/Origin get them through SET_HEADERS: the background adds a
// declarativeNetRequest session rule for the request URL, and the rule sets the headers.
// The rule's urlFilter has no escape character, so when the URL's `*`, `^` and `|` were
// "escaped" with a backslash, the rule demanded a backslash no URL has. A URL with a `*` -
// an Akamai `acl=/*` token, say - then went out with no Referer at all.
//
// Driven on the installed extension, so the rule runs in Firefox's real rule engine: an
// extension page asks for the header rule, fetches the URL, and the server reports what
// Referer it saw. The plain URL is the control: it shows the mechanism works at all here.

import http from 'node:http';

import {expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

const SITE_PORT = 41984;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const REFERER = 'https://video-site.test/watch/1';

let siteServer;
const seen = new Map();

describe('Header rules for a stream URL', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      const id = new URL(req.url, SITE).searchParams.get('id');
      if (id) seen.set(id, req.headers.referer || null);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Access-Control-Allow-Origin': '*',
      });
      res.end('ok');
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    if (siteServer) await new Promise((resolve) => siteServer.close(resolve));
  });

  /**
   * Asks the background for a Referer rule on the URL, then fetches it from the page.
   * @param {string} url - The URL to fetch.
   * @return {Promise<Object>} What the page saw.
   */
  function fetchWithReferer(url) {
    return inExtensionPage((args, done) => {
      chrome.runtime.sendMessage({
        type: 'SET_HEADERS',
        url: args.url,
        commands: [{operation: 'set', header: 'referer', value: args.referer}],
      }).then(() => fetch(args.url, {cache: 'no-store'}))
          .then((response) => done({status: response.status, url: response.url}))
          .catch((e) => done({error: String(e)}));
    }, {url, referer: REFERER});
  }

  const cases = [
    ['a plain URL (the control)', 'plain', '/stream/master.m3u8?id=plain'],
    ['a URL with a *', 'star', '/stream/master.m3u8?acl=/*~hmac=5f&id=star'],
    ['a URL with a ^ and a |', 'caret', '/stream/master.m3u8?sig=a^b|c&id=caret'],
  ];

  for (const [name, id, path] of cases) {
    it(`sends the Referer for ${name}`, async function() {
      const page = await fetchWithReferer(SITE + path);
      console.log('      page:', JSON.stringify(page), 'server saw:', seen.get(id));
      expect(page.status).toBe(200);
      expect(seen.get(id)).toBe(REFERER);
    });
  }
});
