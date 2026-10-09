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

  it('hides every section the search does not match, and finds a section by its heading', async function() {
    // Five sections were never hidden: "zoom" showed the zoom row, then the MPV, URL
    // list, pattern, import/export and help sections in full (#278).
    const shownSections = (query) => browser.execute((query) => {
      const bar = document.getElementById('searchbar');
      bar.value = query;
      bar.dispatchEvent(new InputEvent('input', {bubbles: true}));
      return Array.from(document.querySelectorAll('section.options-section'))
          .filter((section) => section.getClientRects().length > 0)
          .map((section) => section.dataset.searchSection);
    }, query);
    const zoom = await shownSections('zoom');
    console.log('      sections shown for "zoom":', JSON.stringify(zoom));
    // The keybinds section rightly stays: its Zoom In Video, Zoom Out Video and Zoom Reset
    // rows match.
    expect(zoom).toContain('video');
    expect(zoom).toContain('keybinds');
    for (const section of ['autourl', 'patterns', 'mpv', 'export', 'help']) {
      expect(zoom).not.toContain(section);
    }
    const help = await browser.execute(() => document.querySelector('[data-search-section="help"] h1').textContent);
    expect(await shownSections(help)).toContain('help');
    expect(await shownSections('')).toHaveLength(8);
  });
});

