import {describe, expect, it, vi} from 'vitest';
// Its text, which vitest includes when it loads this file (?raw): read at run time, the code
// run below was "user-provided" to CodeQL (js/code-injection).
import DASH_SOURCE from '../../node_modules/dashjs/dist/modern/esm/dash.all.debug.js?raw';

// dash.js's default time server (time.akamai.com) is removed: a live stream's clock comes from the
// manifest's Date header or the computer's, as the privacy policy says.
//
// This runs the installed dash.js's MediaPlayer, whose timing sources DashPlayer.setSource
// leaves.

vi.mock('../../chrome/player/modules/dash.mjs', () => ({MediaPlayer: () => ({create: () => ({})})}));
const {default: DashPlayer} = await import('../../chrome/player/players/dash/DashPlayer.mjs');

/**
 * The installed dash.js's internal modules, without its entry point (which needs a page).
 * @return {(id: string) => any} - Its __webpack_require__.
 */
function loadDashModules() {
  const end = DASH_SOURCE.indexOf('var __webpack_exports__ = {};');
  expect(end).toBeGreaterThan(-1);
  // A MediaSource is all dash.js's initialize asks the page for, when it is given no video;
  // the TTML renderer it loads reads a style of the page as it loads.
  const window = {performance, MediaSource: class {}, getComputedStyle: () => ({})};
  return new Function('window', 'document', DASH_SOURCE.slice(0, end) + '\nreturn __webpack_require__;')(
      window, {documentElement: {}});
}

const require = loadDashModules();
const factory = (/** @type {string} */ id) => require(`./src/${id}.js`).default;

/**
 * A real dash.js MediaPlayer, and the model that keeps the timing sources it adds to a
 * manifest's own (StreamController: a live manifest's sources, then these).
 * @return {{dash: Object, timingSources: () => Array<{schemeIdUri: string, value: string}>}}
 */
function realDash() {
  const context = {};
  const dash = factory('streaming/MediaPlayer')(context).create();
  dash.updateSettings({debug: {logLevel: 0}});
  const model = factory('streaming/models/CustomParametersModel')(context).getInstance();
  return {dash, timingSources: () => model.getUTCTimingSources()};
}

describe('DashPlayer, a live stream\'s clock', () => {
  it('leaves dash.js no time server of its own', async () => {
    const {dash, timingSources} = realDash();
    // No video and no address: dash.js's initialize sets itself up, and loads nothing.
    await DashPlayer.prototype.setSource.call({dash}, {url: undefined});
    expect(timingSources()).toEqual([]);
  });

  it('removes the time server dash.js would ask (what this guards against)', () => {
    const {dash, timingSources} = realDash();
    dash.initialize(undefined, undefined, false);
    expect(timingSources().map((source) => source.value)).toEqual(['https://time.akamai.com/?iso&ms']);
  });
});
