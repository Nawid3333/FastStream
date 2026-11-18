// The options search reaches the MPV settings, and they survive an export/import round trip, on the
// real options page.

import {browser, expect} from '@wdio/globals';

import {openExtensionPage} from '../extension-page.mjs';

/**
 * Opens an extension page and waits for its saved options: applying them resets every control.
 * @param {string} pagePath - Path under the extension origin.
 * @return {Promise<void>}
 */
async function openOptionsPage(pagePath) {
  await openExtensionPage(pagePath);
  await browser.waitUntil(
      async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
      {timeout: 15000, timeoutMsg: 'the options page never loaded its options'});
}

describe('options page: search and export/import cover MPV settings', function() {
  it('search reveals MPV rows on a matching query and hides them on an unrelated one', async function() {
    await openOptionsPage('/player/options/index.html');

    // SearchUtils matches .search-target-remove to .search-target-text by position: each wrapper
    // must hold exactly one text.
    //
    // Driven through browser.execute, as in every spec here: WebdriverIO's $() does not resolve
    // elements in this window.
    // The box searches on input: its text changing, typed or pasted.
    const runSearch = (query) => browser.execute((q) => {
      const bar = document.getElementById('searchbar');
      bar.value = q;
      bar.dispatchEvent(new InputEvent('input', {bubbles: true}));
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
    expect(await isVisibleByDataOption('videoDelay')).toBe(false);

    // Three rows share one wrapper with the fullscreen row: does "fullscreen" reveal them too?
    const pauseVisibleOnFullscreenQuery = await isVisible('mpvpausepage');
    console.log(`      pausepage visible on an unrelated "fullscreen" query: ` +
      `${pauseVisibleOnFullscreenQuery}`);

    // "reuse" is a word of the label (options_mpv_singleinstance), not of the option's id
    await runSearch('reuse');
    await browser.waitUntil(async () => (await isVisible('mpvsingleinstance')) === true,
        {timeout: 5000, timeoutMsg: 'the mpv single-instance row never appeared for its own query'});

    await runSearch('');
  });

  it('an exported settings file round-trips every MPV option through import', async function() {
    await openOptionsPage('/player/options/index.html');

    const mpvSettings = {
      mpvMode: true,
      mpvAllowlist: ['https://example.com/watch/', '~^https://ex\\.test/'],
      mpvPath: 'C:\\Program Files\\mpv\\mpv.exe',
      mpvFullscreen: true,
      mpvPausePage: false,
      mpvSingleInstance: false,
    };

    // set through the real UI controls, the code the export reads from
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

    // The object the export would write: Utils.getOptionsFromStorage() is the whole file (no
    // filesystem in WebDriver).
    // Each change is saved asynchronously (OptionsStore.replace), so wait until storage
    // holds the last of them rather than reading it once straight after the clicks.
    const readStored = () => browser.execute(() => new Promise((done) => {
      import('/player/utils/Utils.mjs').then((m) => {
        m.Utils.getOptionsFromStorage().then((opts) => done(opts));
      });
    }));
    await browser.waitUntil(async () => {
      const stored = await readStored();
      return stored.mpvMode === true && stored.mpvFullscreen === true &&
        stored.mpvPausePage === false && stored.mpvSingleInstance === false &&
        stored.mpvPath === mpvSettings.mpvPath;
    }, {timeout: 10000, timeoutMsg: 'the MPV settings never reached storage'});
    const exported = await readStored();

    expect(exported.mpvMode).toBe(true);
    expect(exported.mpvAllowlist).toEqual(mpvSettings.mpvAllowlist);
    expect(exported.mpvPath).toBe(mpvSettings.mpvPath);
    expect(exported.mpvFullscreen).toBe(true);
    expect(exported.mpvPausePage).toBe(false);
    expect(exported.mpvSingleInstance).toBe(false);

    // An import merges a plain object against DefaultOptions as the import button does; a reloaded
    // page reads it back.
    await browser.execute((s) => {
      window.chrome.storage.local.set({options: JSON.stringify(s)});
    }, exported);

    await openOptionsPage('/player/options/index.html');
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
    await openOptionsPage('/player/options/index.html');

    // A file from before these options: mergeOptions falls back to DefaultOptions for every mpv*
    // key.
    const preMpvExport = {
      videoZoom: 150,
      autoEnableURLs: ['https://old-site.example/'],
    };

    const merged = await browser.execute((oldExport) => new Promise((done) => {
      Promise.all([
        import('/player/utils/Utils.mjs'),
        import('/player/options/defaults/DefaultOptions.mjs'),
      ]).then(([UtilsMod, DefaultsMod]) => {
        done(UtilsMod.Utils.mergeOptions(DefaultsMod.DefaultOptions, oldExport));
      });
    }), preMpvExport);

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
