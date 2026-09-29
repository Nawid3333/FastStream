// The audio tools' controls: the channel mixer's faders, the master compressor, the
// crosstalk filter, the output convolver's impulse import, the volume's gain and the
// profile dropdowns.
//
// Each case opens the web player on the fixture with sound (sample.mp4 has none), with
// autoplay and remembered positions off, and opens the audio tools. The cases whose
// audio graph needs the channel count play the video: the count only comes once sound
// flows. The suite's Firefox has media.volume_scale 0, so nothing is heard.
import fs from 'node:fs';
import {browser, expect} from '@wdio/globals';

const en = JSON.parse(fs.readFileSync(new URL('../../../chrome/_locales/en/messages.json', import.meta.url), 'utf8'));
const avUrl = (query = '') => `${globalThis.__E2E_FIXTURES_ORIGIN__}/fixtures/long-av.mp4${query}`;

/**
 * Hands the player a source the way main.mjs does, waits for its picture, and plays it
 * if asked.
 * @param {string} url - The source.
 * @param {boolean} play - Whether to play it, until its time has moved.
 * @return {Promise<void>}
 */
async function loadVideo(url, play) {
  const error = await browser.executeAsync((url, done) => {
    Promise.all([import('/player/VideoSource.mjs'), import('/player/utils/URLUtils.mjs')])
        .then(([{VideoSource}, {URLUtils}]) => {
          window.fastStream.addSource(new VideoSource(url, {}, URLUtils.getModeFromURL(url)), true);
          done(null);
        }).catch((e) => done(String(e)));
  }, url);
  expect(error).toBe(null);
  await browser.waitUntil(async () => browser.execute((url) => {
    const client = window.fastStream;
    return !!client.player && client.source?.url === url && client.duration > 0 && client.currentVideo?.readyState >= 2;
  }, url), {timeout: 30000, timeoutMsg: 'the video never loaded'});
  if (play) {
    await browser.execute(() => window.fastStream.play());
    await browser.waitUntil(async () => browser.execute(() => window.fastStream.currentTime > 0.3),
        {timeout: 15000, timeoutMsg: 'the video never played'});
  }
}

/**
 * Opens the player on the fixture with sound and the audio tools on it.
 * @param {{play: boolean}} [options] - Whether to play the video.
 * @return {Promise<void>}
 */
async function openAudioTools({play = false} = {}) {
  await browser.url(`/player/index.html?t=${Date.now()}`);
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream),
      {timeout: 30000, timeoutMsg: 'the player never started'});
  // main.mjs applies the stored options once the client exists, which would undo the
  // overrides below; it sets optionsApplied when it has.
  await browser.waitUntil(async () => browser.execute(() => !!window.fastStream.optionsApplied),
      {timeout: 30000, timeoutMsg: 'the player options never loaded'});
  await browser.execute(() => {
    window.fastStream.options.autoPlay = false;
    window.fastStream.options.storeProgress = false;
    window.__rejections = [];
    window.addEventListener('unhandledrejection', (e) => window.__rejections.push(String(e.reason)));
  });
  await loadVideo(avUrl(), play);
  await browser.execute(() => window.fastStream.audioConfigManager.openUI());
  // The mixer builds a strip per channel once it knows how many there are.
  await browser.waitUntil(async () => browser.execute(() =>
    window.fastStream.audioConfigManager.audioChannelMixer.ui.channels.querySelectorAll('.mixer_channel_container').length > 0),
  {timeout: 15000, timeoutMsg: 'the mixer never showed a channel'});
}

/**
 * Reads a value until it passes a check or the time is up, and gives the last one read.
 * @param {function(): Promise<*>} read - Reads the value.
 * @param {function(*): boolean} check - Whether it is the one waited for.
 * @param {number} [timeout] - How long to wait, in ms.
 * @return {Promise<*>}
 */
async function settle(read, check, timeout = 5000) {
  let value;
  await browser.waitUntil(async () => check(value = await read()), {timeout, interval: 100}).catch(() => {});
  return value;
}

