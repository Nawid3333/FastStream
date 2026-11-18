// Exercises vendored libraries the playback suite never reaches (GIF export, remuxing, the colour
// picker, vtt).
// Each makes the library do its job and inspects the bytes: a wrong worker URL or UMD unwrap still
// imports cleanly.
// The modules load straight from the served web build; the UI paths need a loaded video and seconds
// of playback.

import {spawnSync} from 'node:child_process';
import {browser, expect} from '@wdio/globals';
import {createFile} from 'mp4box';
import {runInPage} from '../runInPage.mjs';
import {withTempFile} from '../tempFile.mjs';

// How far a sample's time in a written MP4 may be from its chunk's: well under a frame
// (33 ms here) and under the gaps these tests look for, while allowing for the file's
// timescale.
const PTS_TOLERANCE = 0.0005;

/**
 * Reads an MP4 back: its tracks and samples with mp4box, and every frame decoded with ffmpeg.
 * Times come from the file's own boxes: ffprobe shifts a track's pts by its largest negative
 * composition offset.
 * @param {string} base64 the file
 * @return {Object} {decodeErrors, boxes, boxBytes, size, streams, width, height, sampleRate,
 *     channels, video, audio}: boxes the top-level box types and boxBytes their sizes
 *     added up, to set against the file's size; streams the track types in file order, and
 *     video and audio each track's samples in decode order, as {pts, key, size}
 */
function probeMp4(base64) {
  const bytes = Buffer.from(base64, 'base64');
  // A fresh mkdtemp directory per run: CodeQL js/insecure-temporary-file — see tempFile.mjs.
  return withTempFile('probe.mp4', bytes, (file) => {
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], {encoding: 'utf8'});
    if (decode.error) {
      throw new Error(`ffmpeg must be on PATH to decode a written file: ${decode.error.message}`);
    }

    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    buffer.fileStart = 0;
    const mp4 = createFile(false);
    mp4.appendBuffer(buffer);
    mp4.flush();
    const tracks = mp4.getInfo().tracks;
    const samplesOf = (type) => {
      const track = tracks.find((t) => t.type === type);
      if (!track) return [];
      const trak = mp4.getTrackById(track.id);
      const edit = trak.edts?.elst?.entries?.[0]?.media_time ?? 0;
      return trak.samples.map((s) => ({pts: (s.cts - edit) / s.timescale, key: s.is_sync, size: s.size}));
    };
    const video = tracks.find((t) => t.type === 'video');
    const audio = tracks.find((t) => t.type === 'audio');
    return {
      decodeErrors: (decode.stderr || '').trim(),
      boxes: mp4.boxes.map((box) => box.type),
      boxBytes: mp4.boxes.reduce((sum, box) => sum + box.size, 0),
      size: bytes.length,
      streams: tracks.map((t) => t.type),
      codecs: tracks.map((t) => t.codec),
      width: video?.video.width,
      height: video?.video.height,
      sampleRate: audio?.audio.sample_rate,
      channels: audio?.audio.channel_count,
      video: samplesOf('video'),
      audio: samplesOf('audio'),
    };
  });
}

