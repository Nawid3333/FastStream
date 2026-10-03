import {afterEach, describe, expect, it, vi} from 'vitest';
// Its text, which vitest includes when it loads this file (?raw): read at run time, the code
// run below was "user-provided" to CodeQL (js/code-injection).
import DASH_SOURCE from '../../node_modules/dashjs/dist/modern/esm/dash.all.debug.js?raw';

// patches/dashjs@5.2.1.patch makes dash.js update a representation (load its segment
// index) only when it is needed: Representation.setUpdateCallback() arms it, and
// checkForUpdate() runs the callback once. A callback re-armed while a check was on its way
// (the patch's own "reset if error occurs" after a failed index request, or a live manifest
// refresh) left the finished check's promise behind, and every later check returned it
// without running the callback: that representation never got its segments, and playback of
// it stalled with nothing said. (FastStream #293.)
//
// This runs the Representation class of the dash.js that pnpm installed with the patch,
// which is the file tools/sync-vendor.mjs vendors as chrome/player/modules/dash.mjs.

/**
 * The installed dash.js's Representation class.
 * @return {Function}
 */
function loadRepresentation() {
  const source = DASH_SOURCE;
  const start = source.indexOf('class Representation {');
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = start;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  return new Function('_constants_DashConstants_js__WEBPACK_IMPORTED_MODULE_0__', source.slice(start, end) + '\nreturn Representation;')({default: {}});
}

/**
 * Lets promise chains run.
 * @return {Promise<void>}
 */
async function settle() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dash.js Representation.checkForUpdate (patched)', () => {
  const Representation = loadRepresentation();

  it('runs the callback again after one that failed and re-armed itself', async () => {
    // RepresentationController._updateRepresentation, on an index request that failed:
    // it calls setUpdateCallback(_updateRepresentation) again, then resolves.
    const rep = new Representation();
    let calls = 0;
    const update = vi.fn(async (r) => {
      calls++;
      if (calls === 1) r.setUpdateCallback(update);
    });
    rep.setUpdateCallback(update);

    await rep.checkForUpdate();
    await rep.checkForUpdate();

    expect(update).toHaveBeenCalledTimes(2);
    expect(rep.updated).toBe(true);
  });

  it('runs the new callback when it was armed while a check was on its way', async () => {
    // A live manifest refresh (updateData) arms every representation again.
    const rep = new Representation();
    let finishFirst;
    const first = vi.fn(() => new Promise((resolve) => finishFirst = resolve));
    const second = vi.fn(async () => {});
    rep.setUpdateCallback(first);
    const checking = rep.checkForUpdate();
    rep.setUpdateCallback(second);
    finishFirst();
    await checking;

    await rep.checkForUpdate();

    expect(second).toHaveBeenCalledTimes(1);
    expect(rep.updated).toBe(true);
  });

  it('tries again after a callback that threw, rather than counting it as updated', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const rep = new Representation();
    const update = vi.fn().mockRejectedValueOnce(new Error('index failed')).mockResolvedValue(undefined);
    rep.setUpdateCallback(update);

    await rep.checkForUpdate();
    expect(rep.updated).toBeFalsy();
    await rep.checkForUpdate();

    expect(update).toHaveBeenCalledTimes(2);
    expect(rep.updated).toBe(true);
  });

  it('still runs the callback once for checks made together', async () => {
    const rep = new Representation();
    const update = vi.fn(async () => {});
    rep.setUpdateCallback(update);
    await Promise.all([rep.checkForUpdate(), rep.checkForUpdate(), rep.checkForUpdate()]);
    await settle();
    await rep.checkForUpdate();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
