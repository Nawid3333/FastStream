// The options page's "Export to cloud" and "Import from cloud" (CloudSettings.mjs) in a real
// Firefox. storage.sync works without a Mozilla account: it only stays on this computer. Also
// runs the quota rules the unit tests' stand-in keeps (tests/unit/helpers/fakeStorageSync.mjs)
// against Firefox's own storage.sync.

import {browser, expect} from '@wdio/globals';

import {openExtensionPage} from '../extension-page.mjs';
import {QUOTA_MESSAGE, QUOTA_STEPS} from '../../unit/helpers/fakeStorageSync.mjs';

async function openOptionsPage() {
  await openExtensionPage('/player/options/index.html');
  await browser.waitUntil(
      async () => browser.execute(() => document.documentElement.dataset.optionsLoaded === 'true'),
      {timeout: 15000, timeoutMsg: 'the options page never loaded its options'});
}

/** @return {Promise<Object<string, *>>} All of storage.sync. */
const syncItems = () => browser.execute(() => chrome.storage.sync.get(null));

/**
 * @param {string} key
 * @param {string[]} [subs]
 * @return {Promise<string>} The message in the browser's language.
 */
const message = (key, subs) => browser.execute((key, subs) => chrome.i18n.getMessage(key, subs), key, subs);

const text = (id) => browser.execute((id) => document.getElementById(id).textContent, id);

const savedSeekStep = () => browser.execute(() => import('/player/utils/Utils.mjs')
    .then(({Utils}) => Utils.getOptionsFromStorage()).then((options) => options.seekStepSize));

/**
 * Types a seek step the way the page hears it, and waits until it is saved.
 * @param {number} seconds
 */
async function setSeekStep(seconds) {
  await browser.execute((value) => {
    const input = document.getElementById('seekstepsize');
    input.value = value;
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }, String(seconds));
  await browser.waitUntil(async () => await savedSeekStep() === seconds,
      {timeout: 10000, timeoutMsg: `the seek step ${seconds} was never saved`});
}

/**
 * Clicks a cloud button and waits until its work is done.
 * @param {string} id
 * @return {Promise<{result: string, question: ?string}>} The result line, and the question
 *     shown (null for none).
 */
async function clickCloud(id) {
  await browser.execute((id) => {
    document.getElementById('cloudresult').textContent = '';
    document.getElementById(id).click();
  }, id);
  await browser.waitUntil(async () => browser.execute(() => !document.getElementById('cloudexport').disabled &&
    !document.getElementById('cloudimport').disabled), {timeout: 10000, timeoutMsg: `${id} never finished`});
  return browser.execute(() => ({
    result: document.getElementById('cloudresult').textContent,
    question: document.getElementById('cloudquestion').hidden ? null : document.getElementById('cloudquestiontext').textContent,
  }));
}

/**
 * Asks to import, and answers the question on the page.
 * @param {'cloudreplace'|'cloudcancel'} answer
 * @return {Promise<{asked: ?string, focused: string, result: string, open: boolean}>} The
 *     question, what had the focus while it was shown, and the page after the answer.
 */
async function importAnswering(answer) {
  const {question: asked} = await clickCloud('cloudimport');
  const focused = await browser.execute(() => document.activeElement?.id ?? '');
  await browser.execute((id) => document.getElementById(id).click(), answer);
  return {asked, focused, ...await browser.execute(() => ({
    result: document.getElementById('cloudresult').textContent,
    open: !document.getElementById('cloudquestion').hidden,
  }))};
}

describe('the options page\'s cloud copy', function() {
  it('keeps the quota rules the unit tests\' stand-in keeps', async function() {
    await openOptionsPage();
    for (const [i, step] of QUOTA_STEPS.entries()) {
      if (step.clear) {
        await browser.execute(() => chrome.storage.sync.clear());
        continue;
      }
      const {error, keys} = await browser.execute((items) => chrome.storage.sync.set(items).then(() => null, (e) => e.message)
          .then(async (error) => ({error, keys: Object.keys(await chrome.storage.sync.get(null)).sort()})), step.set);
      expect({step: i, error}).toEqual({step: i, error: step.quota ? QUOTA_MESSAGE : null});
      if (step.keys) expect({step: i, keys}).toEqual({step: i, keys: step.keys});
    }
  });

  it('exports to storage.sync, and imports it back after asking', async function() {
    await openOptionsPage();
    await browser.execute(() => chrome.storage.sync.clear());
    await browser.waitUntil(async () => await text('cloudstatus') === await message('options_cloud_status_none'),
        {timeout: 10000, timeoutMsg: 'the status never said there is no cloud copy'});
    expect(await browser.execute(() => document.getElementById('cloudsettings').hidden)).toBe(false);
    // No copy: said so, nothing asked.
    expect(await clickCloud('cloudimport')).toEqual({result: await message('options_cloud_none'), question: null});

    await setSeekStep(7);
    expect(await clickCloud('cloudexport')).toEqual({result: await message('options_cloud_export_done'), question: null});

    const items = await syncItems();
    const meta = items.fsCloudMeta;
    const os = await browser.execute(() => chrome.runtime.getPlatformInfo().then((info) => info.os));
    expect(meta).toMatchObject({v: 1, os});
    expect(Math.abs(Date.now() - meta.savedAt)).toBeLessThan(60000);
    expect(Object.keys(items).sort()).toEqual(['fsCloudMeta', ...Array.from({length: meta.chunks}, (_, i) => 'fsCloud' + i)].sort());
    const copy = Array.from({length: meta.chunks}, (_, i) => items['fsCloud' + i]).join('');
    expect(copy.length).toBe(meta.length);
    const hash = await browser.execute((copy) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(copy))
        .then((digest) => Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')), copy);
    expect(hash).toBe(meta.sha256);
    const settings = JSON.parse(copy);
    expect(settings.seekStepSize).toBe(7);
    expect(settings).not.toHaveProperty('mpvPath');
    expect(settings).toHaveProperty('subtitlesSettings');
    expect(settings).toHaveProperty('toolSettings');
    const osName = {win: 'Windows', mac: 'macOS', linux: 'Linux'}[os] ?? os;
    const status = await text('cloudstatus');
    expect(status).not.toBe(await message('options_cloud_status_none'));
    expect(status).toContain(`(${osName})`);

    await setSeekStep(3);
    const asked = expect.stringContaining(`(${osName})?`);
    // Cancel: nothing changes.
    expect(await importAnswering('cloudcancel')).toEqual({asked, focused: 'cloudreplace', result: '', open: false});
    expect(await savedSeekStep()).toBe(3);

    expect(await importAnswering('cloudreplace')).toEqual({
      asked, focused: 'cloudreplace', result: await message('options_cloud_import_done'), open: false,
    });
    await browser.waitUntil(async () => await savedSeekStep() === 7,
        {timeout: 10000, timeoutMsg: 'the imported seek step was never saved'});
    expect(await browser.execute(() => document.getElementById('seekstepsize').value)).toBe('7');
    await browser.execute(() => chrome.storage.sync.clear());
  });
});
