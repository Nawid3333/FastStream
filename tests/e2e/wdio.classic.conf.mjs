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
import {shardSpecs} from './shardSpecs.mjs';
import {BUILD, config as base} from './wdio.extension.conf.mjs';

const caps = structuredClone(base.capabilities);
caps[0]['wdio:enforceWebDriverClassic'] = true;
// No menu access keys: an English Firefox's Alt+F opens File and the MPV key never fires (a German
// one has no F menu).
caps[0]['moz:firefoxOptions'].prefs['ui.key.menuAccessKey'] = 0;

export const config = {
  ...base,
  capabilities: caps,
  // All of them, or E2E_SHARD's group (shardSpecs.mjs).
  specs: shardSpecs(path.join(import.meta.dirname, 'classic-specs')),
  onWorkerEnd: recordRetriedSpecs(base.outputDir, `classic-${BUILD}`),
};
