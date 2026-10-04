// The installed extension again, but over WebDriver classic, for the specs
// that have to reach into the browser itself.
//
// Some behaviour can only be driven from Firefox's chrome context: clicking
// the toolbar button (there is no web API that fires action.onClicked) and
// suspending the event page the way Firefox does after its idle timeout.
// browser.setMozContext('chrome') is a classic-only command - the BiDi
// session wdio.extension.conf.mjs uses ignores it silently - so those specs
// live in classic-specs/ and run here. Same add-on, same throwaway profile,
// same harness server; only the protocol differs.
//
// Run with: pnpm run test:ext (it runs this suite after the BiDi one)

import path from 'node:path';

import {recordRetriedSpecs} from './retriedSpecs.mjs';
import {BUILD, config as base} from './wdio.extension.conf.mjs';

const caps = structuredClone(base.capabilities);
caps[0]['wdio:enforceWebDriverClassic'] = true;
// No menu access keys. The MPV key's default is Alt+F, which the menus of an English
// Firefox take for themselves: Alt+F opens File, and the extension's key never fires
// (measured 2026-10-04 with the specs' key presses: the File menu opened, the command
// did not run). The owner's Firefox is German, whose menus have no F (Datei is Alt+D),
// so Alt+F reaches FastStream there; this makes the test Firefox the same.
caps[0]['moz:firefoxOptions'].prefs['ui.key.menuAccessKey'] = 0;

export const config = {
  ...base,
  capabilities: caps,
  specs: [path.join(import.meta.dirname, 'classic-specs/**/*.e2e.mjs')],
  onWorkerEnd: recordRetriedSpecs(base.outputDir, `classic-${BUILD}`),
};
