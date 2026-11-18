// Drives the installed extension inside a private Firefox session, where storage APIs present still
// refuse to work.
// browser.privatebrowsing.autostart makes every window private; before() grants "Run in Private
// Windows".
// Run with: pnpm run test:pbm

import path from 'node:path';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {guardSetup} from './setupGuard.mjs';
import {BUILD, config as base, EXTENSION_ID} from './wdio.extension.conf.mjs';

// Classic WebDriver (setMozContext('chrome') is classic only): an ArrayBuffer from
// browser.execute() is cross-realm here.
const caps = JSON.parse(JSON.stringify(base.capabilities));
caps[0]['wdio:enforceWebDriverClassic'] = true;
caps[0]['moz:firefoxOptions'].prefs['browser.privatebrowsing.autostart'] = true;

const baseBefore = base.before;

export const config = {
  ...base,
  capabilities: caps,
  specs: [path.join(import.meta.dirname, 'pbm-specs/**/*.e2e.mjs')],
  onWorkerEnd: recordRetriedSpecs(base.outputDir, `pbm-${BUILD}`),

  // A failure here fails every test of the spec file (setupGuard.mjs): an extension that may
  // not run in private windows opens no player, which a spec could take for its result.
  before: async function(...args) {
    await guardSetup(() => grantPrivateBrowsing(this, args));
  },
};

/**
 * Installs the add-on (the extension config's before hook), and lets it run in private
 * windows.
 * @param {Object} hook
 * @param {Array} args
 * @return {Promise<void>}
 */
async function grantPrivateBrowsing(hook, args) {
  // Installs the add-on and sets the shared globals.
  await baseBefore.apply(hook, args);

  await browser.setMozContext('chrome');
  try {
    const granted = await browser.execute((extId) => new Promise((done) => {
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
    }), EXTENSION_ID);

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
}
