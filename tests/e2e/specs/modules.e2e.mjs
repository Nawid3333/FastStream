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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browser, expect} from '@wdio/globals';
import {createFile} from 'mp4box';

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
  const file = path.join(os.tmpdir(), `faststream-e2e-${process.pid}-${Date.now()}.mp4`);
  fs.writeFileSync(file, bytes);
  try {
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
      width: video?.video.width,
      height: video?.video.height,
      sampleRate: audio?.audio.sample_rate,
      channels: audio?.audio.channel_count,
      video: samplesOf('video'),
      audio: samplesOf('audio'),
    };
  } finally {
    fs.rmSync(file, {force: true});
  }
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
    // mp4-muxer 5.2.2 crashed finishing a file whose video track had no chunks, which is
    // why it was reverted (#25); its successor Mediabunny replaced it. The re-encoder's
    // writer (mp4-writer.mjs) meets both shapes here. A video encoder that puts out
    // nothing leaves the audio held in TimestampRebaser until finalize() flushes it, so
    // the second file checks the audio arrives, from 0: dash-list's segment 2, 2 s in.
    const result = await runInPage(async () => {
      const {MP4Writer} = await import('/player/modules/reencoder/mp4-writer.mjs');
      const {MP4Demuxer} = await import('/player/modules/reencoder/demuxers.mjs');
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
      const errors = [];

      const empty = new MP4Writer(blobManager, {video: true}, (e) => errors.push(String(e)));
      await empty.start();
      const emptyFile = await empty.finalize();

      const audio = new MP4Demuxer();
      audio.initialize(await get('dash-list/init-stream1.m4s'));
      audio.appendBuffer(await get('dash-list/chunk-stream1-00002.m4s'));
      const chunks = audio.getAudioChunks(true);
      // MP4Demuxer leaves the AudioSpecificConfig out (the decoder does not need it for
      // AAC); a muxer does, so it comes from the init segment's esds box.
      const entry = audio.file.getTrackById(audio.audioTrack.id).mdia.minf.stbl.stsd.entries[0];
      const decoderConfig = {
        ...audio.getAudioDecoderConfig(),
        description: entry.esds.esd.findDescriptor(4).findDescriptor(5).data,
      };
      const noVideo = new MP4Writer(blobManager, {video: true, audio: true}, (e) => errors.push(String(e)));
      await noVideo.start();
      chunks.forEach((chunk, i) => noVideo.addAudioChunk(chunk, i ? undefined : {decoderConfig}));
      const noVideoFile = await noVideo.finalize();
      await blobManager.close();

      return {
        empty: {
          size: emptyFile.size,
          boxType: new TextDecoder().decode(await emptyFile.slice(4, 8).arrayBuffer()),
        },
        noVideo: await base64(noVideoFile),
        input: chunks.map((chunk) => ({timestamp: chunk.timestamp, size: chunk.byteLength})),
        errors,
      };
    });

    console.log('      empty track:', JSON.stringify(result.empty), result.errors);
    expect(result.errors).toEqual([]);
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
    result.input.forEach((chunk, i) => {
      expect(Math.abs(file.audio[i].pts - (chunk.timestamp - first) / 1e6)).toBeLessThan(PTS_TOLERANCE);
      expect(file.audio[i].size).toBe(chunk.size);
    });
  });

  it('Mediabunny writes H.264 with B-frames and AAC from mid-stream into a file that starts at 0', async function() {
    // The re-encoder's writer (mp4-writer.mjs), fed stream-copied chunks so the file can
    // be checked packet by packet against its input on every platform: WebCodecs H.264
    // encoding is not there on every runner. The video is fmp4-bframes' second segment,
    // from its keyframe 8.4 s in, B-frames and all; the audio is dash-list's segments 4
    // and 5, from 6.037 s (both as MP4Demuxer times them, before the fixtures' edit
    // lists). A save from the middle of a stream looks like this, and the file must
    // start at 0 with the video 2.363 s after the audio, as they played.
    //
    // All the video goes in before any audio, as a video encoder that runs ahead would
    // send it. Nothing may reach the file before the audio's first chunk says where 0 is
    // (TimestampRebaser); moved by the video's own start, the audio would begin at -2.3 s.
    //
    // The writer keeps the file in 16 KB pieces here instead of 16 MB, so it runs its
    // piece store the way a long save does: most pieces go to FSBlob and back.
    const result = await runInPage(async () => {
      const {MP4Writer} = await import('/player/modules/reencoder/mp4-writer.mjs');
      const {MP4Demuxer} = await import('/player/modules/reencoder/demuxers.mjs');
      const {DataStream, Endianness} = await import('/player/modules/mp4box/mp4box.all.mjs');
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
      const entryOf = (demuxer, track) =>
        demuxer.file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];

      // MP4Demuxer's configs have no description, which a muxer needs: the avcC and the
      // AudioSpecificConfig come from the init segments.
      const video = new MP4Demuxer();
      video.initialize(await get('fmp4-bframes/init-stream0.m4s'));
      video.appendBuffer(await get('fmp4-bframes/chunk-stream0-00002.m4s'));
      const videoChunks = video.getVideoChunks(true);
      const avcC = new DataStream();
      avcC.endianness = Endianness.BIG_ENDIAN;
      entryOf(video, video.videoTrack).avcC.write(avcC);
      const videoConfig = {
        ...video.getVideoDecoderConfig(),
        description: new Uint8Array(avcC.buffer, 8),
      };

      const audio = new MP4Demuxer();
      audio.initialize(await get('dash-list/init-stream1.m4s'));
      audio.appendBuffer(await get('dash-list/chunk-stream1-00004.m4s'));
      audio.appendBuffer(await get('dash-list/chunk-stream1-00005.m4s'));
      const audioChunks = audio.getAudioChunks(true);
      const audioConfig = {
        ...audio.getAudioDecoderConfig(),
        description: entryOf(audio, audio.audioTrack).esds.esd.findDescriptor(4).findDescriptor(5).data,
      };

      const blobManager = new FSBlob();
      const errors = [];
      const writer = new MP4Writer(blobManager, {video: true, audio: true}, (e) => errors.push(String(e)), 16 * 1024);
      await writer.start();
      videoChunks.forEach((chunk, i) => writer.addVideoChunk(chunk, i ? undefined : {decoderConfig: videoConfig}));
      audioChunks.forEach((chunk, i) => writer.addAudioChunk(chunk, i ? undefined : {decoderConfig: audioConfig}));
      const file = await writer.finalize();

      // And Firefox plays it: loads it, and has a frame after a seek to where both tracks
      // play (video from 2.363 s, audio to 2.986 s). Firefox reports a fragmented file's
      // duration as its shortest track's end, for mp4-muxer 4.3.3's files as for these, so
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
        errors,
        video: videoChunks.map((c) => ({timestamp: c.timestamp, key: c.type === 'key', size: c.byteLength})),
        audio: audioChunks.map((c) => ({timestamp: c.timestamp, size: c.byteLength})),
      };
    });

    const file = probeMp4(result.bytes);
    const start = Math.min(result.video[0].timestamp, result.audio[0].timestamp);
    console.log('      mediabunny:', JSON.stringify({
      size: result.size, pieces: result.pieces, onDisk: result.onDisk, played: result.played,
      streams: file.streams, video: file.video.length, audio: file.audio.length,
      videoStart: file.video[0]?.pts, audioStart: file.audio[0]?.pts,
    }), result.errors);

    expect(result.errors).toEqual([]);
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
    const inputPts = result.video.map((c) => c.timestamp);
    expect(inputPts.some((t, i) => i > 0 && t < inputPts[i - 1])).toBe(true);

    // Every sample, in order, where its chunk was less the start, same size, same keyframes.
    expect(file.video.length).toBe(result.video.length);
    result.video.forEach((chunk, i) => {
      expect(Math.abs(file.video[i].pts - (chunk.timestamp - start) / 1e6)).toBeLessThan(PTS_TOLERANCE);
      expect(file.video[i].key).toBe(chunk.key);
      expect(file.video[i].size).toBe(chunk.size);
    });
    expect(file.audio.length).toBe(result.audio.length);
    result.audio.forEach((chunk, i) => {
      expect(Math.abs(file.audio[i].pts - (chunk.timestamp - start) / 1e6)).toBeLessThan(PTS_TOLERANCE);
      expect(file.audio[i].size).toBe(chunk.size);
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

describe('the re-encoder', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  /**
   * Re-encodes fmp4-bframes' two segments with fake codecs and reports how it ended.
   *
   * The decoder turns each chunk into a small real VideoFrame, a task later, as a
   * decoder does. The encoder fails as window.__encoderFails says: 'error' fails the
   * first frame the way WebCodecs fails an encoder (closed, then the error callback, in
   * one task of their own); 'delta' puts out a delta chunk first, which the MP4 writer
   * refuses. Fakes, so every platform takes the same path.
   *
   * @return {Promise<Object>} {outcome, ms, destroyed, openCodecs, codecs, framesEncoded}:
   *     outcome is {name, message} for a rejection, {resolved: true}, or {hung: true}
   *     after 20 s; framesEncoded how many frames the encoder took (the video has 300)
   */
  function reencodeWithFailingEncoder() {
    return runInPage(async () => {
      const {Reencoder} = await import('/player/modules/reencoder/reencoder.mjs');
      const {AlertPolyfill} = await import('/player/utils/AlertPolyfill.mjs');
      AlertPolyfill.confirm = async () => true;

      const canvas = new OffscreenCanvas(16, 16);
      canvas.getContext('2d').fillRect(0, 0, 16, 16);
      const codecs = [];
      let framesEncoded = 0;
      const invalid = (what, codec) => new DOMException(`${what} on a ${codec.state} codec`, 'InvalidStateError');
      class FakeDecoder {
        static isConfigSupported(config) {
          return Promise.resolve({supported: true, config});
        }
        constructor({output}) {
          this.output = output;
          this.state = 'unconfigured';
          this.decodeQueueSize = 0;
          this.pending = Promise.resolve();
          codecs.push(this);
        }
        configure() {
          this.state = 'configured';
        }
        decode(chunk) {
          if (this.state !== 'configured') throw invalid('decode', this);
          this.decodeQueueSize++;
          const timestamp = chunk.timestamp;
          this.pending = this.pending.then(() => new Promise((resolve) => setTimeout(resolve))).then(() => {
            this.decodeQueueSize--;
            if (this.state === 'configured') {
              this.output(new VideoFrame(canvas, {timestamp}));
            }
          });
        }
        flush() {
          return this.state === 'configured' ? this.pending : Promise.reject(invalid('flush', this));
        }
        close() {
          if (this.state === 'closed') throw invalid('close', this);
          this.state = 'closed';
        }
      }
      class FailingEncoder {
        static isConfigSupported(config) {
          return Promise.resolve({supported: true, config});
        }
        constructor({output, error}) {
          this.output = output;
          this.error = error;
          this.state = 'unconfigured';
          this.encodeQueueSize = 0;
          codecs.push(this);
        }
        configure() {
          this.state = 'configured';
        }
        encode(frame) {
          if (this.state !== 'configured') throw invalid('encode', this);
          framesEncoded++;
          const timestamp = frame.timestamp;
          this.encodeQueueSize++;
          setTimeout(() => {
            this.encodeQueueSize--;
            if (this.state !== 'configured') return;
            if (window.__encoderFails === 'error') {
              this.state = 'closed';
              this.error(new DOMException('the fake encoder failed', 'EncodingError'));
            } else {
              this.output(new EncodedVideoChunk({type: 'delta', timestamp, data: new Uint8Array(8)}), {
                decoderConfig: {
                  codec: 'avc1.42001e', codedWidth: 16, codedHeight: 16,
                  description: new Uint8Array([1, 0x42, 0, 0x1e, 0xff, 0xe0, 0]),
                },
              });
            }
          });
        }
        flush() {
          return this.state === 'configured' ? Promise.resolve() : Promise.reject(invalid('flush', this));
        }
        close() {
          if (this.state === 'closed') throw invalid('close', this);
          this.state = 'closed';
        }
      }
      window.VideoDecoder = FakeDecoder;
      window.VideoEncoder = FailingEncoder;

      const get = async (file) => (await fetch('/fixtures/' + file)).arrayBuffer();
      const fragment = (file) => ({track: 0, getEntry: async () => ({getData: async () => new Blob([file])})});
      const init = await get('fmp4-bframes/init-stream0.m4s');
      const fragments = [
        fragment(await get('fmp4-bframes/chunk-stream0-00001.m4s')),
        fragment(await get('fmp4-bframes/chunk-stream0-00002.m4s')),
      ];

      const reencoder = new Reencoder(() => {});
      const t0 = performance.now();
      const outcome = await Promise.race([
        reencoder.convert('video/mp4', 10, init, '', 0, null, fragments).then(
            () => ({resolved: true}),
            (e) => ({name: e && e.name, message: String(e && e.message)})),
        new Promise((resolve) => setTimeout(() => resolve({hung: true}), 20000)),
      ]);
      return {
        outcome,
        ms: Math.round(performance.now() - t0),
        destroyed: reencoder.destroyed === true,
        openCodecs: codecs.filter((codec) => codec.state !== 'closed').length,
        codecs: codecs.length,
        framesEncoded,
      };
    }, 40000);
  }

  it('ends the save with the encoder\'s error instead of waiting forever', async function() {
    // Firefox on Windows fails H.264 encoding of the re-encoder's frames with an
    // EncodingError. A codec that fails closes itself and puts out nothing more, and
    // pushFragment() waited for its output: the save hung where it was, and the error
    // handler's own close() threw on the closed codec. Now the save fails with the
    // encoder's error, and the codecs are closed.
    await browser.execute(() => {
      window.__encoderFails = 'error';
    });
    const result = await reencodeWithFailingEncoder();
    console.log('      encoder error:', JSON.stringify(result));
    expect(result.outcome).toEqual({name: 'EncodingError', message: 'the fake encoder failed'});
    expect(result.framesEncoded).toBeLessThan(50);
    expect(result.destroyed).toBe(true);
    expect(result.codecs).toBe(2);
    expect(result.openCodecs).toBe(0);
  });

  it('ends the save with the MP4 writer\'s error when Mediabunny refuses a chunk', async function() {
    // Mediabunny rejects add() for a chunk it cannot take (here a first chunk that is
    // not a keyframe); the writer hands that to the re-encoder, which ends the save
    // with it at once instead of encoding the rest for a file that cannot be written.
    await browser.execute(() => {
      window.__encoderFails = 'delta';
    });
    const result = await reencodeWithFailingEncoder();
    console.log('      writer error:', JSON.stringify(result));
    expect(result.outcome.message).toContain('key packet');
    // At once, not after the other 299 frames were encoded for nothing.
    expect(result.framesEncoded).toBeLessThan(50);
    expect(result.destroyed).toBe(true);
    expect(result.openCodecs).toBe(0);
  });
});

describe('vendored demuxers', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  it('webm.mjs demuxes a real VP9 stream', async function() {
    // Every change in patches/jswebm@0.1.2.patch is exercised here, which is
    // the point: webm.mjs stopped being a hand-made blob and became jswebm's
    // published sources plus that patch, and nothing else in the suite
    // touches this code path.
    //
    // demux()'s boolean return is the one to watch. Upstream returns
    // nothing, so WebMDemuxer.process() - `while (this.demuxer.demux())` -
    // stops on the first call and the demuxer yields no packets at all.
    // Verified by removing the return and watching this fail; a test that
    // only imported the module would not notice.
    const result = await runInPage(async () => {
      const {WebMDemuxer} =
        await import('/player/modules/reencoder/demuxers.mjs');
      const bytes = new Uint8Array(
          await (await fetch('/fixtures/sample.webm')).arrayBuffer());

      const demuxer = new WebMDemuxer();
      demuxer.initialize(bytes.buffer);
      const config = demuxer.getVideoDecoderConfig();
      const chunks = demuxer.getVideoChunks(10);
      return {
        codec: config && config.codec,
        width: config && config.codedWidth,
        height: config && config.codedHeight,
        chunks: chunks.length,
        keyframes: chunks.filter((c) => c.type === 'key').length,
      };
    });

    console.log('      webm:', JSON.stringify(result));
    // The full codec string comes from initVp9Headers, which reads the VP9
    // profile out of the first frame. Upstream jswebm reports a bare "vp9",
    // which WebCodecs rejects as an incomplete codec string.
    expect(result.codec).toMatch(/^vp09\.\d\d\.\d\d\.\d\d/);
    expect(result.width).toBe(160);
    expect(result.height).toBe(120);
    expect(result.chunks).toBeGreaterThan(0);
    // Chunk types come from `isKeyframe`, which upstream sets from a
    // misspelled field and so leaves undefined on every frame.
    expect(result.keyframes).toBeGreaterThan(0);
  });

  it('MP4Demuxer (mp4box) demuxes fragmented MP4 the way the re-encoder feeds it', async function() {
    // The re-encoder (reencoder.mjs) demuxes MP4 through mp4box: an initialization
    // segment, then media segments, then the samples it extracted. That reads more of
    // mp4box's API than anything else - getInfo()'s track fields, sample extraction,
    // releaseSample - and it depends on `samples_stored`, which patches/mp4box@*.patch
    // adds: every sample getSample() loaded, so exactly those can be handed on and freed.
    // Nothing else in the suite runs this code.
    //
    // The video is fmp4-bframes (wdio.conf.mjs): sample.mp4's own H.264, 300 frames, 2 of
    // them keyframes and 250 B-frames, the same bytes on every platform. B-frames are the
    // point: samples come in decode order, so a chunk's duration cannot be the gap to the
    // next sample's presentation time - that goes negative, and EncodedVideoChunk throws.
    // The audio is the first two segments of dash-list: 4 s of 44.1 kHz mono AAC.
    const result = await runInPage(async () => {
      const {MP4Demuxer} = await import('/player/modules/reencoder/demuxers.mjs');
      const get = async (file) => (await fetch('/fixtures/' + file)).arrayBuffer();

      const video = new MP4Demuxer();
      video.initialize(await get('fmp4-bframes/init-stream0.m4s'));
      video.appendBuffer(await get('fmp4-bframes/chunk-stream0-00001.m4s'));
      video.appendBuffer(await get('fmp4-bframes/chunk-stream0-00002.m4s'));
      const videoConfig = video.getVideoDecoderConfig();
      const videoChunks = video.getVideoChunks(true);
      const videoTrak = video.file.getTrackById(video.videoTrack.id);
      const released = videoTrak.samples_stored.slice(0, -1);
      video.clearChunks();
      const timestamps = videoChunks.map((c) => c.timestamp);

      const audio = new MP4Demuxer();
      audio.initialize(await get('dash-list/init-stream1.m4s'));
      audio.appendBuffer(await get('dash-list/chunk-stream1-00001.m4s'));
      audio.appendBuffer(await get('dash-list/chunk-stream1-00002.m4s'));
      const audioConfig = audio.getAudioDecoderConfig();
      const audioChunks = audio.getAudioChunks(true);

      return {
        videoCodec: videoConfig.codec,
        width: videoConfig.codedWidth,
        height: videoConfig.codedHeight,
        videoChunks: videoChunks.length,
        keyframes: videoChunks.filter((c) => c.type === 'key').length,
        firstIsKey: videoChunks[0]?.type === 'key',
        reordered: timestamps.some((t, i) => i > 0 && t < timestamps[i - 1]),
        distinctTimestamps: new Set(timestamps).size,
        videoSeconds: videoChunks.reduce((sum, c) => sum + c.duration, 0) / 1e6,
        storedAfterClear: videoTrak.samples_stored.length,
        releasedStillHoldData: released.filter((s) => s.data).length,
        audioCodec: audioConfig.codec,
        sampleRate: audioConfig.sampleRate,
        channels: audioConfig.numberOfChannels,
        audioChunks: audioChunks.length,
        audioSeconds: audioChunks.reduce((sum, c) => sum + c.duration, 0) / 1e6,
      };
    });

    console.log('      mp4:', JSON.stringify(result));
    expect(result.videoCodec).toMatch(/^avc1./);
    expect(result.width).toBe(640);
    expect(result.height).toBe(360);
    expect(result.videoChunks).toBe(300);
    expect(result.keyframes).toBe(2);
    expect(result.firstIsKey).toBe(true);
    // Guards the fixture: without reordered frames this test proves much less.
    expect(result.reordered).toBe(true);
    expect(result.distinctTimestamps).toBe(300);
    expect(Math.abs(result.videoSeconds - 10)).toBeLessThan(0.1);
    // clearChunks() keeps the last sample, which getVideoChunks() holds back until its
    // final call, and releases the data of every other one.
    expect(result.storedAfterClear).toBe(1);
    expect(result.releasedStillHoldData).toBe(0);
    expect(result.audioCodec).toMatch(/^mp4a./);
    expect(result.sampleRate).toBe(44100);
    expect(result.channels).toBe(1);
    expect(result.audioChunks).toBeGreaterThan(0);
    expect(Math.abs(result.audioSeconds - 4)).toBeLessThan(0.2);
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

describe('the audio resampler', function() {
  beforeEach(async function() {
    await browser.url('/player/index.html?t=' + Date.now());
  });

  /**
   * Runs a snippet inside a module Worker and returns what it posts back.
   *
   * libsamplerate cannot be exercised from the page. Its glue is built with
   * `BINARYEN_ASYNC_COMPILATION=0`, so it instantiates the wasm synchronously
   * and reads it with a blocking XHR - which only exists in a worker. Loading
   * it from a window throws "sync fetching of the wasm failed" before any of
   * the library's own code runs.
   *
   * That is also how the product loads it: `reencoder.mjs` spawns
   * `resampler-worker.mjs`. The worker cannot be driven directly here because
   * its protocol takes `AudioData`, which is WebCodecs and absent in Firefox,
   * so this stands up an equivalent worker around the same module.
   *
   * @param {string} body worker source; posts its result with postMessage
   * @param {number} [timeout] how long to allow, in ms
   * @return {Promise<any>} whatever the worker posted
   */
  async function runInWorker(body, timeout = 60000) {
    await browser.execute((src) => {
      window.__out = undefined;
      window.__err = undefined;
      const url = URL.createObjectURL(
          new Blob([src], {type: 'text/javascript'}));
      const worker = new Worker(url, {type: 'module'});
      worker.onmessage = (e) => {
        window.__out = e.data;
      };
      // A module worker reports a failed import as an ErrorEvent with an
      // empty message, so record whatever detail there is rather than
      // letting the poll below time out with nothing to show.
      worker.onerror = (e) => {
        window.__err = 'worker error: ' + (e.message || '(no message)') +
          ' at ' + (e.filename || '?') + ':' + (e.lineno || '?');
      };
    }, body);

    await browser.waitUntil(
        async () => browser.execute(
            () => window.__out !== undefined || window.__err !== undefined),
        {timeout, interval: 250, timeoutMsg: 'the worker never settled'},
    );

    const {out, err} = await browser.execute(
        () => ({out: window.__out, err: window.__err}));
    if (err) throw new Error(err);
    if (out && out.error) throw new Error('worker-side failure: ' + out.error);
    return out;
  }

  const MODULE = '/player/modules/reencoder/libsamplerate.mjs';

  it('resamples 48 kHz to 44.1 kHz and keeps the tone', async function() {
    const result = await runInWorker(`
      const IN_RATE = 48000;
      const OUT_RATE = 44100;
      const FREQ = 440;
      (async () => {
        try {
          const m = await import(location.origin + '${MODULE}');
          const input = new Float32Array(IN_RATE);
          for (let i = 0; i < input.length; i++) {
            input[i] = Math.sin(2 * Math.PI * FREQ * i / IN_RATE);
          }
          const r = await m.create(1, IN_RATE, OUT_RATE, {
            converterType: m.ConverterType.SRC_SINC_MEDIUM_QUALITY,
          });
          const output = r.full(input);
          r.destroy();

          let peak = 0;
          let sumSquares = 0;
          for (let i = 0; i < output.length; i++) {
            peak = Math.max(peak, Math.abs(output[i]));
            sumSquares += output[i] * output[i];
          }
          const rms = Math.sqrt(sumSquares / output.length);
          // A clean sine crosses zero exactly twice per cycle, so counting
          // sign changes recovers its frequency without an FFT. That is
          // enough to catch the failures that matter - silence, a copy of
          // the input at the wrong rate, or garbage - and unlike a spectral
          // check it needs no windowing and has no leakage to reason about.
          let crossings = 0;
          for (let i = 1; i < output.length; i++) {
            if ((output[i - 1] < 0) !== (output[i] < 0)) crossings++;
          }
          const seconds = output.length / OUT_RATE;
          postMessage({
            length: output.length,
            peak,
            rms,
            hz: Math.round(crossings / 2 / seconds),
          });
        } catch (e) {
          postMessage({error: (e && e.stack) || String(e)});
        }
      })();
    `);

    console.log('      resampler:', JSON.stringify(result));
    // One second in must be one second out, at the new rate.
    expect(result.length).toBeGreaterThan(44000);
    expect(result.length).toBeLessThan(44200);
    // Not silence, and not clipped or scaled.
    expect(result.peak).toBeGreaterThan(0.9);
    expect(result.peak).toBeLessThan(1.1);
    // Still a sine, not merely something with the right period. A sine of
    // peak 1 has an RMS of 1/sqrt(2); a square wave of peak 1 has an RMS of
    // 1, and would otherwise satisfy every other assertion here.
    expect(result.rms).toBeGreaterThan(0.70);
    expect(result.rms).toBeLessThan(0.71);
    // The tone survived the conversion.
    expect(result.hz).toBeGreaterThan(435);
    expect(result.hz).toBeLessThan(445);
  });

  it('pins which converter types this wasm build can actually run',
      async function() {
        // The vendored wasm is 117 KB where the published one is 1.5 MB, and
        // this is where the difference shows: only three of the five
        // converters produce audio. SRC_SINC_BEST_QUALITY and
        // SRC_SINC_FASTEST construct without error and then return 2 frames
        // for 48000 in, which is what an absent coefficient table looks like
        // from JavaScript - the module's own validation accepts all five, so
        // nothing before this test could tell them apart.
        //
        // Order-independent: probing them in a different sequence gives the
        // same answer, so this is the build, not leaked state between
        // instances.
        //
        // FastStream only ever asks for SRC_SINC_MEDIUM_QUALITY, so the
        // product is unaffected - but swapping this wasm for a stock build
        // would silently change resampling quality, and this pins it.
        const result = await runInWorker(`
      (async () => {
        try {
          const m = await import(location.origin + '${MODULE}');
          const order = ['SRC_SINC_MEDIUM_QUALITY', 'SRC_SINC_BEST_QUALITY',
            'SRC_SINC_FASTEST', 'SRC_ZERO_ORDER_HOLD', 'SRC_LINEAR'];
          const input = new Float32Array(48000);
          for (let i = 0; i < input.length; i++) {
            input[i] = Math.sin(2 * Math.PI * 440 * i / 48000);
          }
          const support = {};
          for (const name of order) {
            try {
              const r = await m.create(1, 48000, 44100, {
                converterType: m.ConverterType[name],
              });
              const out = r.full(input);
              r.destroy();
              // The length is reported, not asserted. 48000 frames at this
              // ratio is 44100 exactly, but a sinc converter cannot emit the
              // tail it has no future input for, so each converter returns a
              // slightly different count. Recording them shows how much of
              // the shortfall is filter delay rather than lost audio.
              support[name] = out.length > 0 ? 'ok ' + out.length : 'empty';
            } catch (e) {
              support[name] = 'failed: ' + ((e && e.message) || e);
            }
          }
          postMessage(support);
        } catch (e) {
          postMessage({error: (e && e.stack) || String(e)});
        }
      })();
    `);

        console.log('      converters:', JSON.stringify(result));
        // The three that work, including the one the product uses. The other
        // two are recorded above rather than asserted, so that shipping a
        // fuller wasm later is not a test failure.
        expect(result.SRC_SINC_MEDIUM_QUALITY).toBe('ok 44054');
        expect(result.SRC_ZERO_ORDER_HOLD).toBe('ok 44100');
        expect(result.SRC_LINEAR).toBe('ok 44100');
      });
});