describe('vendored encoding libraries', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('gif.js encodes a real GIF through its worker', async function() {
    // gif.js's worker URL is rewritten to resolve from import.meta.url (sync-vendor.mjs): a wrong
    // one hangs render(), so a timeout is a real failure.
    const result = await runInPage(async () => {
      const {GIF} = await import('/player/modules/gif/gif.mjs');
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');

      const gif = new GIF({workers: 1, quality: 10});
      for (const colour of ['#ff0000', '#0000ff']) {
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 32, 32);
        // the canvas element, not its context (as LoopMenu.mjs): gif.js takes the frame size from it
        gif.addFrame(canvas, {copy: true, delay: 100});
      }

      const blob = await new Promise((resolve, reject) => {
        gif.on('finished', resolve);
        gif.on('abort', () => reject(new Error('gif.js aborted')));
        gif.render();
      });
      const head = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
      return {
        size: blob.size,
        type: blob.type,
        magic: String.fromCharCode(...head),
      };
    });

    console.log('      gif:', JSON.stringify(result));
    // GIF89a is the header every GIF written by this encoder starts with.
    expect(result.magic).toBe('GIF89a');
    expect(result.type).toBe('image/gif');
    expect(result.size).toBeGreaterThan(100);
  });

  it('Mediabunny finishes a file with an empty video track, and one whose video never came', async function() {
    // The remuxer's writer (mp4-writer.mjs) finishes a file whose video track has no packets, and
    // flushes the held audio from 0.
    const result = await runInPage(async () => {
      const {MP4Writer} = await import('/player/modules/remux/mp4-writer.mjs');
      const {ALL_FORMATS, BlobSource, EncodedPacketSink, Input} = await import('/player/modules/remux/mediabunny.mjs');
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const get = async (file) => (await fetch('/fixtures/' + file)).arrayBuffer();
      const base64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(text);
      };
      const blobManager = new FSBlob();

      const empty = new MP4Writer(blobManager, {video: 'avc'});
      await empty.start();
      const emptyFile = await empty.finalize();

      const input = new Input({
        source: new BlobSource(new Blob([await get('dash-list/init-stream1.m4s'), await get('dash-list/chunk-stream1-00002.m4s')])),
        formats: ALL_FORMATS,
      });
      const track = await input.getPrimaryAudioTrack();
      const decoderConfig = await track.getDecoderConfig();
      const noVideo = new MP4Writer(blobManager, {video: 'avc', audio: await track.getCodec()});
      await noVideo.start();
      const packets = [];
      for await (const packet of new EncodedPacketSink(track).packets()) {
        await noVideo.add('audio', packet, packets.length ? undefined : {decoderConfig});
        packets.push({timestamp: packet.microsecondTimestamp, size: packet.data.byteLength});
      }
      const noVideoFile = await noVideo.finalize();
      input.dispose();
      await blobManager.close();

      return {
        empty: {
          size: emptyFile.size,
          boxType: new TextDecoder().decode(await emptyFile.slice(4, 8).arrayBuffer()),
        },
        noVideo: await base64(noVideoFile),
        input: packets,
      };
    });

    console.log('      empty track:', JSON.stringify(result.empty));
    expect(result.empty.boxType).toBe('ftyp');
    expect(result.empty.size).toBeGreaterThan(0);

    const file = probeMp4(result.noVideo);
    const first = result.input[0].timestamp;
    console.log('      no video:', JSON.stringify({streams: file.streams, packets: file.audio.length,
      firstPts: file.audio[0]?.pts, inputFirst: first / 1e6}));
    expect(file.decodeErrors).toBe('');
    expect(file.streams).toEqual(['audio']);
    expect(file.audio.length).toBe(result.input.length);
    // Guards the fixture: a segment that starts at 0 proves nothing about moving it there.
    expect(first).toBeGreaterThan(1e6);
    result.input.forEach((packet, i) => {
      expect(Math.abs(file.audio[i].pts - (packet.timestamp - first) / 1e6)).toBeLessThan(PTS_TOLERANCE);
      expect(file.audio[i].size).toBe(packet.size);
    });
  });

  it('Mediabunny writes H.264 with B-frames and AAC from mid-stream into a file that starts at 0', async function() {
    // The remuxer's writer fed packets as Mediabunny reads them, from mid-stream with B-frames: the
    // file starts at 0.
    // All the video goes in before any audio: nothing reaches the file before the audio's first
    // packet sets 0.
    // 16 KB pieces instead of 16 MB, so the piece store runs as in a long save (FSBlob and back).
    const result = await runInPage(async () => {
      const {MP4Writer} = await import('/player/modules/remux/mp4-writer.mjs');
      const {ALL_FORMATS, BlobSource, EncodedPacketSink, Input} = await import('/player/modules/remux/mediabunny.mjs');
      const {FSBlob} = await import('/player/modules/FSBlob.mjs');
      const get = async (file) => (await fetch('/fixtures/' + file)).arrayBuffer();
      const base64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(text);
      };
      const open = async (files, type) => {
        const input = new Input({
          source: new BlobSource(new Blob(await Promise.all(files.map(get)))),
          formats: ALL_FORMATS,
        });
        const track = type === 'video' ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
        const packets = [];
        for await (const packet of new EncodedPacketSink(track).packets()) {
          packets.push(packet);
        }
        return {input, codec: await track.getCodec(), decoderConfig: await track.getDecoderConfig(), packets};
      };

      const video = await open(['fmp4-bframes/init-stream0.m4s', 'fmp4-bframes/chunk-stream0-00002.m4s'], 'video');
      const audio = await open(['dash-list/init-stream1.m4s', 'dash-list/chunk-stream1-00004.m4s',
        'dash-list/chunk-stream1-00005.m4s'], 'audio');

      const blobManager = new FSBlob();
      const writer = new MP4Writer(blobManager, {video: video.codec, audio: audio.codec}, 16 * 1024);
      await writer.start();
      for (const [i, packet] of video.packets.entries()) {
        await writer.add('video', packet, i ? undefined : {decoderConfig: video.decoderConfig});
      }
      for (const [i, packet] of audio.packets.entries()) {
        await writer.add('audio', packet, i ? undefined : {decoderConfig: audio.decoderConfig});
      }
      const file = await writer.finalize();
      video.input.dispose();
      audio.input.dispose();

      // Firefox plays it: a frame after a seek (Firefox's fragmented duration is the shortest
      // track's end).
      const element = document.createElement('video');
      element.muted = true;
      const url = URL.createObjectURL(file);
      const failed = new Promise((resolve, reject) => {
        element.onerror = () => reject(new Error('Firefox could not play the file: ' +
          (element.error && element.error.message)));
      });
      element.src = url;
      await Promise.race([failed, new Promise((resolve) => element.addEventListener('loadeddata', resolve, {once: true}))]);
      element.currentTime = 2.8;
      await Promise.race([failed, new Promise((resolve) => element.addEventListener('seeked', resolve, {once: true}))]);
      for (let i = 0; i < 50 && element.readyState < 2; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const played = {
        currentTime: element.currentTime,
        readyState: element.readyState,
        width: element.videoWidth,
      };
      URL.revokeObjectURL(url);
      element.removeAttribute('src');
      element.load();

      const pieces = writer.pieces.length;
      const onDisk = writer.pieces.filter((piece) => piece.flushed).length;
      const bytes = await base64(file);
      await blobManager.close();
      return {
        bytes,
        size: file.size,
        pieces,
        onDisk,
        played,
        video: video.packets.map((p) => ({timestamp: p.microsecondTimestamp, key: p.type === 'key', size: p.data.byteLength})),
        audio: audio.packets.map((p) => ({timestamp: p.microsecondTimestamp, size: p.data.byteLength})),
      };
    });

    const file = probeMp4(result.bytes);
    const start = Math.min(result.video[0].timestamp, result.audio[0].timestamp);
    console.log('      mediabunny:', JSON.stringify({
      size: result.size, pieces: result.pieces, onDisk: result.onDisk, played: result.played,
      streams: file.streams, video: file.video.length, audio: file.audio.length,
      videoStart: file.video[0]?.pts, audioStart: file.audio[0]?.pts,
    }));

    expect(file.decodeErrors).toBe('');
    // Whole: the boxes fill the file exactly (ffmpeg and mp4box read a truncated file without a
    // word).
    expect(file.boxes[0]).toBe('ftyp');
    expect(file.boxes.at(-1)).toBe('mfra');
    expect(file.boxBytes).toBe(file.size);
    expect(file.streams).toEqual(['video', 'audio']);
    expect(file.width).toBe(640);
    expect(file.height).toBe(360);
    expect(file.sampleRate).toBe(44100);
    expect(file.channels).toBe(1);

    // Guards the fixtures: the audio starts first, and the video has reordered frames.
    expect(result.audio[0].timestamp).toBeLessThan(result.video[0].timestamp - 2e6);
    const inputPts = result.video.map((p) => p.timestamp);
    expect(inputPts.some((t, i) => i > 0 && t < inputPts[i - 1])).toBe(true);

    // Every sample, in order, where its packet was less the start, same size, same keyframes.
    expect(file.video.length).toBe(result.video.length);
    result.video.forEach((packet, i) => {
      expect(Math.abs(file.video[i].pts - (packet.timestamp - start) / 1e6)).toBeLessThan(PTS_TOLERANCE);
      expect(file.video[i].key).toBe(packet.key);
      expect(file.video[i].size).toBe(packet.size);
    });
    expect(file.audio.length).toBe(result.audio.length);
    result.audio.forEach((packet, i) => {
      expect(Math.abs(file.audio[i].pts - (packet.timestamp - start) / 1e6)).toBeLessThan(PTS_TOLERANCE);
      expect(file.audio[i].size).toBe(packet.size);
    });
    expect(file.audio[0].pts).toBe(0);

    // More than one piece went through FSBlob, and came back in order (the probe above
    // read every byte).
    expect(result.onDisk).toBeGreaterThan(1);
    expect(result.pieces).toBe(Math.ceil(result.size / (16 * 1024)));

    expect(result.played.width).toBe(640);
    expect(result.played.readyState).toBeGreaterThanOrEqual(2);
    expect(Math.abs(result.played.currentTime - 2.8)).toBeLessThan(0.01);
  });
});

