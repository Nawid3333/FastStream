// Covers two things Nawid asked about directly, neither of which had test
// coverage: whether the options search box reaches the MPV settings, and
// whether they survive an export/import round trip. Both are driven against
// the real installed extension's options page, not reasoned about from the
// markup.

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID, OPENER_URL} from '../wdio.extension.conf.mjs';

const ORIGIN = `moz-extension://${EXTENSION_UUID}`;

/**
 * Opens an extension page and focuses it. geckodriver refuses to navigate to
 * moz-extension:// directly, so an ordinary http page opens it via
 * window.open, which only works because the page is a web-accessible
 * resource.
 *
 * Finds the target window by URL rather than by assuming it is the newest
 * handle: a freshly installed temporary add-on opens its own welcome.html
 * tab, asynchronously and on no fixed schedule relative to this function's
 * own window.open call. Trusting "last handle" landed this on welcome.html
 * instead of the requested page in practice (options/index.html is heavy
 * enough to load that the race went the wrong way reliably, not just
 * occasionally) -- confirmed with a throwaway diagnostic that logged
 * document.URL every second and found it pinned to welcome.html throughout.
 *
 * @param {string} pagePath - Path under the extension origin.
 * @return {Promise<void>} Resolves once the extension page is focused.
 */
async function openExtensionPage(pagePath) {
  const target = ORIGIN + pagePath;

  const handlesBefore = await browser.getWindowHandles();
  for (const h of handlesBefore.slice(1)) {
    await browser.switchToWindow(h);
    await browser.closeWindow();
  }
  await browser.switchToWindow(handlesBefore[0]);
  await browser.url(OPENER_URL);
  await browser.execute((u) => window.open(u, '_blank'), target);

  await browser.waitUntil(async () => {
    for (const h of await browser.getWindowHandles()) {
      await browser.switchToWindow(h);
      if ((await browser.getUrl()) === target) {
        return true;
      }
    }
    return false;
  }, {timeout: 15000, timeoutMsg: `the extension page (${target}) never opened`});

  await browser.waitUntil(
      async () => browser.execute(() => document.readyState === 'complete'),
      {timeout: 30000, timeoutMsg: 'the extension page never finished loading'});
}

