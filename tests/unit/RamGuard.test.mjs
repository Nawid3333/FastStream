import fs from 'node:fs';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../chrome/player/modules/Localize.mjs', () => ({
  Localize: {getMessage: (key, subs) => subs ? `${key}(${subs.join('|')})` : key},
}));

const {ComputerMemorySizes, memorySizeLabel, optionsForComputerMemory, ramBudgetFor, ramBudgetRisky} =
  await import('../../chrome/player/options/RamGuard.mjs');

// Issue #798: an 8 GB laptop froze with the RAM for buffered video at 20 GB, and nothing on the
// options page said that was too much for it. Firefox tells extensions nothing about the
// computer's memory, so the user is asked.

const GB = 1e9;

describe('ramBudgetFor', () => {
  it('is an eighth of the memory, at most 4 GB', () => {
    expect(ComputerMemorySizes.map(ramBudgetFor)).toEqual([0.5 * GB, 1 * GB, 2 * GB, 4 * GB]);
    expect(ramBudgetFor(64)).toBe(4 * GB);
  });
});

describe('ramBudgetRisky', () => {
  it('warns of no limit, whatever the memory', () => {
    expect(ramBudgetRisky(-1, 0)).toBe(true);
    expect(ramBudgetRisky(-1, 32)).toBe(true);
  });

  it('warns above 4 GB when the memory is not given, not at the default 2 GB', () => {
    expect(ramBudgetRisky(2 * GB, 0)).toBe(false);
    expect(ramBudgetRisky(4 * GB, 0)).toBe(false);
    expect(ramBudgetRisky(4 * GB + 1, 0)).toBe(true);
    expect(ramBudgetRisky(20 * GB, 0)).toBe(true);
  });

  it('warns above a quarter of the memory given, and never lets more than 4 GB pass', () => {
    expect(ramBudgetRisky(1 * GB, 4)).toBe(false);
    expect(ramBudgetRisky(1 * GB + 1, 4)).toBe(true);
    expect(ramBudgetRisky(2 * GB, 8)).toBe(false);
    expect(ramBudgetRisky(2.5 * GB, 8)).toBe(true);
    expect(ramBudgetRisky(5 * GB, 32)).toBe(true);
  });

  it('never warns of what the answer itself sets', () => {
    for (const gigabytes of ComputerMemorySizes) expect(ramBudgetRisky(ramBudgetFor(gigabytes), gigabytes)).toBe(false);
  });
});

describe('optionsForComputerMemory', () => {
  it('sets the RAM to suit the answer, and keeps the rest of the video on disk', () => {
    expect(optionsForComputerMemory(8)).toEqual({computerMemory: 8, ramBudget: 1 * GB, bufferToDisk: true});
  });

  it('leaves the RAM as it is when the answer is taken back', () => {
    expect(optionsForComputerMemory(0)).toEqual({computerMemory: 0});
    expect(optionsForComputerMemory(NaN)).toEqual({computerMemory: 0});
  });
});

describe('memorySizeLabel', () => {
  it('names the last size as that or more', () => {
    expect(memorySizeLabel(8)).toMatch(/^8\D/);
    expect(memorySizeLabel(32)).toMatch(/^options_general_ramsize_more\(32\D/);
  });
});

describe('the options page', () => {
  const page = fs.readFileSync(new URL('../../chrome/player/options/options.mjs', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../../chrome/player/options/index.html', import.meta.url), 'utf8');

  it('warns under the RAM field when it is risky for the memory given', () => {
    expect(page).toMatch(/if \(input === ramBudget && !key && ramBudgetRisky\(value, Options\.computerMemory\)\) key = 'options_general_rambudget_high';/);
  });

  it('asks the memory right before the RAM field, and takes the answer like the welcome page', () => {
    expect(html.indexOf('id="ramsize"')).toBeGreaterThan(0);
    expect(html.indexOf('id="ramsize"')).toBeLessThan(html.indexOf('id="rambudget"'));
    expect(page).toMatch(/Object\.assign\(Options, optionsForComputerMemory\(Number\(ramSize\.value\)\)\);/);
    expect(page).toMatch(/ramSize\.value = String\(ComputerMemorySizes\.includes\(Options\.computerMemory\)/);
  });
});

describe('the welcome page', () => {
  class FakeElement {
    constructor(tag) {
      this.tag = tag;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.listeners = {};
      this.hidden = false;
      this.textContent = '';
    }

    append(child) {
      this.children.push(child);
    }

    setAttribute(name, value) {
      this.attributes[name] = value;
    }

    addEventListener(type, fn) {
      this.listeners[type] = fn;
    }

    querySelectorAll(tag) {
      return this.children.filter((child) => child.tag === tag);
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../chrome/player/options/OptionsStore.mjs');
    vi.resetModules();
  });

  it('loads its script', () => {
    const html = fs.readFileSync(new URL('../../chrome/welcome.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<script src="\.\/welcome\.mjs" charset="UTF-8" type="module"><\/script>/);
    expect(html).toMatch(/<div id="ramsizes"><\/div>\s*<p id="ramset" role="status" hidden><\/p>/);
  });

  it('saves an answer over the stored options, and says what it set', async () => {
    const elements = {ramsizes: new FakeElement('div'), ramset: new FakeElement('p')};
    vi.stubGlobal('document', {
      getElementById: (id) => elements[id],
      createElement: (tag) => new FakeElement(tag),
    });
    const stored = {ramBudget: 20 * GB, bufferToDisk: false, computerMemory: 0, mpvMode: true};
    const replace = vi.fn(async () => {});
    vi.doMock('../../chrome/player/options/OptionsStore.mjs', () => ({
      OptionsStore: {init: async () => stored, get: () => stored, replace, subscribe: () => () => {}},
    }));
    await import('../../chrome/welcome.mjs');
    await Promise.resolve();

    const buttons = elements.ramsizes.querySelectorAll('button');
    expect(buttons.map((button) => button.dataset.gb)).toEqual(['4', '8', '16', '32']);
    expect(elements.ramset.hidden).toBe(true);

    await buttons[1].listeners.click();
    expect(replace).toHaveBeenCalledWith({ramBudget: 1 * GB, bufferToDisk: true, computerMemory: 8, mpvMode: true});
    expect(buttons.map((button) => button.attributes['aria-pressed'])).toEqual(['false', 'true', 'false', 'false']);
    expect(elements.ramset.hidden).toBe(false);
    expect(elements.ramset.textContent).toMatch(/^welcome_page_ram_set\(1\D/);
  });
});