describe('the remuxer', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  /**
   * Remuxes dash-webm's segments 2 and 3 of both tracks (VP9 and Opus in WebM, which
   * MP4Merger cannot join) as a save from the middle of the stream hands them over.
   * @param {boolean} [cancel] whether to cancel the save once its first progress comes
   * @return {Promise<Object>} the file (base64) and its input's packets, or the error
   */
  async function remuxDashWebm(cancel = false) {
    await browser.execute((cancel) => window.__cancelRemux = cancel, cancel);
    return runInPage(async () => {
      const cancel = window.__cancelRemux;
      const {Remuxer} = await import('/player/modules/remux/remuxer.mjs');
      const {ALL_FORMATS, BlobSource, EncodedPacketSink, Input} = await import('/player/modules/remux/mediabunny.mjs');
      const get = async (file) => (await fetch('/fixtures/dash-webm/' + file)).arrayBuffer();
      const fragment = (track, data) => ({track, getEntry: async () => ({getData: async () => new Blob([data])})});
      const base64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let text = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(text);
      };
      const videoInit = await get('init-stream0.webm');
      const audioInit = await get('init-stream1.webm');
      const fragments = [];
      for (const n of ['00002', '00003']) {
        fragments.push(fragment(0, await get(`chunk-stream0-${n}.webm`)));
        fragments.push(fragment(1, await get(`chunk-stream1-${n}.webm`)));
      }

      // The input's packets, as Mediabunny reads them from the same bytes.
      const packetsOf = async (init, track) => {
        const input = new Input({
          source: new BlobSource(new Blob([init, ...await Promise.all(fragments.filter((f) => f.track === track)
              .map(async (f) => (await f.getEntry()).getData()))])),
          formats: ALL_FORMATS,
        });
        const t = track === 0 ? await input.getPrimaryVideoTrack() : await input.getPrimaryAudioTrack();
        const packets = [];
        for await (const p of new EncodedPacketSink(t).packets()) {
          packets.push({timestamp: p.microsecondTimestamp, key: p.type === 'key', size: p.data.byteLength});
        }
        input.dispose();
        return packets;
      };

      let cancelSave;
      const remuxer = new Remuxer((fn) => cancelSave = fn);
      const progress = [];
      remuxer.on('progress', (value) => {
        progress.push(value);
        if (cancel) cancelSave();
      });
      try {
        const file = await remuxer.convert('video/webm', 4, videoInit, 'audio/webm', 4, audioInit, fragments);
        return {
          bytes: await base64(file),
          type: file.type,
          progress,
          video: await packetsOf(videoInit, 0),
          audio: await packetsOf(audioInit, 1),
        };
      } catch (e) {
        return {error: String(e && e.message || e), progress, destroyed: remuxer.destroyed};
      }
    });
  }

  it('copies VP9 and Opus from WebM segments into an MP4, packet for packet', async function() {
    // A copy, not a re-encode: Firefox has no WebCodecs H.264/AAC encoders on Windows.
    const result = await remuxDashWebm();
    expect(result.error).toBe(undefined);
    const file = probeMp4(result.bytes);
    const start = Math.min(result.video[0].timestamp, result.audio[0].timestamp);
    console.log('      remuxed:', JSON.stringify({type: result.type, streams: file.streams, codecs: file.codecs,
      video: file.video.length, audio: file.audio.length, inputVideo: result.video.length,
      inputAudio: result.audio.length, videoStart: file.video[0]?.pts, audioStart: file.audio[0]?.pts,
      inputVideoStart: result.video[0].timestamp / 1e6, inputAudioStart: result.audio[0].timestamp / 1e6,
      progress: result.progress.slice(-3)}));

    expect(result.type).toBe('video/mp4');
    expect(file.decodeErrors).toBe('');
    expect(file.streams).toEqual(['video', 'audio']);
    expect(file.codecs[0]).toMatch(/^vp09\./);
    expect(file.codecs[1]).toBe('Opus');
    expect(file.width).toBe(320);
    expect(file.height).toBe(180);

    // Guards the fixture: from the middle of the stream, not its start.
    expect(start).toBeGreaterThan(1e6);
    // Every packet, the same bytes (its size), keyframes kept, each where it was less the
    // save's start.
    expect(file.video.length).toBe(result.video.length);
    result.video.forEach((packet, i) => {
      expect(file.video[i].size).toBe(packet.size);
      expect(file.video[i].key).toBe(packet.key);
      expect(Math.abs(file.video[i].pts - (packet.timestamp - start) / 1e6)).toBeLessThan(PTS_TOLERANCE);
    });
    expect(file.audio.length).toBe(result.audio.length);
    result.audio.forEach((packet, i) => {
      expect(file.audio[i].size).toBe(packet.size);
      expect(Math.abs(file.audio[i].pts - (packet.timestamp - start) / 1e6)).toBeLessThan(PTS_TOLERANCE);
    });
    expect(result.progress.at(-1)).toBe(1);
  });

  it('stops a cancelled save with "Cancelled"', async function() {
    const result = await remuxDashWebm(true);
    console.log('      cancelled:', JSON.stringify(result));
    expect(result.error).toBe('Cancelled');
    expect(result.destroyed).toBe(true);
  });
});

