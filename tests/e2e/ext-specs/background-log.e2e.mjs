// The background's debug lines reach the spec's driver log (W6).
//
// A failed extension spec on CI said nothing about what the background did: its debug
// lines were off (`const Logging = false`), and nothing kept its console. Now they are on
// for a temporary install, which is how these suites install the shipped build, and the
// configs set devtools.console.stdout.content, so the console goes to Firefox's stdout
// and from there into the worker's geckodriver log (renamed per spec and attempt by
// driverLogs.mjs, uploaded by CI for a failed or retried spec).
//
// A page plays a fixture under a URL no other spec uses; the background's "Found source"
// line for it must turn up in this worker's driver log. Undo the switch or the pref and it
// never does.

import fs from 'node:fs';
import path from 'node:path';
import * as url from 'node:url';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {OPENER_URL} from '../wdio.extension.conf.mjs';

const logsDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../../logs');

/**
 * This worker's geckodriver log so far: wdio names it after the worker id until the
 * worker ends (driverLogs.mjs renames it then).
 * @return {string} Its text, or '' before it exists.
 */
function driverLog() {
  // The worker id is digits (wdio's own), and the read has no existsSync in front of
  // it: absent means '' (CodeQL js/path-injection, js/file-system-race).
  if (!/^\d+$/.test(process.env.WDIO_WORKER_ID || '')) {
    return '';
  }
  const file = path.join(logsDir, `wdio-${process.env.WDIO_WORKER_ID}-geckodriver.log`);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

describe('The background log', function() {
  it('is on for the temporary install these suites use', async function() {
    await browser.url(OPENER_URL);
    const installType = await inExtensionPage((arg, done) => {
      chrome.management.getSelf().then((self) => done(self.installType), (e) => done('error: ' + e.message));
    });
    expect(installType).toBe('development');
  });

  it('reaches the spec\'s driver log', async function() {
    const marker = `background-log-${Date.now()}`;
    await browser.url(OPENER_URL);
    await browser.execute((src) => {
      const video = document.createElement('video');
      video.muted = true;
      video.src = src;
      document.body.appendChild(video);
    }, `${OPENER_URL}fixtures/sample.mp4?${marker}`);

    let lines = [];
    try {
      await browser.waitUntil(() => {
        lines = driverLog().split('\n').filter((line) => line.includes(marker));
        return lines.some((line) => line.includes('Found source'));
      }, {timeout: 20000, interval: 250});
    } catch (e) {
      throw new Error(`no "Found source" line for ${marker} in the driver log; lines with it: ${JSON.stringify(lines)}`);
    }
  });
});
