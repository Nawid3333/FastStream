// The options page's number fields, its settings import and its search box.
//
// Empty or unreadable numbers, 0 and no limit, imports of non-settings JSON, and search on input.

import {browser, expect} from '@wdio/globals';
import {DefaultKeybinds} from '../../../chrome/player/options/defaults/DefaultKeybinds.mjs';

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
    // JSON saves NaN as null: the page's own Options must not hold it either
    expect(await setField('seekstepsize', '')).toBe('5');
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('5');
    expect(await savedOption('seekStepSize')).toBe(5);

    expect(await setField('seekstepsize', '-3')).toBe('0.1');
    expect(await savedOption('seekStepSize')).toBe(0.1);

    // a decimal comma, as French and German write it
    expect(await setField('seekstepsize', '2,5')).toBe('2.5');
    expect(await savedOption('seekStepSize')).toBe(2.5);

    expect(await setField('replacedelay', 'abc')).toBe('500');
    expect(await setField('replacedelay', '-20')).toBe('0');
    expect(await savedOption('replaceDelay')).toBe(0);
  });

  // 0 is the least that still downloads (1), empty no limit (6)
  it('reads a downloader limit of 0 as the least, empty as the most, and caps it at 6', async function() {
    expect(await setField('maxdownloaders', '0')).toBe('1');
    expect(await setField('maxdownloaders', '')).toBe('6');
    expect(await setField('maxdownloaders', '9')).toBe('6');
    expect(await setField('maxdownloaders', '3')).toBe('3');
    expect(await savedOption('maximumDownloaders')).toBe(3);
  });

  // a percent typed as 25, not 0.25
  it('takes the mini player size in percent', async function() {
    expect(await browser.execute(() => document.getElementById('minisize').value)).toBe('25');
    expect(await setField('minisize', '40')).toBe('40');
    expect(await savedOption('miniSize')).toBe(0.4);
    expect(await setField('minisize', '0')).toBe('1');
  });

  // clearing a video filter's field to type a number saves no 0 at once
  it('saves nothing for an emptied zoom field, and shows the value again when left', async function() {
    const zoom = await browser.execute(() => {
      const input = document.querySelector('[data-option="videoZoom"] input.number');
      input.value = '';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      return input.value;
    });
    expect(zoom).toBe('100%');
    await browser.pause(500);
    const saved = await browser.execute(() => JSON.parse(localStorage.getItem('options') || '{}').videoZoom);
    expect(saved === undefined || saved === 1).toBe(true);
  });
});