describe('Audio tools', function() {
  it('keeps a fader\'s label on its value when the keys or the wheel move it, down to -∞ dB', async function() {
    // The label is the fader's value for a screen reader; the arrow keys and the wheel left
    // it on the old value, and at the bottom it read "-Infinity dB".
    await openAudioTools();
    const labels = await browser.execute(() => {
      const mixer = window.fastStream.audioConfigManager.audioChannelMixer;
      const strip = mixer.ui.channels.querySelector('.mixer_channel_container');
      const handle = strip.querySelector('.mixer_channel_volume_handle');
      const track = strip.querySelector('.mixer_channel_volume_track');
      const press = (key) => handle.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true}));
      const out = {start: handle.title};
      for (let i = 0; i < 8; i++) press('ArrowDown');
      out.down = handle.title;
      press('ArrowUp');
      out.up = handle.title;
      track.dispatchEvent(new WheelEvent('wheel', {deltaY: 1, bubbles: true, cancelable: true}));
      out.wheel = handle.title;
      for (let i = 0; i < 60; i++) press('ArrowDown');
      out.bottom = handle.title;
      out.gain = mixer.channelConfigs[0].gain;
      // A double click puts the fader back to 0 dB, and a click on the track moves it there.
      handle.dispatchEvent(new MouseEvent('dblclick', {bubbles: true, cancelable: true}));
      out.reset = handle.title;
      const rect = track.getBoundingClientRect();
      out.trackHeight = rect.height;
      track.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, clientY: rect.top + rect.height * 0.75}));
      out.clicked = handle.title;
      return out;
    });
    console.log('      labels:', JSON.stringify(labels));
    expect(labels.down).not.toBe(labels.start);
    expect(labels.up).not.toBe(labels.down);
    expect(labels.wheel).not.toBe(labels.up);
    expect(labels.gain).toBe(0);
    expect(labels.bottom).toContain('-∞');
    expect(labels.bottom).not.toContain('Infinity');
    expect(labels.reset).toBe(labels.start);
    expect(labels.trackHeight).toBeGreaterThan(0);
    expect(labels.clicked).not.toBe(labels.reset);
  });

  it('keeps a channel\'s impulse response when the file picked next is not audio', async function() {
    // The file was stored before it was decoded, so one that did not decode replaced the
    // channel's impulse response, and the channel read "Error". The picker also offered
    // AIFF, which Firefox does not decode.
    await openAudioTools();
    const result = await browser.executeAsync((done) => {
      (async () => {
        const convolver = window.fastStream.audioConfigManager.outputConvolver;
        const channel = convolver.convolverChannels[0];
        const until = async (check) => {
          for (let i = 0; i < 200 && !check(); i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return check();
        };
        if (!await until(() => !!convolver.audioContext)) {
          throw new Error('the convolver never got an audio context');
        }
        // The file button opens the file picker with input.click(); this takes the input
        // instead, and picks for it.
        const inputs = [];
        const click = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function() {
          if (this.type === 'file') {
            inputs.push(this);
          } else {
            click.call(this);
          }
        };
        const pick = async (file) => {
          channel.fileButton.click();
          const input = inputs[inputs.length - 1];
          const transfer = new DataTransfer();
          transfer.items.add(file);
          input.files = transfer.files;
          input.dispatchEvent(new Event('change'));
          // The input goes once the file is dealt with.
          if (!await until(() => !input.isConnected)) {
            throw new Error(`${file.name} was never dealt with`);
          }
          return input;
        };
        // 64 samples of 16-bit mono PCM, the first one an impulse.
        const samples = 64;
        const view = new DataView(new ArrayBuffer(44 + samples * 2));
        const ascii = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
        ascii(0, 'RIFF');
        view.setUint32(4, 36 + samples * 2, true);
        ascii(8, 'WAVEfmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, 44100, true);
        view.setUint32(28, 44100 * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        ascii(36, 'data');
        view.setUint32(40, samples * 2, true);
        view.setInt16(44, 32767, true);

        const stored = async () => (await convolver.db.getFile(convolver.getImpulseNameForChannel(convolver.currentProfile.id, 0)))?.name ?? null;
        const state = async () => ({fileName: channel.fileName, decoded: !!channel.impulseBuffer, stored: await stored()});
        try {
          const input = await pick(new File([view.buffer], 'room.wav', {type: 'audio/wav'}));
          const out = {accept: input.accept, afterWav: await state()};
          await pick(new File(['not audio'], 'notes.wav', {type: 'audio/wav'}));
          await until(() => !!document.querySelector('.swal2-popup'));
          out.afterJunk = await state();
          out.alert = document.querySelector('.swal2-popup')?.textContent ?? null;
          return out;
        } finally {
          HTMLInputElement.prototype.click = click;
        }
      })().then(done, (e) => done({error: String(e)}));
    });
    console.log('      convolver:', JSON.stringify(result));
    expect(result.error).toBeUndefined();
    expect(result.accept.split(',')).not.toContain('.aiff');
    expect(result.accept.split(',')).not.toContain('.aif');
    expect(result.afterWav).toEqual({fileName: 'room.wav', decoded: true, stored: 'room.wav'});
    expect(result.afterJunk).toEqual({fileName: 'room.wav', decoded: true, stored: 'room.wav'});
    expect(result.alert).toContain(en.audioconvolver_decodeerror.message);
  });

  it('keeps the master compressor on, with its settings, for the next videos', async function() {
    // A new video recounts its channels, which dropped the count the compressor's build
    // was waiting for. The build gave up, and the compressor stayed off for that video
    // with its toggle on.
    await openAudioTools({play: true});
    const read = () => browser.execute(() => {
      const comp = window.fastStream.audioConfigManager.audioChannelMixer.masterNodes.compressor;
      return {enabled: !!comp.compressorConfig?.enabled, built: !!comp.compressorNode,
        threshold: comp.compressorNode ? Math.round(comp.compressorNode.threshold.value) : null};
    });
    await browser.execute(() => {
      const comp = window.fastStream.audioConfigManager.audioChannelMixer.masterNodes.compressor;
      comp.compressorConfig.threshold = -40;
      comp.ui.compressorToggle.click();
    });
    const ready = (state) => state.built && state.threshold === -40;
    expect(await settle(read, ready)).toEqual({enabled: true, built: true, threshold: -40});
    for (const query of ['?next=1', '?next=2']) {
      await loadVideo(avUrl(query), true);
      const state = await settle(read, ready);
      console.log(`      master compressor on ${query}:`, JSON.stringify(state));
      expect(state).toEqual({enabled: true, built: true, threshold: -40});
    }
  });

  it('rebuilds the master compressor with its settings when the channel count changes', async function() {
    // Another channel count (another audio track) rebuilt the compressor's nodes with
    // their defaults.
    await openAudioTools({play: true});
    await browser.execute(() => {
      const comp = window.fastStream.audioConfigManager.audioChannelMixer.masterNodes.compressor;
      comp.compressorConfig.threshold = -40;
      comp.ui.compressorToggle.click();
    });
    await settle(() => browser.execute(() => !!window.fastStream.audioConfigManager.audioChannelMixer.masterNodes.compressor.compressorNode),
        (built) => built);
    const rebuilt = await browser.executeAsync((done) => {
      (async () => {
        const comp = window.fastStream.audioConfigManager.audioChannelMixer.masterNodes.compressor;
        const state = () => ({built: !!comp.compressorNode, outputs: comp.splitterNode?.numberOfOutputs ?? null,
          threshold: comp.compressorNode ? Math.round(comp.compressorNode.threshold.value) : null});
        const recount = async (count) => {
          comp.numberOfChannelsGetter = async () => count;
          await comp.updateChannelCount();
          // The nodes come a few microtasks before their settings do.
          for (let i = 0; i < 100; i++) {
            const now = state();
            if (now.outputs === (count > 2 ? count : null) && now.threshold === -40) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return state();
        };
        return {six: await recount(6), two: await recount(2)};
      })().then(done, (e) => done({error: String(e)}));
    });
    expect(rebuilt.six).toEqual({built: true, outputs: 6, threshold: -40});
    expect(rebuilt.two).toEqual({built: true, outputs: null, threshold: -40});
  });

  it('leaves the master compressor off when it is switched on and straight off again', async function() {
    // Switched off while its build waited for the channel count, it was built anyway and
    // compressed with its toggle off. Two clicks in one task stand for a switch-off in the
    // few milliseconds a count takes after each recount.
    await openAudioTools({play: true});
    const state = await browser.executeAsync((done) => {
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const comp = window.fastStream.audioConfigManager.audioChannelMixer.masterNodes.compressor;
        if (comp.compressorConfig.enabled) {
          comp.ui.compressorToggle.click();
          await sleep(300);
        }
        comp.ui.compressorToggle.click();
        comp.ui.compressorToggle.click();
        await sleep(500);
        return {enabled: comp.compressorConfig.enabled, built: !!comp.compressorNode};
      })().then(done, (e) => done({error: String(e)}));
    });
    expect(state).toEqual({enabled: false, built: false});
  });

  it('switches the crosstalk filter off when it is switched off while it starts, and on again', async function() {
    // Its node takes a few milliseconds to start (14 ms the first time, measured). Switched
    // off in that time, the disconnect threw "Node not connected", and the node was then
    // wired in with the toggle off. Two clicks in one task land in that time.
    await openAudioTools();
    const result = await browser.executeAsync((done) => {
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const crosstalk = window.fastStream.audioConfigManager.audioCrosstalk;
        const toggle = () => crosstalk.ui.crosstalkToggle.click();
        const state = () => {
          const node = crosstalk.crosstalkNode;
          return {enabled: crosstalk.crosstalkConfig.enabled, node: !!node,
            wired: !!node && crosstalk.getInputNode().indexConnectedTo(node.getInputNode()) !== -1};
        };
        const until = async (check) => {
          for (let i = 0; i < 200 && !check(state()); i++) await sleep(25);
          return state();
        };
        toggle();
        toggle();
        // A fixed wait, since nothing shows when the dropped node's start has ended: the
        // bug wired it in then. The start took 14 ms on the first time, measured.
        await sleep(1000);
        const off = state();
        toggle();
        const on = await until((now) => now.wired);
        toggle();
        const offAgain = await until((now) => !now.node);
        return {off, on, offAgain, rejections: window.__rejections.slice()};
      })().then(done, (e) => done({error: String(e)}));
    });
    console.log('      crosstalk:', JSON.stringify(result));
    expect(result.off).toEqual({enabled: false, node: false, wired: false});
    expect(result.on).toEqual({enabled: true, node: true, wired: true});
    expect(result.offAgain).toEqual({enabled: false, node: false, wired: false});
    expect(result.rejections).toEqual([]);
  });

  it('keeps the crosstalk distances when a distance field is emptied', async function() {
    // parseFloat('') is NaN: it became the suggested delay and decay, which the filter
    // used, and was saved as null, which lost both distances on the next start.
    await openAudioTools();
    const result = await browser.execute(() => {
      const crosstalk = window.fastStream.audioConfigManager.audioCrosstalk;
      const [speaker, head] = crosstalk.ui.crosstalkControls.querySelectorAll('.crosstalk_calculator_input');
      const type = (input, text) => {
        input.value = text;
        input.dispatchEvent(new Event('input'));
      };
      type(speaker, '');
      type(head, 'cm');
      // NaN comes back from the page as null.
      const emptied = {speaker: crosstalk.speakerDistance, head: crosstalk.headDistance,
        suggested: crosstalk.calculateCrosstalkDelayAndDecay(crosstalk.speakerDistance, crosstalk.headDistance)};
      type(speaker, '45 cm');
      return {emptied, saved: JSON.parse(localStorage.getItem('audiocrosstalk_distanceconfig'))};
    });
    expect(result.emptied.speaker).toBe(30);
    expect(result.emptied.head).toBe(60);
    expect(result.emptied.suggested.microdelay).toBeGreaterThan(0);
    expect(result.saved).toEqual({speakerDistance: 45, headDistance: 60});
  });

  it('sets the volume to 100% at once', async function() {
    // The volume is a gain node, which goes 200 ms after the volume is back at 100%; until
    // then it kept the old volume.
    await openAudioTools();
    const gains = await browser.executeAsync((done) => {
      (async () => {
        const client = window.fastStream;
        const gain = () => Math.round((client.audioConfigManager.finalGain.gainNode?.gain.value ?? 1) * 100) / 100;
        const out = [];
        for (const from of [0.5, 1.5]) {
          client.volume = from;
          await new Promise((resolve) => setTimeout(resolve, 300));
          const before = gain();
          client.volume = 1;
          out.push({before, after: gain()});
        }
        return out;
      })().then(done, (e) => done({error: String(e)}));
    });
    expect(gains).toEqual([{before: 0.5, after: 1}, {before: 1.5, after: 1}]);
  });

  it('shows "Deleted" for a second after the last of two quick deletes', async function() {
    // The first delete's timer was not kept, so it put the label back half a second into
    // the second delete's "Deleted".
    await openAudioTools();
    const changes = await browser.executeAsync((done) => {
      (async () => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const configManager = window.fastStream.audioConfigManager;
        configManager.newProfile(false);
        configManager.newProfile(false);
        const button = configManager.ui.deleteButton;
        const changes = [];
        const start = performance.now();
        new MutationObserver(() => changes.push([Math.round(performance.now() - start), button.textContent]))
            .observe(button, {childList: true, characterData: true, subtree: true});
        button.click();
        await sleep(500);
        button.click();
        await sleep(1700);
        return changes;
      })().then(done, (e) => done({error: String(e)}));
    });
    console.log('      delete button:', JSON.stringify(changes));
    const lastDeleted = changes.filter(([, text]) => text === en.player_audioconfig_profile_deleted.message).at(-1)?.[0];
    const firstReset = changes.find(([, text]) => text === en.player_audioconfig_profile_delete.message)?.[0];
    expect(firstReset - lastDeleted).toBeGreaterThanOrEqual(900);
  });

  it('hides the equalizer\'s add-a-node marker when the pointer leaves the curve', async function() {
    // Leaving the curve at mid height showed the marker again, and it stayed there.
    await openAudioTools();
    const marker = await browser.execute(() => {
      const mixer = window.fastStream.audioConfigManager.audioChannelMixer;
      mixer.masterElements.dynButton.click();
      const equalizer = mixer.masterNodes.equalizer;
      const curve = equalizer.ui.equalizer;
      const rect = curve.getBoundingClientRect();
      const at = {clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true};
      curve.dispatchEvent(new MouseEvent('mousemove', at));
      const over = equalizer.ui.zeroLineNode.style.display;
      curve.dispatchEvent(new MouseEvent('mouseout', {...at, relatedTarget: document.body}));
      return {height: Math.round(rect.height), over, left: equalizer.ui.zeroLineNode.style.display};
    });
    console.log('      marker:', JSON.stringify(marker));
    expect(marker.height).toBeGreaterThan(0);
    expect(marker.over).toBe('');
    expect(marker.left).toBe('none');
  });

  it('selects the profile clicked right after another one was renamed', async function() {
    // Leaving the name field rebuilt the dropdown under the pointer, which lost the click
    // that left it: the renamed profile stayed selected. Real pointer actions, since the
    // lost click is the browser's doing. The convolver's profiles have the same dropdown.
    await openAudioTools();
    const ids = await browser.execute(() => {
      const configManager = window.fastStream.audioConfigManager;
      configManager.newProfile(false);
      const convolver = configManager.outputConvolver;
      return {first: configManager.profiles[0].id, renamed: configManager.getDropdownProfile().id,
        convolverOther: convolver.config.profiles.find((profile) => profile.id !== convolver.currentProfile.id).id};
    });
    await (await browser.$('.profile_selector .dropdown_text')).click();
    await browser.keys(['X']);
    const label = await browser.execute(() => window.fastStream.audioConfigManager.ui.profileDropdown.ariaLabel);
    await (await browser.$(`.profile_selector .items > div[data-val="p${ids.first}"]`)).click();
    await (await browser.$('.convolver_controls .dropdown_text')).click();
    await browser.keys(['X']);
    await (await browser.$(`.convolver_controls .items > div[data-val="p${ids.convolverOther}"]`)).click();
    const after = await browser.execute((renamed) => {
      const configManager = window.fastStream.audioConfigManager;
      return {selected: configManager.ui.profileDropdown.dataset.val, current: configManager.currentProfile.id,
        renamedLabel: configManager.profiles.find((profile) => profile.id === renamed).label,
        convolverSelected: configManager.outputConvolver.ui.profileDropdown.dataset.val,
        convolverCurrent: configManager.outputConvolver.currentProfile.id};
    }, ids.renamed);
    console.log('      profiles:', JSON.stringify({ids, label, after}));
    // The name's label follows the edit, now that nothing rebuilds the dropdown after it.
    expect(label).toContain('X');
    expect(after.renamedLabel).toContain('X');
    expect(after.selected).toBe(`p${ids.first}`);
    expect(after.current).toBe(ids.first);
    expect(after.convolverSelected).toBe(`p${ids.convolverOther}`);
    expect(after.convolverCurrent).toBe(ids.convolverOther);
  });

  it('selects the profile clicked right after another one\'s name was emptied', async function() {
    // An emptied name is stored as a fallback ("Unnamed Profile", "Profile 2"), which the field then
    // has to show. It was shown by rebuilding the dropdown, under the pointer, and the click
    // was lost as above.
    await openAudioTools();
    const ids = await browser.execute(() => {
      const configManager = window.fastStream.audioConfigManager;
      configManager.newProfile(false);
      const convolver = configManager.outputConvolver;
      return {first: configManager.profiles[0].id, renamed: configManager.getDropdownProfile().id,
        convolverRenamed: convolver.currentProfile.id,
        convolverOther: convolver.config.profiles.find((profile) => profile.id !== convolver.currentProfile.id).id};
    });
    const empty = async (selector) => {
      await (await browser.$(selector)).click();
      await browser.keys(['Control', 'a']);
      await browser.keys(['Backspace']);
    };
    await empty('.profile_selector .dropdown_text');
    await (await browser.$(`.profile_selector .items > div[data-val="p${ids.first}"]`)).click();
    await empty('.convolver_controls .dropdown_text');
    await (await browser.$(`.convolver_controls .items > div[data-val="p${ids.convolverOther}"]`)).click();
    const after = await browser.execute((ids) => {
      const configManager = window.fastStream.audioConfigManager;
      const convolver = configManager.outputConvolver;
      const itemText = (dropdown, id) => dropdown.querySelector(`.items > div[data-val="p${id}"]`).textContent;
      return {selected: configManager.ui.profileDropdown.dataset.val, current: configManager.currentProfile.id,
        renamedLabel: configManager.profiles.find((profile) => profile.id === ids.renamed).label,
        renamedItem: itemText(configManager.ui.profileDropdown, ids.renamed),
        convolverSelected: convolver.ui.profileDropdown.dataset.val, convolverCurrent: convolver.currentProfile.id,
        convolverRenamedLabel: convolver.config.profiles.find((profile) => profile.id === ids.convolverRenamed).label,
        convolverRenamedItem: itemText(convolver.ui.profileDropdown, ids.convolverRenamed)};
    }, ids);
    console.log('      profiles:', JSON.stringify({ids, after}));
    expect(after.selected).toBe(`p${ids.first}`);
    expect(after.current).toBe(ids.first);
    expect(after.renamedLabel).toBe(en.player_audioconfig_profile_unnamed.message);
    expect(after.renamedItem).toBe(after.renamedLabel);
    expect(after.convolverSelected).toBe(`p${ids.convolverOther}`);
    expect(after.convolverCurrent).toBe(ids.convolverOther);
    expect(after.convolverRenamedLabel).toBe(`Profile ${ids.convolverRenamed + 1}`);
    expect(after.convolverRenamedItem).toBe(after.convolverRenamedLabel);
  });
});
