import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The player in a page is an out-of-process frame that takes its size asynchronously, and a
// script's click on the prompt's OK while its document had no size did nothing: page-fetch.e2e
// failed on most CI runs of 2026-11-15/16. tests/e2e/confirmPrompt.mjs clicks it only once
// the document has its size, in the same task. The specs that drive a player in a page (ext,
// classic, private windows) answer the prompt through it, or with a WebDriver click, which
// needs the button on the screen itself.

const e2e = path.resolve(import.meta.dirname, '../e2e');
const dirs = ['ext-specs', 'classic-specs', 'pbm-specs'];

describe('e2e specs answer the player\'s prompt only once it is laid out', () => {
  it('click OK from a script nowhere but through confirmPrompt', () => {
    const found = [];
    for (const dir of dirs) {
      const folder = path.join(e2e, dir);
      if (!fs.existsSync(folder)) continue;
      for (const file of fs.readdirSync(folder).filter((name) => name.endsWith('.mjs'))) {
        const text = fs.readFileSync(path.join(folder, file), 'utf8');
        // A script's own query for the button (document.querySelector('.fs-dialog-confirm') and
        // the like), or a form submitted from a script: requestSubmit submits even with no
        // layout, an answer no user could give. browser.$('.fs-dialog-confirm')
        // is WebDriver's element, which needs the button on the screen, and is not matched here.
        text.split('\n').forEach((line, index) => {
          if (/^\s*(\/\/|\*)/.test(line)) return;
          if (/(querySelector(All)?|getElementsByClassName)\([^)]*fs-dialog-confirm/.test(line) || /\brequestSubmit\(/.test(line)) {
            found.push(`${dir}/${file}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(found).toEqual([]);
  });

  it('confirmPrompt checks the layout in the same task as its click', () => {
    const helper = fs.readFileSync(path.join(e2e, 'confirmPrompt.mjs'), 'utf8');
    const task = helper.slice(helper.indexOf('ok = await browser.execute('), helper.indexOf('}, value);'));
    expect(task).toMatch(/getClientRects\(\)\.length/);
    expect(task).toMatch(/clientWidth/);
    expect(task.indexOf('getClientRects')).toBeLessThan(task.indexOf('confirm.click()'));
  });
});
