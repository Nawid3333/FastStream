// A file the player saves under a name Firefox refuses still gets saved.
//
// downloads.download() rejects a filename with a colon, and a few other characters, and
// the player got no download: nothing happened, with no message. Every screenshot is named
// "<video>@00:05.png", and a subtitle track is saved under its title, which can be
// "Mission: Impossible". The background now maps such a name to one Firefox saves.

import fs from 'node:fs';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';

// The folder wdio.extension.conf.mjs points Firefox's downloads at.
const downloadDir = path.resolve(import.meta.dirname, '../../../.e2e-downloads');

describe('Download names', function() {
  const cases = [
    ['a screenshot', 'Big_Buck_Bunny@00:05.png', 'Big_Buck_Bunny@00_05.png'],
    ['a subtitle track with a colon in its title', 'someone_-_Mission:_Impossible.srt', 'someone_-_Mission__Impossible.srt'],
    // Firefox refuses a name that starts with a dot.
    ['a screenshot of a title that starts with dots', '...And_Justice_for_All@00:05.png', 'And_Justice_for_All@00_05.png'],
    // A soft hyphen, as a page's title can carry: Firefox refuses every format character.
    ['a title with a soft hyphen', 'Donau' + String.fromCodePoint(0xAD) + 'dampf.srt', 'Donaudampf.srt'],
  ];

  for (const [name, asked, saved] of cases) {
    it(`saves ${name}`, async function() {
      const downloadId = await inExtensionPage((args, done) => {
        import('/player/utils/Utils.mjs').then(async ({Utils}) => {
          const url = URL.createObjectURL(new Blob(['saved']));
          done(await Utils.downloadURL(url, args.asked));
        }).catch((e) => done('error: ' + e));
      }, {asked});
      console.log('      download id:', downloadId);
      expect(typeof downloadId).toBe('number');
      await browser.waitUntil(() => fs.existsSync(path.join(downloadDir, saved)),
          {timeout: 10000, interval: 200, timeoutMsg: `${saved} was not saved`});
      expect(fs.readFileSync(path.join(downloadDir, saved), 'utf8')).toBe('saved');
    });
  }
});