describe('the colour picker', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('coloris opens inside the player and sets a colour', async function() {
    // coloris.mjs is patched (patches/Coloris@<version>.patch) to live in a container: this drives
    // the page's own instance, as two pickers would collide on fixed ids.
    const result = await runInPage(async () => {
      const {Coloris} = await import('/player/modules/coloris.mjs');

      const picker = document.querySelector('#clr-picker');
      if (!picker) throw new Error('the player never built its picker');

      const input = document.createElement('input');
      input.value = '#ff0000';
      document.querySelector('.mainplayer').appendChild(input);
      Coloris.bindElement(input);

      input.click();
      await new Promise((r) => setTimeout(r, 200));
      const open = picker.classList.contains('clr-open');

      const colorValue = picker.querySelector('#clr-color-value');
      colorValue.value = '#00ff00';
      colorValue.dispatchEvent(new Event('change', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 200));
      // Captured now, before the hue-slider check below changes it further.
      const boundInputValue = input.value;

      // the 6 swatches, built with createElement since the patch (addons-linter's
      // UNSAFE_VAR_ASSIGNMENT)
      const swatchButtons = Array.from(picker.querySelectorAll('#clr-swatches button'));

      // The patch also rebuilt the picker's skeleton with createElement: the format radios and
      // hidden labels are checked here.
      const formatRadios = Array.from(picker.querySelectorAll('#clr-format input[type=radio]'))
          .map((r) => ({id: r.id, value: r.value, label: picker.querySelector(`label[for="${r.id}"]`)?.textContent}));
      const openLabel = picker.querySelector('#clr-open-label');
      const swatchLabel = picker.querySelector('#clr-swatch-label');
      const colorArea = picker.querySelector('#clr-color-area');
      const hueSlider = picker.querySelector('#clr-hue-slider');

      // the rebuilt hue slider is wired into setHue(): moved, and read back
      const hueMarker = picker.querySelector('#clr-hue-marker');
      hueSlider.value = '120';
      hueSlider.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 50));

      return {
        hueMarkerLeft: hueMarker?.style.left,
        pickerColor: picker.style.color,
        formatRadios,
        openLabelHidden: openLabel?.hasAttribute('hidden'),
        openLabelText: openLabel?.textContent,
        swatchLabelText: swatchLabel?.textContent,
        colorAreaRole: colorArea?.getAttribute('role'),
        colorAreaAriaLabel: colorArea?.getAttribute('aria-label'),
        hueSliderAttrs: hueSlider && {
          type: hueSlider.type, min: hueSlider.min, max: hueSlider.max, step: hueSlider.step,
        },
        // the patch renders into the configured parent; unpatched it is document.body
        parent: picker.parentElement.className,
        open,
        value: boundInputValue,
        swatchCount: swatchButtons.length,
        firstSwatch: swatchButtons[0] && {
          text: swatchButtons[0].textContent,
          color: swatchButtons[0].style.color,
        },
      };
    });

    console.log('      coloris:', JSON.stringify(result));
    expect(result.parent).toContain('mainplayer');
    expect(result.open).toBe(true);
    expect(result.value).toBe('#00ff00');
    expect(result.swatchCount).toBe(6);
    expect(result.firstSwatch.text).toBe('rgb(255,255,255)');
    expect(result.firstSwatch.color).toBe('rgb(255, 255, 255)');

    expect(result.formatRadios).toEqual([
      {id: 'clr-f1', value: 'hex', label: 'Hex'},
      {id: 'clr-f2', value: 'rgb', label: 'RGB'},
      {id: 'clr-f3', value: 'hsl', label: 'HSL'},
    ]);
    expect(result.openLabelHidden).toBe(true);
    expect(result.openLabelText).toBe('Open color picker');
    expect(result.swatchLabelText).toBe('Color swatch');
    expect(result.colorAreaRole).toBe('application');
    expect(result.colorAreaAriaLabel).toBe(
        'Saturation and brightness selector. Use up, down, left and right arrow keys to select.',
    );
    expect(result.hueSliderAttrs).toEqual({type: 'range', min: '0', max: '360', step: '1'});
    // the CSSOM serializes hue 120 as rgb()
    expect(result.pickerColor).toBe('rgb(0, 255, 0)');
    // style.left reads back rounded
    expect(result.hueMarkerLeft).toBe('33.3333%');
  });

  it('vtt.js decodes a cue\'s character references as the textarea did, and makes no element of them', async function() {
    // vtt.mjs decodes cue texts with DOMParser; the old <textarea> way is the reference: same text,
    // no element made.
    const result = await runInPage(async () => {
      const {WebVTT} = await import('/player/modules/vtt.mjs');
      const reference = document.createElement('textarea');
      const texts = [
        'plain text, nothing to decode',
        'Tom &amp; Jerry',
        '&lt;b&gt;not bold&lt;/b&gt;',
        '&lt;/textarea&gt;&lt;img src=x onerror="window.__vttRan = true"&gt;',
        '&#233; &eacute; &#x1F600; &nbsp;| &lrm;&rlm;',
        'no semicolon &amp then &copy and &unknown; and a lone &',
        '\nstarts with a line break &amp;',
        'carriage\r\nreturns\r here',
        'a\u0000b &amp; c',
      ];
      return texts.map((text) => {
        reference.innerHTML = text;
        const tree = WebVTT.convertCueToDOMTree(window, text);
        return {text, want: reference.textContent, got: tree.textContent, elements: tree.querySelectorAll('*').length};
      }).concat([{ran: !!window.__vttRan}]);
    });
    const ran = result.pop();
    for (const {text, want, got, elements} of result) {
      expect({text, got, elements}).toEqual({text, got: want, elements: 0});
    }
    expect(ran).toEqual({ran: false});
  });

  it('vtt.js decodes every text of a cue in one parse, each as the textarea did', async function() {
    // A cue's texts are decoded together; each text decoded alone the old way is the reference.
    const result = await runInPage(async () => {
      const {WebVTT} = await import('/player/modules/vtt.mjs');
      const reference = document.createElement('textarea');
      const decode = (text) => {
        reference.innerHTML = text;
        return reference.textContent;
      };
      const cues = [
        ['Tom &amp; ', 'Jerry &lt;3', ' &eacute;t&eacute; &#x1F600;'],
        ['\nfirst &amp;', '\nsecond &lt;/textarea&gt;', 'carriage\r\nreturn &copy'],
        ['a\u0000b &amp; c', 'plain', '&unknown; &nbsp;|'],
      ];
      return cues.map((parts) => {
        const text = parts[0] + '<i>' + parts[1] + '</i><b>' + parts[2] + '</b>';
        const tree = WebVTT.convertCueToDOMTree(window, text);
        return {text, want: parts.map(decode).join(''), got: tree.textContent,
          elements: [...tree.querySelectorAll('*')].map((element) => element.localName)};
      });
    });
    for (const {text, want, got, elements} of result) {
      expect({text, got, elements}).toEqual({text, got: want, elements: ['i', 'b']});
    }
  });
});
