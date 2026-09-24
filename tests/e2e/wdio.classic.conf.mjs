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

import {config as base} from './wdio.extension.conf.mjs';

const caps = structuredClone(base.capabilities);
caps[0]['wdio:enforceWebDriverClassic'] = true;

export const config = {
  ...base,
  capabilities: caps,
  specs: [path.join(import.meta.dirname, 'classic-specs/**/*.e2e.mjs')],
};
