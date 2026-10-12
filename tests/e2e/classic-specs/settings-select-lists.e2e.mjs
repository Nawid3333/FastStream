// An open drop-down in the player's settings window has to be readable in every theme
// (#458: Default Dark's were white on light grey, 1.6:1).
//
// Firefox draws a select's open list itself, in its own chrome: on a light or dark base,
// chosen from the select's colour over what is behind it in its page, with the select's
// colour painted on top and its text colour for the options. The settings window is a
// transparent page over the player, so a select that lets it show through is judged over
// white. Nothing in the page can see that list; its colours are read here from the chrome
// context, which only the classic suite reaches.
//
// On Linux (Firefox 157, WSL Ubuntu 24.04, 2026-10-12) Firefox drew every list in its own
// colours, the page's not used at all, so it is the Windows run that can catch a regression.

import {browser, expect} from '@wdio/globals';

import {inChrome} from '../classic-helpers.mjs';
import {openExtensionPage} from '../extension-page.mjs';
import {ColorThemes} from '../../../chrome/player/options/defaults/ColorThemes.mjs';

// WCAG's minimum for normal text.
const MIN_CONTRAST = 4.5;

/**
 * Parses rgb()/rgba() as Firefox serialises a computed colour.
 * @param {string} text
 * @return {{r: number, g: number, b: number, a: number}}
 */
function parseColor(text) {
  const values = text.match(/rgba?\(([^)]+)\)/)[1].split(',').map(Number);
  return {r: values[0], g: values[1], b: values[2], a: values.length > 3 ? values[3] : 1};
}

/**
 * The colour seen where `top` is painted over the opaque `base`.
 * @param {{r: number, g: number, b: number, a: number}} top
 * @param {{r: number, g: number, b: number, a: number}} base
 * @return {{r: number, g: number, b: number, a: number}}
 */
function over(top, base) {
  const mix = (t, b) => t * top.a + b * (1 - top.a);
  return {r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1};
}

/**
 * WCAG 2 contrast ratio of two opaque colours.
 * @param {{r: number, g: number, b: number}} a
 * @param {{r: number, g: number, b: number}} b
 * @return {number}
 */
function contrast(a, b) {
  const channel = (x) => {
    x /= 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Sets the colour theme through the options page, as the user does.
 * @param {string} theme - A ColorThemes value.
 * @return {Promise<void>}
 */
async function chooseTheme(theme) {
  await openExtensionPage('/player/options/index.html');
  await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
      {timeout: 20000, timeoutMsg: 'the options page never loaded'});
  await browser.execute((t) => {
    const select = document.querySelector('#colortheme select');
    select.value = t;
    select.dispatchEvent(new Event('change'));
  }, theme);
}

/**
 * Opens the aspect ratio list in the frame the driver is in and reads what Firefox draws.
 * @return {Promise<{background: string, base: string, text: string, scheme: string}>}
 */
async function openListColors() {
  const select = await browser.$('#videoAspectRatio select');
  await select.scrollIntoView();
  await select.click();
  let list;
  await browser.waitUntil(async () => {
    list = await inChrome((done) => {
      const win = Services.wm.getMostRecentWindow('navigator:browser');
      const popup = win.document.getElementById('ContentSelectDropdown')?.menupopup;
      if (!popup || popup.state !== 'open') {
        done(null);
        return;
      }
      // The author's colour goes on the arrowscrollbox, over -moz-Combobox (global-shared.css).
      const box = [...popup.shadowRoot.querySelectorAll('[part]')]
          .find((e) => e.getAttribute('part').split(' ').includes('arrowscrollbox'));
      const boxStyle = win.getComputedStyle(box);
      // An option that is not the selected one: Firefox gives that one its own colours.
      const item = [...popup.querySelectorAll('menuitem')].find((m) => m.getAttribute('_moz-menuactive') !== 'true');
      done({
        base: boxStyle.backgroundColor,
        background: boxStyle.backgroundImage,
        text: win.getComputedStyle(item).color,
        scheme: win.getComputedStyle(popup).colorScheme,
      });
    });
    return list !== null;
  }, {timeout: 10000, interval: 200, timeoutMsg: 'the aspect ratio list never opened'});
  await inChrome((done) => {
    const win = Services.wm.getMostRecentWindow('navigator:browser');
    win.document.getElementById('ContentSelectDropdown').menupopup.hidePopup();
    done(true);
  });
  return list;
}

/**
 * The contrast of an option's text on the list as drawn.
 * @param {{background: string, base: string, text: string}} list
 * @return {number}
 */
function listContrast(list) {
  const base = parseColor(list.base);
  const layer = list.background.startsWith('linear-gradient') ? parseColor(list.background) : {r: 0, g: 0, b: 0, a: 0};
  return contrast(over(layer, base), parseColor(list.text));
}

describe('The settings window\'s drop-down lists', function() {
  before(async function() {
    // A dark system and Firefox, as #458's reporter had; Default Dark's list was the same
    // grey on a light one.
    await inChrome((done) => {
      Services.prefs.setIntPref('ui.systemUsesDarkTheme', 1);
      Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', 0);
      done(true);
    });
  });

  after(async function() {
    await inChrome((done) => {
      Services.prefs.clearUserPref('ui.systemUsesDarkTheme');
      Services.prefs.clearUserPref('layout.css.prefers-color-scheme.content-override');
      done(true);
    });
  });

  for (const theme of Object.values(ColorThemes)) {
    it(`are readable in the ${theme} theme`, async function() {
      await chooseTheme(theme);
      await openExtensionPage('/player/index.html');
      await browser.waitUntil(() => browser.execute(() => !!window.fastStream?.interfaceController),
          {timeout: 30000, timeoutMsg: 'the player never started'});
      await browser.execute(() => window.fastStream.interfaceController.optionsWindow.openUI());
      await browser.switchFrame(await browser.$('.options_frame'));
      await browser.waitUntil(() => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
          {timeout: 20000, timeoutMsg: 'the player\'s settings never loaded'});
      expect(await browser.execute(() => document.body.dataset.theme)).toBe(theme);

      const list = await openListColors();
      const ratio = listContrast(list);
      console.log(`      ${theme}: ${list.scheme} list, ${list.background} over ${list.base}, ` +
          `text ${list.text}: ${ratio.toFixed(2)}:1`);
      expect(ratio).toBeGreaterThanOrEqual(MIN_CONTRAST);
      await browser.switchFrame(null);
    });
  }
});
