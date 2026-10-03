// Runs an async snippet in the page the driver is in and waits for it to settle. The specs
// had three copies of this; one cleared a misspelled error slot (window.____err), and two
// reported a page-side throw by its stack alone, which in Firefox holds only the frames:
// the failure arrived with no message.

import {browser} from '@wdio/globals';

/**
 * `browser.execute` returns before a promise-returning body has finished, so the outcome
 * is parked on `window` and polled, which surfaces the page-side error instead of a bare
 * timeout. The body is stringified with fn.toString() and evaluated in the page: it must
 * be self-contained, and sees nothing from the spec's scope.
 *
 * @param {Function} fn - The async function to run in the page.
 * @param {number} [timeout] - How long to allow, in ms.
 * @return {Promise<*>} Whatever fn resolved with.
 */
export async function runInPage(fn, timeout = 60000) {
  await browser.execute((body) => {
    window.__out = undefined;
    window.__err = undefined;
    (0, eval)(`(${body})()`)
        .then((v) => {
          window.__out = v;
        })
        .catch((e) => {
          window.__err = ((e && e.message) ? e.message + '\n' : '') + ((e && e.stack) || String(e));
        });
  }, fn.toString());

  await browser.waitUntil(
      async () => browser.execute(
          () => window.__out !== undefined || window.__err !== undefined),
      {timeout, interval: 250, timeoutMsg: 'the page never settled'},
  );

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
}