// Issue #378: "the maximum size of the preloaded video stays at 5 GB". A text field saved only on
// its change event, which comes when the field is left: a size typed and the settings closed
// with the cursor in the field was lost, and the old value came back. A bare "10" was 10 bytes.
// And with predownload off the size does not apply at all ("Buffer ahead" does), yet the field
// looked as if it did.
describe('Options page size fields, typed by hand', function() {
  beforeEach(async function() {
    await openOptions();
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000, timeoutMsg: 'the saved options never loaded'});
  });

  /**
   * Waits until an option is saved with a value.
   * @param {string} key
   * @param {*} value
   * @return {Promise<void>}
   */
  const savedAs = (key, value) => browser.waitUntil(async () => browser.execute((key) =>
    JSON.parse(localStorage.getItem('options') || 'null')?.[key], key).then((saved) => saved === value),
  {timeout: 10000, timeoutMsg: `${key} was never saved as ${value}`});

  /**
   * Clicks into a field, selects what it holds and types over it, as a person does.
   * @param {string} id
   * @param {string} text
   */
  async function typeInto(id, text) {
    await (await browser.$(`#${id}`)).click();
    await browser.keys(['Control', 'a', 'Control']);
    await browser.keys(text.split(''));
  }

  /**
   * A size field's number and unit as shown.
   * @param {string} id
   * @return {Promise<[string, string]>}
   */
  const shown = (id) => browser.execute((id) =>
    [document.getElementById(id).value, document.getElementById(id + 'unit').selectedOptions[0].textContent], id);

  /**
   * Picks a unit as a person does.
   * @param {string} id - The size field's id.
   * @param {string} unit - 'MB' or 'GB'.
   */
  async function pickUnit(id, unit) {
    await (await browser.$(`#${id}unit`)).selectByVisibleText(unit);
  }

  // Typed as text, "10 MB", "10 Mb" and "10 Mo" left the reporter unsure what the field took
  // (#378): a number, and the unit beside it.
  it('shows each size as a number and a unit, the speed in Mbit/s', async function() {
    expect(await shown('maxsize')).toEqual(['5', 'GB']);
    expect(await shown('rambudget')).toEqual(['2', 'GB']);
    // No speed limit: an empty field showing ∞.
    expect(await browser.execute(() => [document.getElementById('maxspeed').value,
      document.getElementById('maxspeed').placeholder])).toEqual(['', '∞']);
  });

  it('saves a size while it is typed, without waiting for the field to be left', async function() {
    await pickUnit('maxsize', 'MB');
    await typeInto('maxsize', '10');
    await savedAs('maxVideoSize', 1e7);
    // The field keeps what is being typed, and the cursor stays in it.
    expect(await browser.execute(() => [document.getElementById('maxsize').value, document.activeElement.id]))
        .toEqual(['10', 'maxsize']);
    // The page reloaded with the cursor still in the field: the size stays.
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['10', 'MB']);
  });

  it('takes the unit from its picker, and keeps the number when the unit changes', async function() {
    await typeInto('maxsize', '2');
    await savedAs('maxVideoSize', 2e9);
    await pickUnit('maxsize', 'MB');
    await savedAs('maxVideoSize', 2e6);
    expect(await shown('maxsize')).toEqual(['2', 'MB']);
    // 1500 MB stays in MB, also once the field is left (the unit is the user's), and reads
    // as 1.5 GB when the page loads again.
    await typeInto('maxsize', '1500');
    await savedAs('maxVideoSize', 1.5e9);
    expect(await shown('maxsize')).toEqual(['1500', 'MB']);
    await browser.keys(['Tab']);
    expect(await shown('maxsize')).toEqual(['1500', 'MB']);
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['1.5', 'GB']);
    // Emptied, it is no limit.
    await typeInto('maxsize', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('maxVideoSize', -1);
  });

  // Before #378 a bare "10" was saved as 10 bytes: such a size is megabytes now.
  it('shows a size saved as a bare number before as megabytes', async function() {
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({maxVideoSize: 10})));
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['10', 'MB']);
  });

  it('shows a speed limit of 0 saved before as no limit, as it now is', async function() {
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({maxSpeed: 0})));
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await browser.execute(() => document.getElementById('maxspeed').value)).toBe('');
  });

  it('keeps the unit that is picked, also for an empty size', async function() {
    await typeInto('maxsize', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('maxVideoSize', -1);
    await pickUnit('maxsize', 'MB');
    expect(await shown('maxsize')).toEqual(['', 'MB']);
    await typeInto('maxsize', '3000');
    await pickUnit('maxsize', 'GB');
    await savedAs('maxVideoSize', 3e12);
    expect(await shown('maxsize')).toEqual(['3000', 'GB']);
  });

  it('takes a decimal comma, and keeps a size below 1 MB that was chosen', async function() {
    await typeInto('maxsize', '1,5');
    await savedAs('maxVideoSize', 1.5e9);
    await pickUnit('maxsize', 'MB');
    await typeInto('maxsize', '0.5');
    await savedAs('maxVideoSize', 5e5);
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['0.5', 'MB']);
  });

  it('saves a field emptied when the page is left', async function() {
    await typeInto('maxspeed', '8');
    await savedAs('maxSpeed', 1e6);
    // Emptied, and the page left at once: no limit, not the old 8 Mbit/s.
    await typeInto('maxspeed', '');
    await browser.keys(['Backspace']);
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    await savedAs('maxSpeed', -1);
  });

  // A limit of 0 Mbit/s held back reading ahead whenever anything downloaded, and a size of
  // 0 was read as no limit while the field said 0 (review, 2026-10-09).
  it('reads 0, as an empty field, as no limit, and a number too big to save as none', async function() {
    await typeInto('maxspeed', '8');
    await savedAs('maxSpeed', 1e6);
    await typeInto('maxspeed', '0');
    await browser.keys(['Tab']);
    await savedAs('maxSpeed', -1);
    expect(await browser.execute(() => document.getElementById('maxspeed').value)).toBe('');

    await typeInto('maxsize', '7');
    await savedAs('maxVideoSize', 7e9);
    await typeInto('maxsize', '0');
    await browser.keys(['Tab']);
    await savedAs('maxVideoSize', -1);
    expect(await shown('maxsize')).toEqual(['', 'GB']);

    // 1e308 GB is no number JSON keeps: it was saved as null.
    await typeInto('maxsize', '7');
    await savedAs('maxVideoSize', 7e9);
    await typeInto('maxsize', '1e308');
    await browser.keys(['Tab']);
    await savedAs('maxVideoSize', -1);

    // 0.0001 GB is 0 to the three decimals shown: it was saved as 100 kB and shown as 0.
    await typeInto('maxsize', '7');
    await savedAs('maxVideoSize', 7e9);
    await typeInto('maxsize', '0.0001');
    await browser.keys(['Tab']);
    await savedAs('maxVideoSize', -1);
    expect(await shown('maxsize')).toEqual(['', 'GB']);
  });

  it('takes the speed in Mbit/s, and the RAM budget at its least', async function() {
    await typeInto('maxspeed', '8');
    await savedAs('maxSpeed', 1e6);
    await typeInto('rambudget', '100');
    await pickUnit('rambudget', 'MB');
    await browser.keys(['Tab']);
    await savedAs('ramBudget', 256e6);
    expect(await shown('rambudget')).toEqual(['256', 'MB']);
  });

  // A number field has no caret position: putting it back threw (review, 2026-10-09).
  it('saves a number field its handler corrects, without an error', async function() {
    await browser.execute(() => {
      window.pageErrors = [];
      window.addEventListener('error', (e) => window.pageErrors.push(String(e.message)));
    });
    await typeInto('seekstepsize', '-3');
    await savedAs('seekStepSize', 0.1);
    // The typed text stays while the field is being typed in; leaving it shows the value saved.
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('-3');
    await browser.keys(['Tab']);
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('0.1');
    expect(await browser.execute(() => window.pageErrors)).toEqual([]);
  });

  it('greys the size out while predownload is off, where buffer ahead decides', async function() {
    const disabled = () => browser.execute(() =>
      [document.getElementById('maxsize').disabled, document.getElementById('maxsizeunit').disabled]);
    expect(await disabled()).toEqual([false, false]);
    await (await browser.$('#downloadall')).click();
    expect(await disabled()).toEqual([true, true]);
    await typeInto('bufferahead', '10');
    await savedAs('bufferAhead', 10);
    await (await browser.$('#downloadall')).click();
    expect(await disabled()).toEqual([false, false]);
  });
});
