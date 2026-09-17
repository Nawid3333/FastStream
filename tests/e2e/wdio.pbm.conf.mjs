// Drives the installed extension inside a PRIVATE Firefox session.
//
// Why this exists separately from wdio.extension.conf.mjs
// -------------------------------------------------------
// Everything the other suites do happens in an ordinary window, and a private
// window is a materially different platform: storage APIs that are present
// there still refuse to work. That gap hid a total failure - FastStream came
// up with no <video> element at all in every private window, because
// navigator.storage.getDirectory() exists in a Firefox private window and
// throws SecurityError the moment OPFS calls it. FSBlob picked OPFS on the
// strength of the API being present, its setup rejected, and clear() passed
// that rejection up through DownloadManager.reset() into
// FastStreamClient.setSource(), whose catch abandoned player creation. The
// whole ext-specs suite was green throughout.
//
// Two prefs make the run private:
//   browser.privatebrowsing.autostart - every window is a private window, so
//     no spec has to open one and chase its handle.
//   the ExtensionPermissions grant in before() - Firefox does not let an
//     extension run in private windows until the user ticks "Run in Private
//     Windows" in about:addons, and a temporary install is no exception.
//     Granting it here is the same permission that checkbox writes, so the
//     suite tests the extension's own code instead of the permission gate.
//
// Run with: pnpm run test:pbm

import path from 'node:path';

import {config as base, EXTENSION_ID} from './wdio.extension.conf.mjs';

// ExtensionPermissions and AddonManager are chrome-privileged, and
// browser.setMozContext('chrome') is a WebDriver-classic command that the
// BiDi session the other suites use ignores outright. Specs here therefore
// run under classic: notably, an ArrayBuffer created inside a
// browser.execute() body is cross-realm there, so anything that hands a
// buffer to a library that checks `instanceof ArrayBuffer` (ORT, see
// ext-specs/vad.e2e.mjs) belongs in the BiDi suite, not this one.
const caps = JSON.parse(JSON.stringify(base.capabilities));
caps[0]['wdio:enforceWebDriverClassic'] = true;
caps[0]['moz:firefoxOptions'].prefs['browser.privatebrowsing.autostart'] = true;

const baseBefore = base.before;

export const config = {
  ...base,
  capabilities: caps,
  specs: [path.join(import.meta.dirname, 'pbm-specs/**/*.e2e.mjs')],

  before: async function(...args) {
    // Installs the add-on and sets the shared globals.
    await baseBefore.apply(this, args);

    await browser.setMozContext('chrome');
    try {
      const granted = await browser.executeAsync((extId, done) => {
        (async () => {
          try {
            const {ExtensionPermissions} = ChromeUtils.importESModule(
                'resource://gre/modules/ExtensionPermissions.sys.mjs');
            await ExtensionPermissions.add(
                extId,
                {permissions: ['internal:privateBrowsingAllowed'], origins: []});
            // The policy only picks the new permission up on a reload.
            const {AddonManager} = ChromeUtils.importESModule(
                'resource://gre/modules/AddonManager.sys.mjs');
            const addon = await AddonManager.getAddonByID(extId);
            await addon.reload();
            const policy = WebExtensionPolicy.getByID(extId);
            done({privateBrowsingAllowed: policy ? policy.privateBrowsingAllowed : null});
          } catch (e) {
            done({err: String(e)});
          }
        })();
      }, EXTENSION_ID);

      if (!granted || granted.privateBrowsingAllowed !== true) {
        throw new Error(
            'could not grant private-browsing access to the add-on: ' +
            JSON.stringify(granted) +
            ' - without it the extension is inert in every window here and ' +
            'every spec would fail for the wrong reason');
      }
    } finally {
      await browser.setMozContext('content');
    }
  },
};
