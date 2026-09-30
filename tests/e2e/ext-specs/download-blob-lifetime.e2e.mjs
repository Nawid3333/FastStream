// A save whose blob: URL the player lets go of still gets saved.
//
// downloads.download() resolves before Firefox has read a blob: URL. The player revoked the
// URL as soon as it had the download's id - a subtitle track saved from the menu, the end
// of a save (StreamSaver) - and 8 of 60 small downloads failed that way: the download was
// interrupted (CRASH), and no file came, with no message. Utils.revokeWhenDownloaded keeps
// the URL until Firefox says the download is over. 40 small saves made the way the player
// makes them must all complete: with the old revoke, all 40 surviving was a 1 in 250 chance.

import fs from 'node:fs';
import path from 'node:path';

import {expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

const downloadDir = path.resolve(import.meta.dirname, '../../../.e2e-downloads');
const SAVES = 40;

describe('A save\'s blob URL', function() {
  it('lives until the download is over', async function() {
    const result = await inExtensionPage((count, done) => {
      import('/player/utils/Utils.mjs').then(async ({Utils}) => {
        const ids = [];
        const urls = [];
        // Whether a URL still reads: the helper's contract, which the download race itself
        // shows only now and then (0 to 6 losses in 20, from one browser to the next).
        const alive = (url) => fetch(url).then(() => true, () => false);
        let keptWhileRunning = 0;
        for (let i = 0; i < count; i++) {
          const url = URL.createObjectURL(new Blob([`saved ${i}`], {type: 'text/plain'}));
          const id = await Utils.downloadURL(url, `blob-lifetime-${i}.srt`);
          Utils.revokeWhenDownloaded(url, id);
          if (await alive(url)) keptWhileRunning++;
          ids.push(id);
          urls.push(url);
        }
        const until = Date.now() + 60000;
        let items;
        do {
          await new Promise((resolve) => setTimeout(resolve, 250));
          items = await Promise.all(ids.map(async (id) => (await chrome.downloads.search({id}))[0]));
        } while (items.some((item) => item?.state === 'in_progress') && Date.now() < until);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const revokedAfter = (await Promise.all(urls.map(alive))).filter((a) => !a).length;
        done({
          states: items.map((item) => item ? item.state + (item.error ? ':' + item.error : '') : 'missing'),
          keptWhileRunning,
          revokedAfter,
        });
      }).catch((e) => done({states: ['error: ' + e]}));
    }, SAVES);
    const tally = {};
    result.states.forEach((state) => tally[state] = (tally[state] || 0) + 1);
    console.log('      states:', JSON.stringify(tally), 'kept while running:', result.keptWhileRunning,
        'revoked after:', result.revokedAfter);
    expect(result.keptWhileRunning).toBe(SAVES);
    expect(tally).toEqual({complete: SAVES});
    // Given back once the download is over, not kept for good.
    expect(result.revokedAfter).toBe(SAVES);
    for (let i = 0; i < SAVES; i++) {
      expect(fs.readFileSync(path.join(downloadDir, `blob-lifetime-${i}.srt`), 'utf8')).toBe(`saved ${i}`);
    }
  });
});