describe('options page: search and export/import cover MPV settings', function() {
  it('search reveals MPV rows on a matching query and hides them on an unrelated one', async function() {
    await openExtensionPage('/player/options/index.html');

    // SearchUtils keeps two flat, page-wide arrays -- .search-target-remove
    // elements (what gets hidden/shown) and .search-target-text elements
    // (what Fuse indexes) -- and matches them up purely by position:
    // baseSearchEls[i] is assumed to be baseSearchText[i]'s container. That
    // only holds if every .search-target-remove wraps exactly one
    // .search-target-text. Checked directly against the live page rather
    // than inferred from the markup, since a mismatch would misroute
    // show/hide decisions rather than raise any error.
    //
    // Driven entirely through browser.execute, matching every other spec in
    // this suite: WebdriverIO's own $() locator does not reliably resolve
    // elements in this window/geckodriver combination (confirmed -- it
    // fails to find #searchbar itself, which browser.execute finds fine).
    const runSearch = (query) => browser.execute((q) => {
      const bar = document.getElementById('searchbar');
      bar.value = q;
      bar.dispatchEvent(new KeyboardEvent('keyup', {bubbles: true}));
    }, query);

    const isVisible = (id) => browser.execute((elId) => {
      const el = document.getElementById(elId);
      if (!el) return null;
      return el.getClientRects().length > 0 || el.offsetParent !== null;
    }, id);

    // Video options are addressed by data-option, not id.
    const isVisibleByDataOption = (opt) => browser.execute((o) => {
      const el = document.querySelector(`[data-option="${o}"]`);
      if (!el) return null;
      return el.getClientRects().length > 0 || el.offsetParent !== null;
    }, opt);

    await runSearch('fullscreen');

    await browser.waitUntil(async () => (await isVisible('mpvfullscreen')) === true,
        {timeout: 5000, timeoutMsg: 'the mpv fullscreen row never appeared for a matching search'});

    // A row for an unrelated, single-purpose setting should be hidden by
    // the same query.
    expect(await isVisibleByDataOption('videoBrightness')).toBe(false);

    // The MPV pause-page and single-instance rows share one
    // .search-target-remove wrapper with the fullscreen row (three labels,
    // one container) -- record whether an unrelated "fullscreen" query
    // incidentally reveals them too, which is what the index misalignment
    // above would cause.
    const pauseVisibleOnFullscreenQuery = await isVisible('mpvpausepage');
    console.log(`      pausepage visible on an unrelated "fullscreen" query: ` +
      `${pauseVisibleOnFullscreenQuery}`);

    // Actual label text: "Reuse one mpv window instead of opening a new one
    // each time" (options_mpv_singleinstance) -- "reuse" is the word to
    // search for, not the option's id/description.
    await runSearch('reuse');
    await browser.waitUntil(async () => (await isVisible('mpvsingleinstance')) === true,
        {timeout: 5000, timeoutMsg: 'the mpv single-instance row never appeared for its own query'});

    await runSearch('');
  });

  it('an exported settings file round-trips every MPV option through import', async function() {
    await openExtensionPage('/player/options/index.html');

    const mpvSettings = {
      mpvMode: true,
      mpvAllowlist: ['https://example.com/watch/', '~^https://ex\\.test/'],
      mpvPath: 'C:\\Program Files\\mpv\\mpv.exe',
      mpvFullscreen: true,
      mpvPausePage: false,
      mpvSingleInstance: false,
    };

    // Set them through the real UI controls, not by writing storage
    // directly -- this is what actually exercises the code the export
    // button reads from.
    await browser.execute((s) => {
      document.getElementById('mpvModeSectionToggle').click();
      document.getElementById('mpvAllowlist').value = s.mpvAllowlist.join('\n');
      document.getElementById('mpvAllowlist')
          .dispatchEvent(new Event('change', {bubbles: true}));
      document.getElementById('mpvpath').value = s.mpvPath;
      document.getElementById('mpvpath')
          .dispatchEvent(new Event('change', {bubbles: true}));
      document.getElementById('mpvfullscreen').click();
      document.getElementById('mpvpausepage').click(); // default true -> false
      document.getElementById('mpvsingleinstance').click(); // default true -> false
    }, mpvSettings);

    // Read back the exact object the export button would serialize, without
    // touching the filesystem: Blob/downloadURL is not observable from
    // WebDriver, but Utils.getOptionsFromStorage() is the entire content of
    // that blob (see SaveManager -- options.mjs's export handler spreads
    // exactly this).
    const exported = await browser.executeAsync((done) => {
      import('/player/utils/Utils.mjs').then((m) => {
        m.Utils.getOptionsFromStorage().then((opts) => done(opts));
      });
    });

    expect(exported.mpvMode).toBe(true);
    expect(exported.mpvAllowlist).toEqual(mpvSettings.mpvAllowlist);
    expect(exported.mpvPath).toBe(mpvSettings.mpvPath);
    expect(exported.mpvFullscreen).toBe(true);
    expect(exported.mpvPausePage).toBe(false);
    expect(exported.mpvSingleInstance).toBe(false);

    // Now the other direction: an import merges a plain object (what
    // JSON.parse of a downloaded file produces) against DefaultOptions the
    // same way the importButton handler does, and the values must survive
    // unmangled -- including into a second, freshly reloaded options page,
    // proving they were actually persisted to storage rather than just
    // living in the first page's in-memory Options object.
    await browser.execute((s) => {
      window.chrome.storage.local.set({options: JSON.stringify(s)});
    }, exported);

    await openExtensionPage('/player/options/index.html');
    await browser.waitUntil(async () => {
      return await browser.execute(() => document.getElementById('mpvpath').value !== '');
    }, {timeout: 5000, timeoutMsg: 'imported options never loaded into the fresh page'});

    const reloaded = await browser.execute(() => {
      return {
        mode: document.getElementById('mpvModeSectionToggle').checked,
        allowlist: document.getElementById('mpvAllowlist').value,
        path: document.getElementById('mpvpath').value,
        fullscreen: document.getElementById('mpvfullscreen').checked,
        pausePage: document.getElementById('mpvpausepage').checked,
        singleInstance: document.getElementById('mpvsingleinstance').checked,
      };
    });

    expect(reloaded.mode).toBe(true);
    expect(reloaded.allowlist).toBe(mpvSettings.mpvAllowlist.join('\n'));
    expect(reloaded.path).toBe(mpvSettings.mpvPath);
    expect(reloaded.fullscreen).toBe(true);
    expect(reloaded.pausePage).toBe(false);
    expect(reloaded.singleInstance).toBe(false);
  });

  it('importing a pre-MPV export (no mpv keys at all) fills in defaults instead of breaking', async function() {
    await openExtensionPage('/player/options/index.html');

    // Simulates a settings file exported before this feature existed: the
    // mpv* keys are simply absent, the way an old faststream-options.json
    // would be. mergeOptions has to fall back to DefaultOptions for every
    // one of them rather than leaving mpvAllowlist etc. undefined.
    const preMpvExport = {
      videoZoom: 150,
      autoEnableURLs: ['https://old-site.example/'],
    };

    const merged = await browser.executeAsync((oldExport, done) => {
      Promise.all([
        import('/player/utils/Utils.mjs'),
        import('/player/options/defaults/DefaultOptions.mjs'),
      ]).then(([UtilsMod, DefaultsMod]) => {
        done(UtilsMod.Utils.mergeOptions(DefaultsMod.DefaultOptions, oldExport));
      });
    }, preMpvExport);

    expect(merged.mpvMode).toBe(false);
    expect(merged.mpvAllowlist).toEqual([]);
    expect(merged.mpvPath).toBe('');
    expect(merged.mpvFullscreen).toBe(false);
    expect(merged.mpvPausePage).toBe(true);
    expect(merged.mpvSingleInstance).toBe(true);
    // And the pre-existing settings the old file did carry are not clobbered.
    expect(merged.videoZoom).toBe(150);
    expect(merged.autoEnableURLs).toEqual(['https://old-site.example/']);
  });
});
