import {browser} from '@wdio/globals';

// Answers the player's prompt (a dialog.fs-dialog with an input and OK) as a user does, in the
// player's frame the session is in: OK only once the player's document has its size and the
// button a box, checked in the same task as the click.
//
// The player in a page is an out-of-process frame, which takes its size from the page
// asynchronously; its video loads and plays meanwhile at 0x0. Firefox does nothing for a click
// on a submit button with no box (requestSubmit still submits), and a user cannot click a
// button before it is on the screen. page-fetch.e2e saved as soon as the video had data and, on
// CI (2026-11-15/16, both OSes, most runs), OK left the prompt open: the document 0 wide while
// the page showed its frame at 640x360 (#697). A check one round trip before the click is not
// enough: autoplay-next-episode's frame lost its size between the two (2026-11-16). An ext or
// classic spec answers the prompt through this (tests/unit/e2eConfirmPrompt.test.mjs).

/**
 * Fills the open prompt's input and clicks its OK once laid out; waits up to 15 s for that.
 * @param {string|null} value - The input's new value; null leaves it as it is.
 * @param {() => Promise<unknown>} [context] - What to add to a failure's message (the page's
 *   frames); it may switch the context.
 * @return {Promise<{waited: number, width: number, boxes: number}>} How long it waited for the
 *   layout, and the layout it clicked in.
 */
export async function confirmPrompt(value, context = async () => null) {
  const since = Date.now();
  /** @type {{clicked: boolean, closed?: boolean, open?: boolean, width: number, boxes: number, error?: string}} */
  let ok = {clicked: false, width: 0, boxes: 0};
  await browser.waitUntil(async () => {
    ok = await browser.execute((value) => {
      // A script error is told as itself, not as a document without a size (glm's review).
      try {
        const dialog = /** @type {?HTMLDialogElement} */ (document.querySelector('dialog.fs-dialog[open]'));
        if (!dialog) return {clicked: false, open: false, width: 0, boxes: 0};
        const field = /** @type {?HTMLInputElement} */ (dialog.querySelector('.fs-dialog-input'));
        const confirm = /** @type {?HTMLButtonElement} */ (dialog.querySelector('.fs-dialog-confirm'));
        if (!confirm) return {clicked: false, open: true, width: 0, boxes: 0, error: 'the prompt has no OK button'};
        const laidOut = {width: document.documentElement.clientWidth, boxes: confirm.getClientRects().length};
        if (!(laidOut.width > 0 && laidOut.boxes > 0)) return {clicked: false, open: true, ...laidOut};
        if (field && value !== null) field.value = value;
        confirm.click();
        return {clicked: true, closed: !dialog.open, ...laidOut};
      } catch (e) {
        return {clicked: false, width: 0, boxes: 0, error: String(e)};
      }
    }, value);
    // An error ends the wait at once: waiting would not mend it.
    return ok.clicked || !!ok.error;
  }, {timeout: 15000, interval: 100}).catch(async () => {
    const state = ok;
    throw new Error(`${state.open === false ? 'no prompt was open' : 'the player\'s document never had its size for OK'} ` +
      `within 15 s: ${JSON.stringify(state)}; ${JSON.stringify(await context())}`);
  });
  if (ok.error) throw new Error(`answering the prompt failed: ${ok.error}; ${JSON.stringify(await context())}`);
  const waited = Date.now() - since;
  if (waited > 1000) console.log(`      the player's document had no size for the prompt's OK for ${waited} ms`);
  if (!ok.closed) {
    throw new Error(`OK, on a laid-out prompt, left it open: ${JSON.stringify(ok)}; ${JSON.stringify(await context())}`);
  }
  return {waited, width: ok.width, boxes: ok.boxes};
}
