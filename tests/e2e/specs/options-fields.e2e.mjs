// The options page's number fields, its settings import and its search box.
//
// - An emptied or unreadable "Seek step size" or "Replace delay" was saved as NaN, and a
//   negative one as it was; the fields next to them already clamped.
// - "Max downloaders" 0 meant "never add one" to the downloader, and "no limit" to the
//   add-downloader key.
// - An imported file holding valid JSON that is no settings object (null) threw, and the
//   import failed without a word; invalid JSON alerted in English.
// - The search box searched on keydown and keyup, and not at all for pasted text.

import {browser, expect} from '@wdio/globals';

const optionsPagePath = () => '/player/options/index.html?t=' + Date.now();

async function openOptions() {
  await browser.url(optionsPagePath());
  await browser.execute(() => localStorage.removeItem('options'));
  await browser.url(optionsPagePath());
  await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll('.keybind-container').length > 0),
      {timeout: 30000, timeoutMsg: 'the options page never rendered'});
}

/**
 * Types a value into a field the way the page hears it: a change event.
 * @param {string} id - The field's id.
 * @param {string} value - What the field holds.
 * @return {Promise<string>} What the field shows afterwards.
 */
const setField = (id, value) => browser.execute((id, value) => {
  const input = document.getElementById(id);
  input.value = value;
  input.dispatchEvent(new Event('change', {bubbles: true}));
  return input.value;
}, id, value);

const savedOption = (key) => browser.waitUntil(
    async () => {
      const saved = await browser.execute(() => JSON.parse(localStorage.getItem('options')));
      return saved && Object.hasOwn(saved, key) ? {value: saved[key]} : false;
    },
    {timeout: 10000, timeoutMsg: `the ${key} option was never saved`}).then((r) => r.value);

describe('Options page number fields', function() {
  beforeEach(openOptions);

  it('keeps the seek step and the replace delay numbers within their limits', async function() {
    // JSON saves NaN as null, so only the page's own Options held it: the players it sent
    // them to seeked by NaN until the next load.
    expect(await setField('seekstepsize', '')).toBe('5');
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('5');
    expect(await savedOption('seekStepSize')).toBe(5);

    expect(await setField('seekstepsize', '-3')).toBe('0.1');
    expect(await savedOption('seekStepSize')).toBe(0.1);

    expect(await setField('replacedelay', 'abc')).toBe('500');
    expect(await setField('replacedelay', '-20')).toBe('0');
    expect(await savedOption('replaceDelay')).toBe(0);
  });

  it('reads a downloader limit of 0 as the default, and caps it at 6', async function() {
    expect(await setField('maxdownloaders', '0')).toBe('6');
    expect(await setField('maxdownloaders', '9')).toBe('6');
    expect(await setField('maxdownloaders', '3')).toBe('3');
    expect(await savedOption('maximumDownloaders')).toBe(3);
  });
});

describe('Options page settings import', function() {
  beforeEach(openOptions);

  /**
   * Imports a file of the given text through the Import button, with the file dialog
   * replaced by the test.
   * @param {string} text - The file's contents.
   * @return {Promise<string[]>} What the page alerted.
   */
  /**
   * Imports a settings file with this text through the page's own picker.
   * @param {string} text - The file's text.
   * @param {boolean} [alerts] - Whether the import is expected to say something: then
   *   this waits for it. (The page reads the file before it answers: a fixed 300 ms pause
   *   came up short on a loaded runner.) An import that says nothing is waited for by its
   *   saved option instead.
   * @return {Promise<string[]>} What the page alerted.
   */
  const importText = async (text, alerts = true) => {
    await browser.execute(() => {
      window.__alerts = [];
      window.alert = (message) => window.__alerts.push(String(message));
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function() {
        if (this.type === 'file') {
          window.__picker = this;
          return;
        }
        return click.call(this);
      };
      document.getElementById('import').click();
    });
    await browser.execute((text) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], 'settings.json', {type: 'application/json'}));
      window.__picker.files = transfer.files;
      window.__picker.dispatchEvent(new Event('change'));
    }, text);
    if (alerts) {
      await browser.waitUntil(async () => browser.execute(() => window.__alerts.length > 0),
          {timeout: 10000, timeoutMsg: 'the import never said anything'});
    }
    return browser.execute(() => window.__alerts);
  };

  it('says so when the file is no settings file', async function() {
    const expected = await browser.executeAsync((done) => {
      import('/player/modules/Localize.mjs').then(({Localize}) => done(Localize.getMessage('options_import_invalid')));
    });
    expect(expected).not.toBe('options_import_invalid');
    expect(await importText('null')).toEqual([expected]);
    expect(await importText('[1, 2]')).toEqual([expected]);
    expect(await importText('{not json')).toEqual([expected]);
  });

  it('still imports a settings file', async function() {
    await importText(JSON.stringify({seekStepSize: 7}), false);
    // The value itself: the page may have saved its defaults before the import.
    await browser.waitUntil(
        async () => (await browser.execute(() => JSON.parse(localStorage.getItem('options'))?.seekStepSize)) === 7,
        {timeout: 10000, timeoutMsg: 'the imported seekStepSize (7) was never saved'});
    expect(await browser.execute(() => window.__alerts)).toEqual([]);
  });
});

describe('Options page search box', function() {
  beforeEach(openOptions);

  it('searches for pasted text', async function() {
    // A paste changes the text with no key pressed: the page never searched for it.
    const state = await browser.execute(() => {
      const bar = document.getElementById('searchbar');
      bar.value = 'seek step';
      bar.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertFromPaste'}));
      const texts = Array.from(document.querySelectorAll('.search-target-text'));
      return {
        filtering: document.body.classList.contains('search-active'),
        shown: texts.filter((el) => el.offsetParent !== null).length,
        all: texts.length,
      };
    });
    console.log('      after pasting "seek step":', JSON.stringify(state));
    expect(state.filtering).toBe(true);
    expect(state.shown).toBeGreaterThan(0);
    expect(state.shown).toBeLessThan(state.all);
  });
});