describe('Options page settings import', function() {
  beforeEach(openOptions);

  /**
   * Imports a settings file with this text through the page's own picker.
   * @param {string} text - The file's text.
   * @param {boolean} [alerts] - Whether the import is expected to say something: then
   *   this waits for it.
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
    const expected = await browser.execute(() => new Promise((done) => {
      import('/player/modules/Localize.mjs').then(({Localize}) => done(Localize.getMessage('options_import_invalid')));
    }));
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

  it('gives a file from before the sync key T, unless the file has T for something else', async function() {
    const savedKeys = () => browser.execute(() => JSON.parse(localStorage.getItem('options'))?.keybinds);
    const row = () => browser.execute(() =>
      document.querySelector('.keybind-container[data-keybind="SubtitleSyncTool"] .keybind-input')?.dataset.key);
    for (const [step, mute, expected] of [[11, 'KeyM', 'KeyT'], [12, 'KeyT', 'None']]) {
      const keybinds = {...DefaultKeybinds, Mute: mute};
      delete keybinds.SubtitleSyncTool;
      await importText(JSON.stringify({seekStepSize: step, keybindsVersion: 5, keybinds}), false);
      await browser.waitUntil(
          async () => (await browser.execute(() => JSON.parse(localStorage.getItem('options'))?.seekStepSize)) === step,
          {timeout: 10000, timeoutMsg: `the imported seekStepSize (${step}) was never saved`});
      const saved = await savedKeys();
      expect(saved.SubtitleSyncTool).toBe(expected);
      expect(saved.Mute).toBe(mute);
      expect(await row()).toBe(expected);
    }
    expect(await browser.execute(() => window.__alerts)).toEqual([]);
  });

  it('keeps this computer\'s mpv path, whatever the file says', async function() {
    // The mpv path is never imported: it names the program FastStream's helper starts, and it is
    // this computer's.
    const MINE = 'C:\\Tools\\mpv\\mpv.exe';
    await browser.execute((path) => localStorage.setItem('options', JSON.stringify({mpvPath: path})), MINE);
    await browser.url(optionsPagePath());
    // An import before the saved options are read saves nothing (optionChanged).
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 10000, timeoutMsg: 'the options page never loaded its options'});
    const savedPath =() => browser.execute(() => JSON.parse(localStorage.getItem('options'))?.mpvPath);
    for (const [step, file] of [[8, {mpvPath: 'D:\\Shared\\Downloads\\mpv.exe'}], [9, {}]]) {
      await importText(JSON.stringify({seekStepSize: step, ...file}), false);
      await browser.waitUntil(
          async () => (await browser.execute(() => JSON.parse(localStorage.getItem('options'))?.seekStepSize)) === step,
          {timeout: 10000, timeoutMsg: `the imported seekStepSize (${step}) was never saved`});
      expect(await savedPath()).toBe(MINE);
    }
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
    // every section hides when the search does not match it
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

// A size field saves while typing and on leaving; a bare number is megabytes; with predownload off
// it is shown as not in use.
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
   * What the hint under a limit's field says; null while it is hidden.
   * @param {string} id
   * @return {Promise<?string>}
   */
  const hint = (id) => browser.execute((id) => {
    const element = document.getElementById(id + 'hint');
    return element.hidden ? null : element.textContent;
  }, id);

  /**
   * A message as the page shows it.
   * @param {string} key
   * @return {Promise<string>}
   */
  const message = (key, subs) => browser.execute((key, subs) => new Promise((done) => {
    import('/player/modules/Localize.mjs').then(({Localize}) => done(Localize.getMessage(key, subs)));
  }), key, subs || null);

  /**
   * What the hint under the RAM field says, without its button; null while it is hidden.
   * @return {Promise<?string>}
   */
  const ramHint = () => browser.execute(() => {
    const element = document.getElementById('rambudgethint');
    return element.hidden ? null : document.getElementById('rambudgethinttext').textContent;
  });

  /**
   * A size as the page writes it ("1 GB").
   * @param {number} bytes
   * @return {Promise<string>}
   */
  const size = (bytes) => browser.execute((bytes) => new Promise((done) => {
    import('/player/utils/StringUtils.mjs').then(({StringUtils}) => done(StringUtils.formatSize(bytes)));
  }), bytes);

  /** @return {Promise<Object>} The storage mode's select, and whether the RAM rows and the RAM button show. */
  const storage = () => browser.execute(() => ({
    mode: document.getElementById('storagemode').value,
    ramRows: !document.getElementById('ramoptions').hidden,
    useButton: document.getElementById('ramrecommended').hidden ? null : document.getElementById('ramrecommended').textContent,
  }));

  /**
   * Picks an entry of a menu as a person does.
   * @param {string} id
   * @param {string} value
   */
  async function pick(id, value) {
    await (await browser.$(`#${id}`)).selectByAttribute('value', value);
  }

  /**
   * Picks a unit as a person does.
   * @param {string} id - The size field's id.
   * @param {string} unit - 'MB' or 'GB'.
   */
  async function pickUnit(id, unit) {
    await (await browser.$(`#${id}unit`)).selectByVisibleText(unit);
  }

  // Typed as text, "10 MB", "10 Mb" and "10 Mo" left the reporter unsure what the field took:
  // a number, and the unit beside it.
  it('shows each size as a number and a unit, the speed in Mbit/s', async function() {
    expect(await shown('maxsize')).toEqual(['5', 'GB']);
    expect(await shown('rambudget')).toEqual(['1', 'GB']);
    // No speed limit: an empty field that says so in words, not only "∞".
    expect(await browser.execute(() => [document.getElementById('maxspeed').value,
      document.getElementById('maxspeed').placeholder])).toEqual(['', await message('options_general_nolimit')]);
    expect(await hint('maxspeed')).toBe(null);
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
    // 1500 MB stays in MB, and reads as 1.5 GB on the next load
    await typeInto('maxsize', '1500');
    await savedAs('maxVideoSize', 1.5e9);
    expect(await shown('maxsize')).toEqual(['1500', 'MB']);
    await browser.keys(['Tab']);
    expect(await shown('maxsize')).toEqual(['1500', 'MB']);
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['1.5', 'GB']);
    // A size GB's three decimals do not hold comes back in MB: it came back as 1.234 GB.
    await pickUnit('maxsize', 'MB');
    await typeInto('maxsize', '1234.4');
    await savedAs('maxVideoSize', 1234.4e6);
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['1234.4', 'MB']);
    // Emptied, it is no limit.
    await typeInto('maxsize', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('maxVideoSize', -1);
  });

  // a bare "10" is megabytes
  it('shows a size saved as a bare number before as megabytes', async function() {
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({maxVideoSize: 10})));
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await shown('maxsize')).toEqual(['10', 'MB']);
  });

  // An old saved speed of 0 is no limit; 0 chosen now is none, and says so.
  it('shows a speed limit of 0 saved before as no limit, and one saved since as none', async function() {
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({maxSpeed: 0})));
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await browser.execute(() => document.getElementById('maxspeed').value)).toBe('');
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({maxSpeed: 0, sizesVersion: 1})));
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    expect(await browser.execute(() => document.getElementById('maxspeed').value)).toBe('0');
    expect(await hint('maxspeed')).toBe(await message('options_general_targetspeed_zero'));
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
    // emptied and left at once: no limit
    await typeInto('maxspeed', '');
    await browser.keys(['Backspace']);
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
    await savedAs('maxSpeed', -1);
  });

  // 0 is none and an empty field no limit: 0 read as no limit surprised the
  // user who typed it to turn a thing off. What each does shows under the field.
  it('takes 0 as none and an empty field as no limit, and says so under the field', async function() {
    await typeInto('maxspeed', '8');
    await savedAs('maxSpeed', 1e6);
    await typeInto('maxspeed', '0');
    await browser.keys(['Tab']);
    await savedAs('maxSpeed', 0);
    expect(await browser.execute(() => document.getElementById('maxspeed').value)).toBe('0');
    expect(await hint('maxspeed')).toBe(await message('options_general_targetspeed_zero'));
    await typeInto('maxspeed', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('maxSpeed', -1);
    expect(await hint('maxspeed')).toBe(null);

    await typeInto('maxsize', '0');
    await browser.keys(['Tab']);
    await savedAs('maxVideoSize', 0);
    expect(await shown('maxsize')).toEqual(['0', 'GB']);
    expect(await hint('maxsize')).toBe(await message('options_general_maxsize_zero'));

    // 0.0001 GB is 0 to the three decimals shown: saved as what the field says, none.
    await typeInto('maxsize', '7');
    await savedAs('maxVideoSize', 7e9);
    await typeInto('maxsize', '0.0001');
    await browser.keys(['Tab']);
    await savedAs('maxVideoSize', 0);
    expect(await shown('maxsize')).toEqual(['0', 'GB']);
    await typeInto('maxsize', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('maxVideoSize', -1);
    expect(await hint('maxsize')).toBe(await message('options_general_maxsize_none'));
  });

  // Where downloaded video is kept: three modes, where "No limit" with the disk on and 0 with it off contradicted
  // themselves. The RAM rows say what is recommended, and go where the mode uses no RAM.
  it('takes the storage modes, and only the RAM amounts each one uses', async function() {
    expect(await storage()).toEqual({mode: 'ramdisk', ramRows: true, useButton: null});
    expect(await ramHint()).toBe(await message('options_general_rambudget_unknown'));
    // 0 is "Disk only", and no limit is for "RAM only": the field keeps its amount.
    for (const text of ['0', '']) {
      await typeInto('rambudget', text);
      await browser.keys(['Backspace', 'Tab']);
      expect(await shown('rambudget')).toEqual(['1', 'GB']);
      expect(await ramHint()).toBe([await message('options_general_rambudget_refused'),
        await message('options_general_rambudget_unknown')].join(' '));
    }
    await browser.pause(600);
    expect(await browser.execute(() => JSON.parse(localStorage.getItem('options') || '{}').ramBudget)).not.toBe(0);

    await pick('storagemode', 'ramonly');
    await savedAs('bufferToDisk', false);
    await typeInto('rambudget', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('ramBudget', -1);
    expect(await ramHint()).toBe([await message('options_general_rambudget_none'),
      await message('options_general_rambudget_unknown')].join(' '));

    await pick('storagemode', 'disk');
    await savedAs('ramBudget', 0);
    await savedAs('bufferToDisk', true);
    expect((await storage()).ramRows).toBe(false);
    expect(await hint('storagemode')).toBe(await message('options_general_storage_disk_hint'));

    // Back to RAM, then disk: the recommended amount, not the 0 of disk only.
    await pick('storagemode', 'ramdisk');
    await savedAs('ramBudget', 1e9);
    expect(await storage()).toEqual({mode: 'ramdisk', ramRows: true, useButton: null});
  });

  it('recommends a RAM amount for the memory given, and puts it in at a click', async function() {
    await pick('ramsize', '8');
    await savedAs('ramBudget', 1e9);
    await savedAs('computerMemory', 8);
    const recommended = await message('options_general_rambudget_recommended',
        [await browser.execute(() => document.getElementById('ramsize').selectedOptions[0].textContent), await size(1e9)]);
    expect(await ramHint()).toBe(recommended);
    expect((await storage()).useButton).toBe(null);

    // More than a quarter of 8 GB: the warning, and the button.
    await typeInto('rambudget', '3');
    await browser.keys(['Tab']);
    await savedAs('ramBudget', 3e9);
    expect(await ramHint()).toBe([await message('options_general_rambudget_high'), recommended].join(' '));
    expect((await storage()).useButton).toBe(await message('options_general_rambudget_use', [await size(1e9)]));
    await (await browser.$('#ramrecommended')).click();
    await savedAs('ramBudget', 1e9);
    expect(await shown('rambudget')).toEqual(['1', 'GB']);
    expect((await storage()).useButton).toBe(null);
  });

  // "Ahead" takes a number: the whole video is predownload's. "Behind" an emptied field is no limit, not 0.
  it('takes seconds ahead from 0 to an hour, empty as its default, and seconds behind empty as no limit', async function() {
    for (const [id, option] of [['bufferahead', 'bufferAhead'], ['bufferbehind', 'bufferBehind']]) {
      await typeInto(id, '45');
      await browser.keys(['Tab']);
      await savedAs(option, 45);
      expect(await hint(id)).toBe(null);
      await typeInto(id, '0');
      await browser.keys(['Tab']);
      await savedAs(option, 0);
      expect(await hint(id)).toBe(await message(`options_general_${id}_zero`));
    }
    await typeInto('bufferahead', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('bufferAhead', 300);
    expect(await browser.execute(() => document.getElementById('bufferahead').value)).toBe('300');
    await typeInto('bufferahead', '99999');
    await browser.keys(['Tab']);
    await savedAs('bufferAhead', 3600);
    expect(await browser.execute(() => document.getElementById('bufferahead').value)).toBe('3600');

    await typeInto('bufferbehind', '');
    await browser.keys(['Backspace', 'Tab']);
    await savedAs('bufferBehind', -1);
    expect(await browser.execute(() => document.getElementById('bufferbehind').value)).toBe('');
    expect(await hint('bufferbehind')).toBe(await message('options_general_bufferbehind_none'));
    // No number: the value set stays.
    for (const [id, option, value] of [['bufferahead', 'bufferAhead', 3600], ['bufferbehind', 'bufferBehind', -1]]) {
      await typeInto(id, 'abc');
      await browser.keys(['Tab']);
      await savedAs(option, value);
    }
  });

  // letters, negatives or a size too big to save keep the limit set
  it('keeps the limit set when the field holds no number', async function() {
    await typeInto('maxsize', '7');
    await savedAs('maxVideoSize', 7e9);
    for (const text of ['abc', '-2', ',']) {
      await typeInto('maxsize', text);
      await browser.keys(['Tab']);
      expect(await shown('maxsize')).toEqual(['7', 'GB']);
    }
    // typed, the first digits are a size on the way; pasted at once it is no number
    await setField('maxsize', '1e308');
    await browser.pause(500);
    expect(await browser.execute(() => JSON.parse(localStorage.getItem('options')).maxVideoSize)).toBe(7e9);
  });

  it('takes the speed in Mbit/s, and any RAM budget', async function() {
    await typeInto('maxspeed', '8');
    await savedAs('maxSpeed', 1e6);
    // no least size: 100 MB stays 100
    await typeInto('rambudget', '100');
    await pickUnit('rambudget', 'MB');
    await browser.keys(['Tab']);
    await savedAs('ramBudget', 100e6);
    expect(await shown('rambudget')).toEqual(['100', 'MB']);
  });

  // A number field has no caret position: putting it back threw.
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
