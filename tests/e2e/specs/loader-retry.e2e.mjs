// FetchLoader's stall retry, against Firefox's own fetch().
//
// Every fragment, playlist and manifest goes through FetchLoader. When a request stalls, the
// stall timer calls retry(), which aborts the attempt's AbortController and schedules the
// next one. Firefox's fetch() then rejects the stalled attempt with an AbortError. That
// rejection used to be counted as a second failure of the load: retry() ran again, so one
// stall spent two of the load's retries, doubled the backoff twice and replaced the retry
// already scheduled. With the default six retries a stalled fragment got two stall
// retries instead of three before it was given up on.
//
// tests/unit/FetchLoader.test.mjs covers the same with a stubbed fetch(); this checks that a
// real one behaves the way the stub claims.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

const STALL_PORT = 41884;
const STALL_ORIGIN = `http://127.0.0.1:${STALL_PORT}`;

let server;
let requests = [];
const openResponses = new Set();

describe('FetchLoader stall retry in Firefox', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Content-Type': 'application/octet-stream',
      };
      const url = new URL(req.url, STALL_ORIGIN);
      if (url.pathname === '/count') {
        res.writeHead(200, {...headers, 'Content-Type': 'application/json'});
        res.end(JSON.stringify(requests));
        return;
      }
      requests.push({path: url.pathname, time: Date.now()});
      const n = requests.filter((r) => r.path === url.pathname).length;
      if (url.pathname === '/stall-headers' && n === 1) {
        // Never answers: the attempt stalls before any headers arrive.
        openResponses.add(res);
        return;
      }
      if (url.pathname === '/stall-body' && n === 1) {
        // Headers and two bytes, then nothing more.
        res.writeHead(200, {...headers, 'Content-Length': '3'});
        res.write(Buffer.from([1, 2]));
        openResponses.add(res);
        return;
      }
      res.writeHead(200, {...headers, 'Content-Length': '3'});
      res.end(Buffer.from([1, 2, 3]));
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(STALL_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    openResponses.forEach((res) => res.destroy());
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async function() {
    requests = [];
    await browser.url('/player/index.html?t=' + Date.now());
  });

  /**
   * Loads one URL through FetchLoader in the page, with a short stall timeout.
   * @param {string} url - What to load.
   * @return {Promise<Object>} The callbacks it made and its retry count.
   */
  async function loadInPage(url) {
    await browser.execute((target) => {
      window.__loaderResult = undefined;
      import('/player/network/FetchLoader.mjs').then(({FetchLoader}) => {
        const loader = new FetchLoader();
        const calls = [];
        const finish = () => {
          window.__loaderResult = {calls, retry: loader.stats.retry, retryDelay: loader.retryDelay};
        };
        loader.addCallbacks({
          onProgress: () => calls.push('onProgress'),
          onSuccess: (response) => {
            calls.push('onSuccess:' + new Uint8Array(response.data).join(','));
            finish();
          },
          onError: () => {
            calls.push('onError');
            finish();
          },
          onTimeout: () => {
            calls.push('onTimeout');
            finish();
          },
        });
        loader.load({url: target, responseType: 'arraybuffer', headers: {}},
            {timeout: 700, maxRetry: 6, retryDelay: 100, maxRetryDelay: 64000});
      }).catch((e) => {
        window.__loaderResult = {error: String(e)};
      });
    }, url);
    await browser.waitUntil(async () => browser.execute(() => window.__loaderResult !== undefined),
        {timeout: 15000, timeoutMsg: 'the load never finished'});
    // Anything a second, stale retry would add arrives within its doubled backoff.
    await browser.pause(1000);
    return browser.execute(() => window.__loaderResult);
  }

  for (const kind of ['headers', 'body']) {
    it(`retries a request that stalls before its ${kind} exactly once`, async function() {
      const result = await loadInPage(`${STALL_ORIGIN}/stall-${kind}`);
      const seen = requests.filter((r) => r.path === `/stall-${kind}`);
      console.log(`      stall-${kind}:`, JSON.stringify({result, gapMs: seen[1] && seen[1].time - seen[0].time}));

      expect(result.error).toBeUndefined();
      expect(result.calls).toEqual(['onProgress', 'onSuccess:1,2,3']);
      expect(result.retry).toBe(1);
      expect(result.retryDelay).toBe(200);
      expect(seen.length).toBe(2);
      // The gap is logged, not asserted: it is the stall timeout plus one retryDelay
      // (~800 ms here), against ~900 ms with the doubled delay a second retry() left
      // behind - too close to hold on a busy runner. retryDelay above tells them apart.
    });
  }
});
