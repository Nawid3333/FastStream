// The player in a web page has the quota unlimitedStorage allows (about half the disk) from the first
// page: Firefox persisted the extension's storage by itself only when a top-level extension page opened
// it first, or after a restart, and a player framed in a site, opened first, kept 10 GiB of best-effort
// storage for the whole session (#798; storage.md, "The persisted quota needs a persist()"). The
// background asks for it at its start. This spec's session opens no extension page before the frame.

import http from 'node:http';

import {browser, expect} from '@wdio/globals';

import {EXTENSION_UUID} from '../wdio.extension.conf.mjs';

const PLAYER = `moz-extension://${EXTENSION_UUID}/player/index.html`;
const SITE_PORT = 41972;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
// Best-effort storage's group limit; the persisted quota is half the disk (a CI runner's is far larger).
const BestEffortQuota = 10 * 1024 ** 3;

let siteServer;

describe('The player in a web page', () => {
  before(async () => {
    siteServer = http.createServer((req, res) => {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(`<!doctype html><title>site</title><iframe id="player" src="${PLAYER}"></iframe>`);
    });
    await new Promise((resolve) => siteServer.listen(SITE_PORT, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => siteServer.close(resolve));
  });

  it('has persisted storage and more than best-effort quota, opened first in the session', async () => {
    await browser.url(SITE);
    const frame = await browser.$('#player');
    await frame.waitForExist({timeout: 10000});
    await browser.switchFrame(frame);
    try {
      await browser.waitUntil(() => browser.execute(() => location.href.startsWith('moz-extension:')), {timeout: 10000});
      const storage = await browser.execute(async () => {
        const estimate = await navigator.storage.estimate();
        return {persisted: await navigator.storage.persisted(), quota: estimate.quota};
      });
      expect(storage.persisted).toBe(true);
      expect(storage.quota).toBeGreaterThan(BestEffortQuota);
    } finally {
      await browser.switchFrame(null);
    }
  });
});
