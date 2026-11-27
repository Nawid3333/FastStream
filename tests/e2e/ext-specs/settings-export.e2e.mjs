// "Export Settings To File" saves the file wherever the settings are open (#868).
//
// In the settings of a player inside a web page, Firefox partitions the settings' blob: URL by that
// site, and refuses a link click on it ("Cannot access blob URL ... with a different partition
// key"): the click did nothing. The export goes through the background's downloads API, as every
// other save does. The options tab and about:addons, which saved with the link click, must still
// save.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {openExtensionPage} from '../extension-page.mjs';
import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';

const downloadDir = path.resolve(import.meta.dirname, '../../../.e2e-downloads');
const PLAYER = `moz-extension://${EXTENSION_UUID}/player/index.html`;
const SITE_PORT = 41942;
const SITE = `http://127.0.0.1:${SITE_PORT}`;

let siteServer;

/** @return {Set<string>} */
const savedFiles = () => new Set(fs.readdirSync(downloadDir));

/**
 * @param {Set<string>} before - savedFiles() before the export.
 * @return {Promise<Object<string, *>>} The new settings file's settings.
 */
async function exportedSettings(before) {
  /** @type {string|undefined} */
  let name;
  await browser.waitUntil(() => {
    name = [...savedFiles()].find((n) => !before.has(n) && n.startsWith('faststream-options') && n.endsWith('.json'));
    return !!name && !fs.existsSync(path.join(downloadDir, name + '.part')) &&
        fs.statSync(path.join(downloadDir, name)).size > 0;
  }, {timeout: 15000, interval: 200, timeoutMsg: 'no settings file was saved'});
  return JSON.parse(fs.readFileSync(path.join(downloadDir, /** @type {string} */ (name)), 'utf8'));
}

/** @param {string[]} selectors - The frames to go into, outermost first. */
async function intoFrames(selectors) {
  await browser.switchFrame(null);
  for (const selector of selectors) {
    const frame = await browser.$(selector);
    await frame.waitForExist({timeout: 15000});
    await browser.switchFrame(frame);
  }
}

const optionsLoaded = () => browser.waitUntil(
    () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
    {timeout: 20000, timeoutMsg: 'the settings never loaded'});

describe('Export Settings To File', function() {
  before(async function() {
    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
      res.end(`<!doctype html><title>frames the player</title>
        <iframe id="player" src="${PLAYER}" style="width: 900px; height: 600px"></iframe>`);
    });
    await new Promise((resolve, reject) => {
      siteServer.on('error', reject);
      siteServer.listen(SITE_PORT, '127.0.0.1', resolve);
    });
  });

  after(async function() {
    await browser.switchFrame(null);
    await new Promise((resolve) => siteServer ? siteServer.close(resolve) : resolve());
  });

  it('saves from the settings of a player inside a web page', async function() {
    await browser.url(`${SITE}/frames-player`);
    await intoFrames(['#player']);
    await browser.waitUntil(() => browser.execute(() => !!window.fastStream?.interfaceController),
        {timeout: 30000, timeoutMsg: 'the framed player never started'});
    await browser.execute(() => window.fastStream.interfaceController.optionsWindow.openUI());
    await intoFrames(['#player', '.options_frame']);
    await optionsLoaded();
    const before = savedFiles();
    await browser.$('#export').click();
    const settings = await exportedSettings(before);
    expect(typeof settings.keybindsVersion).toBe('number');
    expect(settings.subtitlesSettings).toBeInstanceOf(Object);
    expect('mpvPath' in settings).toBe(false);
  });

  it('saves from the options tab', async function() {
    await browser.switchFrame(null);
    await openExtensionPage('/player/options/index.html');
    await optionsLoaded();
    const before = savedFiles();
    await browser.$('#export').click();
    expect(typeof (await exportedSettings(before)).keybindsVersion).toBe('number');
  });

  it('saves from about:addons', async function() {
    await openExtensionPage('/player/index.html');
    const before = savedFiles();
    // The options page inside about:addons is no tab the driver reaches: clicked from another
    // extension page (getViews), which has no user gesture - the downloads API needs none. The one
    // options page open, and no tab shows it: the one in about:addons.
    const clicked = await browser.execute(() => new Promise((done) => {
      const optionsUrl = chrome.runtime.getURL('player/options/index.html');
      const optionsViews = () => chrome.extension.getViews().filter((view) => view.location.href.startsWith(optionsUrl));
      chrome.runtime.openOptionsPage().then(async () => {
        const until = Date.now() + 15000;
        let views;
        while ((views = optionsViews()).length !== 1 || views[0].document.documentElement.dataset.optionsLoaded !== 'true') {
          if (Date.now() > until) return done(`options pages: ${views.length}, none loaded in about:addons`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        const tabs = (await chrome.tabs.query({})).filter((tab) => tab.url?.startsWith(optionsUrl));
        if (tabs.length) return done('the options page is open in a tab');
        views[0].document.getElementById('export').click();
        done('clicked');
      }, (e) => done('openOptionsPage: ' + e));
    }));
    expect(clicked).toBe('clicked');
    expect(typeof (await exportedSettings(before)).keybindsVersion).toBe('number');
  });
});
