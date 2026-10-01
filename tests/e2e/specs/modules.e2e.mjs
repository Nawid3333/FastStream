// Exercises vendored libraries that the playback suite never reaches.
//
// The playback specs cover hls.js, dash.js and mp4box because those sit on
// the path a video takes. The encoding libraries do not: they run only when
// someone exports a GIF or remuxes a download. That gap is not theoretical -
// migrating mp4box on a "the diff only adds things" argument shipped a
// regression that no test caught, and only a real end-to-end check found it.
//
// So each library migrated from npm gets a test that makes it do its actual
// job and inspects the bytes it produces. Importing the module and finding
// its exports present proves nothing; a wrong worker URL or a broken UMD
// unwrap both import cleanly and then fail at run time.
//
// These load the modules straight from the served web build rather than
// through the player UI, because the UI paths need a loaded video, a set loop
// region and several seconds of playback to reach the same code.

import {spawnSync} from 'node:child_process';
import {browser, expect} from '@wdio/globals';
import {createFile} from 'mp4box';
import {withTempFile} from '../tempFile.mjs';

/**
 * Runs an async snippet in the page and waits for it to settle.
 *
 * `browser.execute` returns as soon as the synchronous part of the script is
 * done, so a promise-returning body would report success before the work it
 * started had finished - or failed. This parks the outcome on `window` and
 * polls for it, which reports the page-side error text instead of a bare
 * timeout when something goes wrong.
 *
 * @param {Function} fn async function to run in the page
 * @param {number} [timeout] how long to allow, in ms
 * @return {Promise<any>} whatever fn resolved with
 */
async function runInPage(fn, timeout = 60000) {
  await browser.execute((body) => {
    window.__out = undefined;
    window.__err = undefined;
    (0, eval)(`(${body})()`)
        .then((v) => {
          window.__out = v;
        })
        .catch((e) => {
          window.__err = ((e && e.message) ? e.message + '\n' : '') + ((e && e.stack) || String(e));
        });
  }, fn.toString());

  await browser.waitUntil(
      async () => browser.execute(
          () => window.__out !== undefined || window.__err !== undefined),
      {timeout, interval: 250, timeoutMsg: 'the page never settled'},
  );

  const {out, err} = await browser.execute(
      () => ({out: window.__out, err: window.__err}));
  if (err) throw new Error('page-side failure: ' + err);
  return out;
}

// How far a sample's time in a written MP4 may be from its chunk's: well under a frame
// (33 ms here) and under the gaps these tests look for, while allowing for the file's
// timescale.
const PTS_TOLERANCE = 0.0005;

