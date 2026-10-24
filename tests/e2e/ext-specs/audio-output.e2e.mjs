// The player's choice of audio output (his wish, 2026-10-24): the audio list's "Choose an
// output..." opens Firefox's own chooser, the sound goes to the device picked, the next video
// plays there too, and "Default output" takes it back. In a page's iframe, as FastStream's
// player mostly is: Firefox refuses the choice there without allow="speaker-selection"
// (measured on Firefox 158).
//
// The harness answers Firefox's chooser itself (media.navigator.permission.disabled: the
// first device). What is checked is where the player sends the sound: the hidden element's
// device and the graph's end. Heard it is not: no one listens here.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {browser, expect} from '@wdio/globals';

import {inExtensionPage} from '../extension-page.mjs';
import {byteRange, sendFile} from '../serveFile.mjs';

const PORT = 41963;
const SITE = `http://127.0.0.1:${PORT}`;
const CLIP = path.resolve(import.meta.dirname, '../fixtures/sample-av.mp4');
const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));

let server;

/** Into FastStream's player, which took the page's video into its iframe. */
async function enterPlayer() {
  const selector = 'iframe[src*="player/index.html"]';
  await browser.switchFrame(null);
  await browser.waitUntil(async () => {
    await browser.switchFrame(null);
    return browser.$(selector).isExisting();
  }, {timeout: 30000, interval: 500, timeoutMsg: 'FastStream never replaced the page\'s video'});
  expect(await (await browser.$(selector)).getAttribute('allow')).toContain('speaker-selection');
  await browser.switchFrame(await browser.$(selector));
  await browser.waitUntil(() => browser.execute(() => !!window.fastStream?.audioContext &&
    (window.fastStream.player?.getVideo?.()?.readyState || 0) >= 2), {timeout: 30000, interval: 250, timeoutMsg: 'the player never played'});
}

/** Where the player sends the sound, and what its audio list shows. */
function outputState() {
  return browser.execute(() => {
    const device = window.fastStream.audioOutputDevice;
    return {
      // Whether, not which: a device's name is the machine's, and stays out of the logs.
      playing: device.playing && {named: !!device.playing.label, id: !!device.playing.deviceId},
      sameAsChoice: !!device.playing && device.playing === device.choice,
      choice: !!device.choice,
      elementOnDevice: !!device.element && device.element.sinkId === device.playing?.deviceId && !device.element.paused,
      // The output part: the rows after its header, the device's own as "device".
      rows: (() => {
        const all = Array.from(document.querySelectorAll('.mainplayer .fluid_audio_sources_list > *'));
        const header = all.findIndex((row) => row.classList.contains('fluid_audio_source_list_header'));
        return header < 0 ? [] : all.slice(header).map((row, i) => ({
          text: device.choice && row.textContent.includes(device.choice.label) ? 'device' : row.textContent.trim(),
          active: row.classList.contains('source_active'), header: i === 0}));
      })(),
      button: !document.querySelector('.mainplayer .fluid_button_soundwave').classList.contains('hidden'),
    };
  });
}

/**
 * Clicks a row of the audio list the way a user does (WebDriver's click: a user activation,
 * which Firefox's chooser needs), with the list open.
 * @param {string} text - The row's text, from its start.
 */
async function clickRow(text) {
  await browser.execute(() => window.fastStream.interfaceController.audioQualityChanger.openUI());
  const rows = await browser.$$('.mainplayer .fluid_audio_sources_list .fluid_audio_source_list_item');
  for (const row of rows) {
    if ((await row.getText()).trim().startsWith(text)) {
      await row.click();
      return;
    }
  }
  throw new Error(`no row "${text}" in the audio list`);
}

