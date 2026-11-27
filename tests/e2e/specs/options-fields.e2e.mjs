// The options page's number fields and pickers, its settings import and its search box.
//
// Empty or unreadable numbers, the download and storage pickers, imports of non-settings JSON, and search on input.

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
    expect(await shownSections('')).toHaveLength(12);
  });
});

// Downloading and storage are pickers in plain units: nothing can be typed that stops the video or freezes the
// computer, and a value saved before goes to the nearest step. Where video is kept is three radio buttons; the RAM
// row is greyed with what it is, except with "RAM only", whose limit it picks.
describe('Options page download and storage pickers', function() {
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
   * A message as the page shows it.
   * @param {string} key
   * @param {Array<string>} [subs]
   * @return {Promise<string>}
   */
  const message = (key, subs) => browser.execute((key, subs) => new Promise((done) => {
    import('/player/modules/Localize.mjs').then(({Localize}) => done(Localize.getMessage(key, subs)));
  }), key, subs || null);

  /**
   * A size as the page writes it ("1 GB").
   * @param {number} bytes
   * @return {Promise<string>}
   */
  const size = (bytes) => browser.execute((bytes) => new Promise((done) => {
    import('/player/utils/StringUtils.mjs').then(({StringUtils}) => done(StringUtils.formatSize(bytes)));
  }), bytes);

  /**
   * A picker as shown: its value, its text, whether it is greyed, and its choices.
   * @param {string} id
   * @return {Promise<{value: string, text: string, disabled: boolean, values: string[]}>}
   */
  const picker = (id) => browser.execute((id) => {
    const select = document.getElementById(id);
    return {value: select.value, text: select.selectedOptions[0]?.textContent ?? '', disabled: select.disabled,
      values: Array.from(select.options, (option) => option.value)};
  }, id);

  /**
   * Picks an entry of a menu as a person does.
   * @param {string} id
   * @param {string} value
   */
  async function pick(id, value) {
    await (await browser.$(`#${id}`)).selectByAttribute('value', value);
  }

  /** @param {string} mode */
  async function pickMode(mode) {
    await (await browser.$(`input[name="storagemode"][value="${mode}"]`)).click();
  }

  const checkedMode = () => browser.execute(() => document.querySelector('input[name="storagemode"]:checked')?.value);

  const reload = async () => {
    await browser.url(optionsPagePath());
    await browser.waitUntil(async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
        {timeout: 30000});
  };

  it('offers each setting as a picker, with "No limit" said in words and no number to type', async function() {
    expect(await picker('loadahead')).toMatchObject({value: 'whole', text: await message('options_storage_whole'),
      values: ['30', '60', '120', '300', '600', '1200', '1800', '3600', 'whole']});
    expect(await picker('maxsize')).toMatchObject({value: '5000000000', text: await size(5e9), disabled: false});
    expect((await picker('maxsize')).values.at(-1)).toBe('-1');
    expect(await picker('bufferbehind')).toMatchObject({value: '20', values: ['20', '60', '300', '1800', '-1']});
    expect(await picker('maxspeed')).toMatchObject({value: '-1', text: await message('options_general_nolimit')});
    expect(await browser.execute(() => document.querySelectorAll('[data-search-section="storage"] input[type="text"], ' +
      '[data-search-section="storage"] input[type="number"]:not(#maxdownloaders)').length)).toBe(0);
  });

  it('greys the largest size unless the whole video is loaded, and saves each pick', async function() {
    await pick('loadahead', '600');
    await savedAs('downloadAll', false);
    await savedAs('bufferAhead', 600);
    expect((await picker('maxsize')).disabled).toBe(true);
    expect(await browser.execute(() => document.getElementById('maxsizerow').classList.contains('disabled'))).toBe(true);
    await pick('loadahead', 'whole');
    await savedAs('downloadAll', true);
    await savedAs('bufferAhead', 300);
    expect((await picker('maxsize')).disabled).toBe(false);

    await pick('maxsize', '-1');
    await savedAs('maxVideoSize', -1);
    await pick('bufferbehind', '-1');
    await savedAs('bufferBehind', -1);
    await pick('maxspeed', '1250000');
    await savedAs('maxSpeed', 1250000);
    await reload();
    expect((await picker('maxspeed')).value).toBe('1250000');
    expect((await picker('bufferbehind')).text).toBe(await message('options_storage_all'));
  });

  it('shows values saved before at the nearest step: nothing that stops the video is left', async function() {
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({downloadAll: false, bufferAhead: 0,
      maxVideoSize: 3e9, bufferBehind: 0, maxSpeed: 0, sizesVersion: 1})));
    await reload();
    expect((await picker('loadahead')).value).toBe('30');
    expect((await picker('maxsize')).value).toBe('2000000000');
    expect((await picker('bufferbehind')).value).toBe('20');
    expect((await picker('maxspeed')).value).toBe('250000');
  });

  it('keeps video in RAM, then disk with the automatic amount, and lets only RAM only pick a limit', async function() {
    expect(await checkedMode()).toBe('ramdisk');
    expect(await picker('rambudget')).toMatchObject({disabled: true,
      text: await message('options_storage_ram_auto', [await size(1e9)])});
    expect(await browser.execute(() => document.getElementById('storageramdiskdesc').textContent))
        .toBe(await message('options_general_storage_ramdisk_hint', [await size(1e9)]));

    await pickMode('ramonly');
    await savedAs('bufferToDisk', false);
    await savedAs('ramBudget', 1e9);
    expect(await picker('rambudget')).toMatchObject({disabled: false, value: '1000000000',
      values: ['512000000', '1000000000', '2000000000', '4000000000']});
    await pick('rambudget', '2000000000');
    await savedAs('ramBudget', 2e9);

    await pickMode('disk');
    await savedAs('ramBudget', 0);
    await savedAs('bufferToDisk', true);
    expect(await picker('rambudget')).toMatchObject({disabled: true, text: await message('options_storage_ram_unused')});

    // Back to RAM only: the automatic amount, not the 0 of disk only.
    await pickMode('ramonly');
    await savedAs('ramBudget', 1e9);
    await pickMode('ramdisk');
    await savedAs('bufferToDisk', true);
    expect(await checkedMode()).toBe('ramdisk');
  });

  it('takes an amount set by hand before as the automatic one', async function() {
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({ramBudget: 20e9, bufferToDisk: true})));
    await reload();
    expect(await checkedMode()).toBe('ramdisk');
    expect((await picker('rambudget')).text).toBe(await message('options_storage_ram_auto', [await size(1e9)]));
    await browser.execute(() => localStorage.setItem('options', JSON.stringify({ramBudget: -1, bufferToDisk: true})));
    await reload();
    expect(await checkedMode()).toBe('ramonly');
    expect((await picker('rambudget')).value).toBe('4000000000');
  });

  it('marks a changed setting, and puts its section back with the reset button', async function() {
    const state = () => browser.execute(() => {
      const section = document.querySelector('[data-search-section="storage"]');
      return {
        changed: Array.from(section.querySelectorAll('[data-keys].changed'), (row) => row.dataset.keys),
        reset: !section.querySelector('.section-reset').hidden,
      };
    });
    expect(await state()).toEqual({changed: [], reset: false});
    await pick('bufferbehind', '-1');
    await savedAs('bufferBehind', -1);
    await pickMode('ramonly');
    await savedAs('bufferToDisk', false);
    expect(await state()).toEqual({changed: ['bufferBehind', 'ramBudget,bufferToDisk'], reset: true});
    expect(await browser.execute(() => document.querySelector('[data-keys="bufferBehind"] .label').title))
        .toBe(await message('options_changed'));

    await (await browser.$('[data-search-section="storage"] .section-reset')).click();
    await savedAs('bufferBehind', 20);
    await savedAs('bufferToDisk', true);
    expect(await state()).toEqual({changed: [], reset: false});
    expect(await checkedMode()).toBe('ramdisk');
  });

  // A number field has no caret position: putting it back threw.
  it('saves a number field its handler corrects, without an error', async function() {
    await browser.execute(() => {
      window.pageErrors = [];
      window.addEventListener('error', (e) => window.pageErrors.push(String(e.message)));
    });
    await (await browser.$('#seekstepsize')).click();
    await browser.keys(['Control', 'a', 'Control']);
    await browser.keys(['-', '3']);
    await savedAs('seekStepSize', 0.1);
    // The typed text stays while the field is being typed in; leaving it shows the value saved.
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('-3');
    await browser.keys(['Tab']);
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('0.1');
    expect(await browser.execute(() => window.pageErrors)).toEqual([]);
  });
});
