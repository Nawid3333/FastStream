// probe.ps1's driver: a headless Firefox with a throwaway profile, the idle timeout given, and the probe
// add-on, waits, and prints what the probe host logged: when the event page's port closed.
//   node run.mjs <mode> <timeoutMs> <waitMs>
// The add-on and the host's log are in the probe's work folder (probe.ps1 makes it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {remote} from 'webdriverio';

const [mode, timeoutMs, waitMs] = process.argv.slice(2);
const work = path.join(os.tmpdir(), 'faststream-idle-probe');
const xpi = path.join(work, 'idle-probe.xpi');
const logFile = path.join(work, 'probe.log');
fs.rmSync(logFile, {force: true});
process.env.PROBE_MODE = mode;

const browser = await remote({
  logLevel: 'error',
  capabilities: {
    'browserName': 'firefox',
    'wdio:enforceWebDriverClassic': true,
    // The chrome context, for Firefox's own word on the event page (backgroundState).
    'wdio:geckodriverOptions': {allowSystemAccess: true},
    'moz:firefoxOptions': {
      args: ['-headless', '-no-remote', '-new-instance'],
      prefs: {
        'browser.shell.checkDefaultBrowser': false,
        'extensions.background.idle.timeout': Number(timeoutMs),
      },
    },
  },
});
const begun = Date.now();
try {
  console.log('Firefox', browser.capabilities.browserVersion, 'mode', mode, 'idle timeout', timeoutMs, 'ms');
  await browser.installAddOn(fs.readFileSync(xpi).toString('base64'), true);
  await browser.setMozContext('chrome');
  let last = null;
  while (Date.now() - begun < Number(waitMs)) {
    const state = await browser.execute(() => WebExtensionPolicy.getByID('idle-probe@faststream.test')?.extension?.backgroundState ?? 'none');
    if (state !== last) {
      console.log(`${((Date.now() - begun) / 1000).toFixed(1).padStart(6)} s  background ${state}`);
      last = state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
} finally {
  await browser.deleteSession();
}
const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
for (const line of lines) {
  console.log(`${((line.at - begun) / 1000).toFixed(1).padStart(6)} s  ${line.event.padEnd(5)} pid ${line.pid}  after ${(line.sinceStart / 1000).toFixed(1)} s${line.messages !== undefined ? `  (${line.messages} messages from the page)` : ''}`);
}