describe('The audio output', function() {
  before(async function() {
    server = http.createServer((req, res) => {
      const url = new URL(req.url, SITE);
      if (url.pathname === '/') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(`<!doctype html><title>site</title>
          <video muted autoplay preload="auto" style="width:640px;height:360px" src="${SITE}/clip.mp4"></video>`);
      }
      if (url.pathname === '/clip.mp4') {
        const size = fs.statSync(CLIP).size;
        const range = byteRange(req.headers.range, size);
        if (range && range !== 'unsatisfiable') {
          res.writeHead(206, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': range.end - range.start + 1});
          return sendFile(res, CLIP, range);
        }
        res.writeHead(200, {'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size});
        return sendFile(res, CLIP);
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(PORT, '127.0.0.1', resolve);
    });
    await inExtensionPage((site, done) => {
      chrome.storage.local.set({options: JSON.stringify({autoEnableURLs: [site + '/'], playMP4URLs: true})}, () => {
        chrome.runtime.sendMessage({type: 'LOAD_OPTIONS'}, () => {
          void chrome.runtime.lastError;
          setTimeout(() => done(true), 500);
        });
      });
    }, SITE);
  });

  after(async function() {
    await browser.switchFrame(null);
    await inExtensionPage((unused, done) => chrome.storage.local.remove(['audioOutputDevice', 'options'], () => done(true)));
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('plays on the default output, and offers the choice in the audio list', async function() {
    await browser.url(`${SITE}/?t=${Date.now()}`);
    await enterPlayer();
    const state = await outputState();
    console.log('      at the start:', JSON.stringify(state));
    expect(state.playing).toBe(null);
    expect(state.button).toBe(true);
    expect(state.rows.map((row) => row.text)).toEqual(expect.arrayContaining([
      en.player_audio_output_label.message,
      `${en.player_audio_output_default.message} ${en.player_quality_current.message}`,
      en.player_audio_output_choose.message,
    ]));
  });

  it('sends the sound to the device chosen, also for the next video, and back to the default', async function() {
    await enterPlayer();
    // What the chooser answered: a machine without an audio output (a CI runner) has nothing
    // to choose, and there is nothing to test.
    await browser.execute(() => {
      const device = window.fastStream.audioOutputDevice;
      const choose = device.choose.bind(device);
      window.__chose = undefined;
      device.choose = () => choose().then((choice) => {
        window.__chose = choice ? 'device' : 'none';
        return choice;
      }, (e) => {
        window.__chose = 'error: ' + e;
        throw e;
      });
    });
    await clickRow(en.player_audio_output_choose.message);
    await browser.waitUntil(() => browser.execute(() => window.__chose !== undefined),
        {timeout: 15000, interval: 250, timeoutMsg: 'the chooser never answered'});
    const answer = await browser.execute(() => window.__chose);
    if (answer === 'none') {
      console.log('      no audio output on this machine: skipped');
      // eslint-disable-next-line no-invalid-this
      this.skip();
    }
    expect(answer).toBe('device');
    await browser.waitUntil(async () => (await outputState()).elementOnDevice,
        {timeout: 15000, interval: 250, timeoutMsg: 'the sound never went to the device chosen'});
    const chosen = await outputState();
    console.log('      chosen:', JSON.stringify(chosen));
    expect(chosen.playing.id).toBe(true);
    expect(chosen.sameAsChoice).toBe(true);
    expect(chosen.rows.filter((row) => row.active).map((row) => row.text)).toEqual(['device']);

    // The next video: the page again, a new player. Firefox lets a page use a device only once
    // it was chosen there (NotFoundError in this one), and the chooser only from a click: the
    // player says so, and one click on what it says brings the sound back to the device.
    await browser.url(`${SITE}/?t=${Date.now()}`);
    await enterPlayer();
    const again = en.player_audio_output_again.message;
    await browser.waitUntil(() => browser.execute((again) => {
      const label = window.fastStream.audioOutputDevice.choice?.label;
      return Array.from(document.querySelectorAll('.mainplayer .status_message.clickable'))
          .some((el) => el.style.display !== 'none' && el.textContent === again.replace('$1', label));
    }, again), {timeout: 15000, interval: 250, timeoutMsg: 'the next video did not say how to get the device back'});
    expect((await outputState()).playing).toBe(null);
    const messages = await browser.$$('.mainplayer .status_message.clickable');
    for (const message of messages) {
      if (await message.isDisplayed()) {
        await message.click();
        break;
      }
    }
    await browser.waitUntil(async () => (await outputState()).elementOnDevice,
        {timeout: 15000, interval: 250, timeoutMsg: 'a click on the message did not bring the sound to the device'});
    expect((await outputState()).sameAsChoice).toBe(true);
    // Said and done: the message goes.
    expect(await browser.execute(() => Array.from(document.querySelectorAll('.mainplayer .status_message.clickable'))
        .some((el) => el.style.display !== 'none'))).toBe(false);

    await clickRow(en.player_audio_output_default.message);
    await browser.waitUntil(async () => (await outputState()).playing === null,
        {timeout: 10000, interval: 250, timeoutMsg: 'the sound did not go back to the default output'});
    const back = await outputState();
    console.log('      back:', JSON.stringify(back));
    expect(back.choice).toBe(false);
    expect(back.rows.filter((row) => row.active).map((row) => row.text))
        .toEqual([`${en.player_audio_output_default.message} ${en.player_quality_current.message}`]);
  });
});
