// End-to-end checks for the YouTube (youtubei.js) vendor path.
//
// Why this exists: yt.mjs is the largest vendored library that will never get
// the hash-verifiable npm base every other migrated library has - its base is
// a specific commit on Andrews54757's fork past youtubei.js@17.0.1, with
// current user-agent strings Andrew maintains (YouTube rejects stale ones).
// It is also the feature that breaks most often in the wild
// (upstream issue #476 and predecessors: "YouTube broken again").
//
// Until now nothing executed it - not the playback suite, not the module
// suite. A vendor file that nothing imports can be replaced byte-for-byte
// with garbage and every check stays green, which is exactly how a bad
// upstream pull would land unnoticed.
//
// What is and is not covered
// -------------------------
// The WEB build ships the full YT path (the SPLICER only removes it for the
// firefox-amo target), so this spec loads yt.mjs from the served web build
// through a real browser: module resolution, the browser bundle's shape, and
// the Innertube session-construction path all execute.
//
// What it deliberately cannot do from here: talk to youtube.com. A web page
// at http://127.0.0.1 has no host permissions, so YouTube's endpoints answer
// the session bootstrap with a CORS failure - this was verified, not
// assumed, and it is the same wall the main.mjs web build hits. Real metadata
// resolution and playback are covered by the extension-loaded suite
// (tests/e2e/ext-specs/), which runs under the extension origin and its host
// permissions. The two suites split the coverage at exactly that boundary:
// this one proves the library bundle is intact and constructible; the
// extension one proves it can actually reach YouTube.

import {browser, expect} from '@wdio/globals';

/**
 * Runs an async snippet in the page and waits for it to settle - the same
 * helper pattern modules.e2e.mjs uses, because `browser.execute` returns
 * before async work finishes and a promise-returning body would report
 * success before the work it started had completed.
 *
 * @param {Function} fn async function to run in the page
 * @param {number} [timeout] how long to allow, in ms
 * @return {Promise<*>} whatever fn resolved with
 */
async function runInPage(fn, timeout = 60000) {
  await browser.execute((body) => {
    window.__out = undefined;
    window.__err = undefined;
    (0, eval)(`(${body})()`)
        .then((v) => {
          window.__out = v;
        })
        .catch((e) => {
          window.__err = ((e && e.message) ? e.message + '\n' : '') +
            ((e && e.stack) || String(e));
        });
  }, fn.toString());

  await browser.waitUntil(
      async () => browser.execute(
          () => window.__out !== undefined || window.__err !== undefined),
      {timeout, interval: 250, timeoutMsg: 'the page never settled'},
  );

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
}

describe('the YouTube library', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('loads the youtubei.js bundle and exposes the Innertube API', async function() {
    const result = await runInPage(async () => {
      const yt = await import('/player/modules/yt.mjs');
      const missing = ['Innertube', 'ClientType', 'Session', 'HTTPClient',
        'Parser', 'FormatUtils', 'Helpers', 'Constants', 'Actions']
          .filter((name) => !(name in yt));
      return {
        exports: Object.keys(yt).length,
        missing,
        clientTypes: Object.keys(yt.ClientType).length,
        // The session factory is what YTPlayer constructs a source with;
        // its absence is the first thing a botched vendor pull breaks.
        innertubeCreates: typeof yt.Innertube.create === 'function',
      };
    });

    expect(result.exports).toBeGreaterThan(30);
    expect(result.missing).toEqual([]);
    expect(result.clientTypes).toBeGreaterThan(5);
    expect(result.innertubeCreates).toBe(true);
  });

  it('constructs a session context without touching the network', async function() {
    // generate_session_locally skips the innertube_config fetch and derives
    // the context from the client metadata in the bundle - the same path
    // used when offline. It executes Session.getSessionData, buildContext
    // and the Session constructor, so a bundle whose client metadata was
    // mangled by a bad vendor pull fails here even without network access.
    const result = await runInPage(async () => {
      const yt = await import('/player/modules/yt.mjs');
      // Innertube.create returns an ApiInstance; the Session lives behind
      // its `session` getter (a class field, which is why it is not visible
      // in Object.keys). client_type - not client - is the option the
      // bundle actually threads into getSessionData; verified against the
      // bundle's own create() signature rather than the upstream docs.
      const innertube = await yt.Innertube.create({
        client_type: 'IOS',
        retrieve_player: false,
        generate_session_locally: true,
        // YTPlayer passes its own maintained iOS user agent; the bundle's
        // default is a random desktop one. Passing it here mirrors the real
        // call path - the UA is caller-supplied, and YouTube rejects stale
        // ones, which is why the fork maintains it.
        user_agent: yt.Constants.CLIENTS.IOS.USER_AGENT,
        // The browser shim stores fetch unbound (fetch: globalThis.fetch);
        // an unbound native fetch throws in Firefox's eval context, so an
        // explicit bound one is passed.
        fetch: (input, init) => fetch(input, init),
      });
      const client = innertube.session?.context?.client || {};
      return {
        clientName: client.clientName ?? null,
        hl: client.hl ?? null,
        gl: client.gl ?? null,
        userAgent: client.userAgent ?? null,
        clientVersion: client.clientVersion ?? null,
        apiKey: typeof innertube.session?.api_key === 'string',
      };
    });

    console.log('      yt session:', JSON.stringify(result));
    // These come from the bundle's own client metadata (Constants.CLIENTS
    // threaded through buildContext) - the check that a vendor pull which
    // drops or mangles that metadata fails.
    expect(result.clientName).toBe('IOS');
    expect(result.hl).toBeTruthy();
    expect(result.gl).toBeTruthy();
    // The iOS user agent is the bundle's maintained string - the one thing
    // YouTube actively rejects when stale, which is why Andrew maintains
    // it in the fork.
    expect(result.userAgent).toMatch(/iPhone/);
    expect(result.clientVersion).toBeTruthy();
    expect(result.apiKey).toBe(true);
  });
});
