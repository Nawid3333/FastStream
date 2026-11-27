// @ts-check
import {DownloadStatus} from '../enums/DownloadStatus.mjs';
import {PlayerModes} from '../enums/PlayerModes.mjs';
import {Fragment} from '../players/Fragment.mjs';
import {StorageModes, storageModeOf} from '../options/StorageMode.mjs';
import {NearPx} from './PreviewSeeks.mjs';
import {PreviewThumbnails, nextKeyframe, thumbnailSpacing} from './PreviewThumbnails.mjs';

/** @typedef {import('./PreviewThumbnails.mjs').Thumbnail} Thumbnail */

// The seek preview box's height in CSS px (fluidplayer.css, .seek_preview_video).
const BoxHeightPx = 100;
// The RAM the pictures may take; "Disk only" keeps less in RAM.
export const ThumbnailBudget = 16e6;
export const DiskOnlyThumbnailBudget = 4e6;
// Between two pictures made in the background: the decoder may be the video's too.
export const BackgroundGapMs = 100;
// A decoder with nothing to do lets go of its memory after this.
const DecoderIdleMs = 2000;
// Failures in a row after which this video gets no more pictures.
const FailuresToStop = 3;

// Segments that each begin with a keyframe and demux on their own (with the level's init segment), and progressive
// files whose keyframes the MP4 player knows.
const Modes = [PlayerModes.ACCELERATED_HLS, PlayerModes.ACCELERATED_DASH, PlayerModes.ACCELERATED_VM,
  PlayerModes.ACCELERATED_MP4];

class UnsupportedVideo extends Error {}
// A part let go of (the RAM budget) or a range not downloaded: no failure of the decoder's.
class NotStored extends Error {}

/** @typedef {{time: number, image: ImageBitmap, bytes: number}} Made */
/** @typedef {{offset: number, size: number, cts: number, timescale: number}} Sample */

/**
 * @param {Array<Fragment|undefined>} fragments - A progressive file's parts, partSize bytes each.
 * @param {number} offset
 * @param {number} size
 * @param {number} partSize
 * @return {boolean} Every part holding the bytes is downloaded.
 */
function storedRange(fragments, offset, size, partSize) {
  for (let i = Math.floor(offset / partSize); i * partSize < offset + size; i++) {
    if (fragments[i]?.status !== DownloadStatus.DOWNLOAD_COMPLETE) return false;
  }
  return true;
}

/** @type {?Promise<typeof import('../modules/remux/mediabunny.mjs')>} */
let mediabunny = null;

/**
 * @param {{ramBudget: number, bufferToDisk?: boolean}} options
 * @return {number} Bytes.
 */
export function thumbnailBudget(options) {
  return storageModeOf(options) === StorageModes.DISK_ONLY ? DiskOnlyThumbnailBudget : ThumbnailBudget;
}

/**
 * A picture's size: the preview box's height in device pixels (at most twice), the video's shape.
 * @param {number} width - The video's display width.
 * @param {number} height
 * @param {number} pixelRatio
 * @return {{width: number, height: number}}
 */
export function thumbnailSize(width, height, pixelRatio) {
  const tall = Math.round(BoxHeightPx * Math.min(Math.max(pixelRatio || 1, 1), 2));
  return {width: Math.max(1, Math.round(tall * width / Math.max(1, height))), height: tall};
}

/**
 * @param {?VideoDecoderConfig} a
 * @param {VideoDecoderConfig} b
 * @return {boolean}
 */