/**
 * Reads an MP4 back: its tracks and samples with mp4box, and every frame decoded with
 * ffmpeg, the way a player would.
 *
 * The times come from the file's own boxes: a sample's decode time plus its composition
 * offset, less the track's edit list if it has one. ffprobe's pts would not do: for the
 * negative composition offsets a B-frame stream gets (trun version 1), ffmpeg moves every
 * pts of the track later by the largest of them, and without an edit list to say so.
 *
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
    // This is the test that matters for the gif.js migration. The npm build
    // spawns its worker from `options.workerScript`, a bare filename resolved
    // against the *document*, which in the extension is not this directory.
    // sync-vendor.mjs rewrites that to resolve from `import.meta.url`. If the
    // rewrite is wrong the worker 404s, no frame ever finishes, and render()
    // hangs rather than throwing - so a timeout here is a real failure, not
    // flakiness.
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
        // The canvas element, not its context - matching LoopMenu.mjs. gif.js
        // takes the frame size from the object it is handed, and a context
        // has no width, so passing one leaves the encoder sizeless.
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
    // mp4-muxer 5.2.2 crashed finishing a file whose video track had no packets, which is
    // why it was reverted (#25); its successor Mediabunny replaced it. The remuxer's
    // writer (mp4-writer.mjs) meets both shapes here. A video track that sends nothing
    // leaves the audio held in TimestampRebaser until finalize() flushes it, so the second
    // file checks the audio arrives, from 0: dash-list's segment 2, 2 s in.
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
    // The remuxer's writer (mp4-writer.mjs), fed packets as Mediabunny reads them. The
    // video is fmp4-bframes' second segment, from its keyframe, B-frames and all; the audio
    // is dash-list's segments 4 and 5. A save from the middle of a stream looks like this,
    // and the file must start at 0 with the video as far after the audio as it played.
    //
    // All the video goes in before any audio. Nothing may reach the file before the
    // audio's first packet says where 0 is (TimestampRebaser); moved by the video's own
    // start, the audio would begin before 0.
    //
    // The writer keeps the file in 16 KB pieces here instead of 16 MB, so it runs its
    // piece store the way a long save does: most pieces go to FSBlob and back.
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

      // And Firefox plays it: loads it, and has a frame after a seek to where both tracks
      // play. Firefox reports a fragmented file's duration as its shortest track's end, so
      // the duration is not what this checks.
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
    // Whole: the boxes fill the file exactly, up to the index at its end (ffmpeg and mp4box
    // read a file that lost its last bytes without a word).
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
    // The re-encoder this replaced decoded and re-encoded them to H.264 and AAC with
    // WebCodecs encoders, which Firefox has on no Windows: every such save failed there.
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
    // coloris.mjs is generated from a git dependency the lockfile pins by
    // commit, plus patches/Coloris@0.21.1.patch. Nothing else in the suite
    // touches the picker, and what that patch does is scope it to a
    // container element instead of the document - so this drives the page's
    // own instance, the one InterfaceController creates with
    // `parent: '.mainplayer'`, rather than standing up a second one.
    //
    // That matters for more than realism: coloris addresses its own UI by
    // fixed element ids, so two pickers in one document would collide and a
    // document-wide query would silently test the wrong one.
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

      // InterfaceController's own Coloris({...}) call configures 6 fixed
      // swatches. patches/Coloris@0.21.1.patch rewrote how these buttons get
      // built (createElement/textContent instead of a joined innerHTML
      // string, for addons-linter's UNSAFE_VAR_ASSIGNMENT), so this checks
      // that rewrite actually renders the same buttons rather than nothing.
      const swatchButtons = Array.from(picker.querySelectorAll('#clr-swatches button'));

      // patches/Coloris@0.21.1.patch also rewrote the picker's own ~40-element
      // skeleton (color area, hue/alpha sliders, the format radios, clear/
      // close buttons, the two hidden a11y label spans) from one big
      // innerHTML template into createElement calls. The rest of this test
      // already exercises colorArea/colorMarker/hueSlider/alphaSlider/
      // clearButton/closeButton/colorValue indirectly - init() would throw
      // via getEl() returning null for any of those before this point ever
      // ran - but nothing above touches the format radios or the hidden
      // labels, so check those, plus a direct attribute/class spot-check on
      // a few nodes, rather than trust the ids alone.
      const formatRadios = Array.from(picker.querySelectorAll('#clr-format input[type=radio]'))
          .map((r) => ({id: r.id, value: r.value, label: picker.querySelector(`label[for="${r.id}"]`)?.textContent}));
      const openLabel = picker.querySelector('#clr-open-label');
      const swatchLabel = picker.querySelector('#clr-swatch-label');
      const colorArea = picker.querySelector('#clr-color-area');
      const hueSlider = picker.querySelector('#clr-hue-slider');

      // Dragging the hue slider isn't simulated anywhere else, so prove the
      // rebuilt slider and its marker are actually wired into setHue() -
      // not just present with the right attributes - by moving it and
      // reading back the two things setHue() touches directly.
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
        // The patch renders the picker into the configured parent. Left
        // unpatched it attaches to document.body, so this is the assertion
        // that separates a working container rebinding from a broken one.
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
    // setHue() assigns the literal string 'hsl(120, 100%, 50%)', but the
    // CSSOM serializes style.color back out in its canonical rgb() form -
    // this is hue 120 (green), read back correctly.
    expect(result.pickerColor).toBe('rgb(0, 255, 0)');
    // Same CSSOM serialization behaviour as pickerColor above - the source
    // assigns the raw '33.33333333333333%' but style.left reads back
    // rounded.
    expect(result.hueMarkerLeft).toBe('33.3333%');
  });
});