function sameConfig(a, b) {
  if (!a || a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const bytesOf = (/** @type {AllowSharedBufferSource|undefined} */ d) => !d ? new Uint8Array(0) :
    ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
  const x = bytesOf(a.description);
  const y = bytesOf(b.description);
  return x.length === y.length && x.every((byte, i) => byte === y[i]);
}

/**
 * Pictures of the buffered video's keyframes for the seek preview, made with WebCodecs from the parts the players
 * downloaded (nothing is downloaded for them): a pointer on a buffered place shows one at once, before the preview
 * player's exact frame comes.
 *
 * One decode at a time, BackgroundGapMs apart; the pointer's place goes first. HLS and DASH segments (TS, fMP4,
 * WebM: what Mediabunny demuxes) and progressive MP4; a direct video, a codec the decoder does not take, or no
 * WebCodecs (Firefox for Android) leaves the preview as it was.
 */
export class PreviewThumbnailer {
  /** @return {boolean} */
  static supported() {
    return typeof VideoDecoder === 'function' && typeof createImageBitmap === 'function';
  }

  /**
   * @param {import('../FastStreamClient.mjs').FastStreamClient} client
   * @param {HTMLElement} box - The seek preview's box: a picture shows over its video.
   */
  constructor(client, box) {
    this.client = client;
    this.box = box;
    this.canvas = box.ownerDocument.createElement('canvas');
    this.canvas.classList.add('seek_preview_thumbnail');
    this.source = client.player?.getSource() ?? null;
    this.thumbnails = new PreviewThumbnails(thumbnailBudget(client.options));
    /** @type {WeakSet<Fragment|Sample>} The segments and a file's keyframes tried, with a picture or without. */
    this.tried = new WeakSet();
    /** @type {?{config: VideoDecoderConfig, keyframes: Sample[], partSize: number}} A progressive file's. */
    this.fileIndex = null;
    /** @type {?number} */
    this.pointer = null;
    this.running = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.timer = null;
    this.failures = 0;
    this.stopped = !Modes.includes(this.source?.mode ?? '');
    /** @type {?VideoDecoder} */
    this.decoder = null;
    /** @type {?VideoDecoderConfig} */
    this.decoderConfig = null;
    /** @type {VideoFrame[]} */
    this.frames = [];
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    this.decoderIdle = undefined;
    // A picture's bytes, known from the first one.
    this.bytesEach = 0;
    /** @type {Map<Fragment, Promise<Uint8Array>>} The levels' init segments, read once. */
    this.inits = new Map();
    /** @type {?Thumbnail} */
    this.drawn = null;
  }

  /** Downloaded parts may have changed: the pointer's picture at once, any other after the gap. */
  wake() {
    if (this.stopped || this.running) return;
    if (this.pointerNeeds()) {
      clearTimeout(/** @type {*} */ (this.timer));
      this.timer = null;
      this.run();
    } else if (this.timer === null) {
      this.timer = setTimeout(() => this.run(), BackgroundGapMs);
    }
  }

  /** @return {boolean} The pointer's place has no picture as near as a downloaded keyframe would give. */
  pointerNeeds() {
    if (this.pointer === null) return false;
    // Pictures as dense as they are made: nothing to hurry (and no search on every pointer move).
    if (!(this.thumbnails.gap(this.pointer) > this.measures().spacing / 2)) return false;
    return !!this.nextJob()?.urgent;
  }

  /**
   * The pointer is on a place: its picture first.
   * @param {number} time
   */
  point(time) {
    this.pointer = time;
    this.wake();
  }

  /**
   * @param {number} time
   * @return {?Thumbnail} The picture that belongs at the place (within NearPx of it).
   */
  near(time) {
    return this.thumbnails.near(time, (a, b) => this.client.previewPxApart(a, b));
  }

  /** @return {{spacing: number, near: number}} Seconds. */
  measures() {
    const client = this.client;
    const perSecond = client.previewPxApart(0, 1);
    const duration = client.duration;
    if (!Number.isFinite(perSecond) || !(perSecond > 0)) return {spacing: Infinity, near: 0};
    const bytesEach = this.bytesEach || 4 * BoxHeightPx * BoxHeightPx * 16 / 9;
    return {
      spacing: thumbnailSpacing({duration, width: perSecond * duration, bytesEach, budget: this.thumbnails.budget}),
      near: NearPx / perSecond,
    };
  }

  /**
   * The keyframes of downloaded parts with no picture tried yet: a segment's first (HLS, DASH), or each of a
   * progressive file's whose bytes are all downloaded (MP4Player.previewKeyframes).
   * @return {Array<{time: number, part: Fragment|Sample}>}
   */
  candidates() {
    const client = this.client;
    if (client.player?.getSource() !== this.source) return [];
    const level = client.getCurrentVideoLevelID();
    const fragments = level === null ? null : client.getFragments(level);
    if (!fragments) return [];
    /** @type {Array<{time: number, part: Fragment|Sample}>} */
    const candidates = [];
    if (this.source?.mode === PlayerModes.ACCELERATED_MP4) {
      const index = /** @type {*} */ (client.player).previewKeyframes?.() ?? null;
      this.fileIndex = index;
      for (const sample of index?.keyframes ?? []) {
        if (!this.tried.has(sample) && storedRange(fragments, sample.offset, sample.size, index.partSize)) {
          candidates.push({time: sample.cts / sample.timescale, part: sample});
        }
      }
      return candidates;
    }
    // An fMP4 or WebM level's parts demux only with its init segment.
    const init = fragments[-1];
    if (init && init.status !== DownloadStatus.DOWNLOAD_COMPLETE) return candidates;
    for (const fragment of fragments) {
      if (fragment && fragment.sn >= 0 && fragment.start >= 0 && fragment.status === DownloadStatus.DOWNLOAD_COMPLETE &&
          !this.tried.has(fragment)) {
        candidates.push({time: fragment.start, part: fragment});
      }
    }
    return candidates;
  }

  /** @return {?{part: Fragment|Sample, urgent: boolean}} */
  nextJob() {
    try {
      const {spacing, near} = this.measures();
      if (!Number.isFinite(spacing)) return null;
      const pointer = this.pointer;
      const pick = nextKeyframe(this.candidates(), this.thumbnails,
          {spacing, near, pointer, playhead: this.client.currentTime});
      if (!pick) return null;
      const urgent = pointer !== null && Math.abs(pick.time - pointer) <= near &&
        Math.abs(pick.time - pointer) < this.thumbnails.gap(pointer);
      return {part: pick.part, urgent};
    } catch (e) {
      // Called from the players' events and the pointer's moves: an extra never throws into them.
      console.warn('No seek preview pictures for this video', e);
      this.stop();
      return null;
    }
  }

  async run() {
    this.timer = null;
    if (this.stopped || this.running) return;
    const job = this.nextJob();
    if (!job) {
      this.idle();
      return;
    }
    this.running = true;
    try {
      this.tried.add(job.part);
      const made = job.part instanceof Fragment ? await this.fromSegment(job.part) :
        await this.fromFile(/** @type {Sample} */ (job.part));
      if (this.stopped) {
        made?.image.close();
        return;
      }
      this.failures = 0;
      if (made) {
        const thumbnail = this.thumbnails.add(made.time, made.image, made.bytes);
        if (this.pointer !== null && this.near(this.pointer) === thumbnail) this.client.updatePreview();
      }
    } catch (e) {
      if (this.stopped) return;
      if (e instanceof UnsupportedVideo || (!(e instanceof NotStored) && ++this.failures >= FailuresToStop)) {
        console.warn('No seek preview pictures for this video', e);
        this.stop();
        return;
      }
      if (!(e instanceof NotStored)) console.warn('A seek preview picture failed', e);
    } finally {
      this.running = false;
    }
    if (!this.stopped) this.wake();
  }

  /**
   * @param {Fragment|undefined} fragment
   * @return {Promise<Uint8Array>}
   */
  async read(fragment) {
    const entry = fragment && this.client.downloadManager.getEntry(fragment.getContext());
    if (!entry) throw new NotStored('The part is no longer stored');
    const data = await entry.getDataFromBlob('arraybuffer');
    return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
      new Uint8Array(/** @type {ArrayBuffer} */ (data));
  }

  /**
   * The picture of a segment's first keyframe, demuxed with its level's init segment.
   * @param {Fragment} fragment
   * @return {Promise<?Made>} None for a segment without a keyframe.
   */
  async fromSegment(fragment) {
    const init = this.client.getFragment(fragment.level, -1);
    mediabunny ??= import('../modules/remux/mediabunny.mjs');
    const {ALL_FORMATS, BufferSource, EncodedPacketSink, Input} = await mediabunny;
    let initRead = init ? this.inits.get(init) : null;
    if (init && !initRead) {
      initRead = this.read(init);
      this.inits.set(init, initRead);
      initRead.catch(() => this.inits.delete(init));
    }
    const head = initRead ? await initRead : null;
    const part = await this.read(fragment);
    let bytes = part;
    if (head) {
      bytes = new Uint8Array(head.length + part.length);
      bytes.set(head);
      bytes.set(part, head.length);
    }
    const input = new Input({source: new BufferSource(bytes), formats: ALL_FORMATS});
    try {
      const track = await input.getPrimaryVideoTrack();
      const config = track && await track.getDecoderConfig();
      if (!track || !config) throw new UnsupportedVideo('No video track Mediabunny can read');
      const sink = new EncodedPacketSink(track);
      const first = await sink.getFirstPacket();
      const key = first && (first.type === 'key' ? first : await sink.getNextKeyPacket(first));
      if (!first || !key) return null;
      return await this.picture(config, key.toEncodedVideoChunk(),
          fragment.start + Math.max(0, key.timestamp - first.timestamp));
    } finally {
      input.dispose();
    }
  }

  /**
   * The picture of a progressive file's keyframe, its bytes put together from the parts that hold them.
   * @param {Sample} sample
   * @return {Promise<?Made>}
   */
  async fromFile(sample) {
    const index = this.fileIndex;
    const level = this.client.getCurrentVideoLevelID();
    const fragments = level === null ? null : this.client.getFragments(level);
    if (!index || !fragments) return null;
    const data = new Uint8Array(sample.size);
    const end = sample.offset + sample.size;
    for (let i = Math.floor(sample.offset / index.partSize); i * index.partSize < end; i++) {
      const part = await this.read(fragments[i]);
      const partStart = i * index.partSize;
      const from = Math.max(sample.offset, partStart);
      const to = Math.min(end, partStart + part.length);
      if (to <= from) throw new NotStored('The part is shorter than its range');
      data.set(part.subarray(from - partStart, to - partStart), from - sample.offset);
    }
    const time = sample.cts / sample.timescale;
    const chunk = new EncodedVideoChunk({type: 'key', timestamp: Math.round(time * 1e6), data});
    return this.picture(index.config, chunk, time);
  }

  /**
   * @param {VideoDecoderConfig} config
   * @param {EncodedVideoChunk} chunk - A keyframe.
   * @param {number} time - Its place in the video.
   * @return {Promise<Made>}
   */
  async picture(config, chunk, time) {
    const frame = await this.decode(config, chunk);
    try {
      const size = thumbnailSize(frame.displayWidth, frame.displayHeight, globalThis.devicePixelRatio);
      const image = await createImageBitmap(frame, {resizeWidth: size.width, resizeHeight: size.height,
        resizeQuality: 'medium'});
      this.bytesEach = size.width * size.height * 4;
      return {time, image, bytes: this.bytesEach};
    } finally {
      frame.close();
    }
  }

  /**
   * @param {VideoDecoderConfig} config
   * @param {EncodedVideoChunk} chunk - A keyframe.
   * @return {Promise<VideoFrame>}
   */
  async decode(config, chunk) {
    clearTimeout(this.decoderIdle);
    if (!sameConfig(this.decoderConfig, config) || !this.decoder || this.decoder.state === 'closed') {
      if (!(await VideoDecoder.isConfigSupported(config)).supported) {
        throw new UnsupportedVideo(`The decoder takes no ${config.codec}`);
      }
      if (this.stopped) throw new Error('Stopped');
      if (!this.decoder || this.decoder.state === 'closed') {
        this.decoder = new VideoDecoder({
          output: (frame) => this.frames.push(frame),
          error: (e) => console.warn('The seek preview decoder failed', e),
        });
      }
      this.decoder.configure(config);
      this.decoderConfig = config;
    }
    const decoder = this.decoder;
    try {
      decoder.decode(chunk);
      await decoder.flush();
    } catch (e) {
      this.decoderConfig = null;
      throw e;
    }
    const [frame, ...rest] = this.frames.splice(0);
    rest.forEach((extra) => extra.close());
    if (!frame) throw new Error('The decoder gave no frame');
    return frame;
  }

  /** Nothing to do now: the decoder lets go of its memory soon. */
  idle() {
    clearTimeout(this.decoderIdle);
    this.decoderIdle = setTimeout(() => this.closeDecoder(), DecoderIdleMs);
  }

  closeDecoder() {
    clearTimeout(this.decoderIdle);
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.decoderConfig = null;
    this.frames.splice(0).forEach((frame) => frame.close());
  }

  /** @param {Thumbnail} thumbnail */
  show(thumbnail) {
    // The box is emptied when its video goes (InterfaceController.resetPreviewVideo).
    if (!this.canvas.isConnected) this.box.appendChild(this.canvas);
    this.draw(thumbnail);
    this.canvas.style.opacity = '1';
  }

  hide() {
    this.canvas.style.opacity = '0';
  }

  /** @param {Thumbnail} thumbnail */
  draw(thumbnail) {
    if (this.drawn === thumbnail) return;
    const image = /** @type {ImageBitmap} */ (/** @type {*} */ (thumbnail.image));
    const canvas = this.canvas;
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    canvas.getContext('2d')?.drawImage(image, 0, 0);
    this.drawn = thumbnail;
  }

  stop() {
    this.stopped = true;
    clearTimeout(/** @type {*} */ (this.timer));
    this.timer = null;
    this.closeDecoder();
  }

  destroy() {
    this.stop();
    this.thumbnails.clear();
    this.inits.clear();
    this.drawn = null;
    this.canvas.remove();
  }
}
