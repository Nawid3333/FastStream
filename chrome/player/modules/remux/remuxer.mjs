import {EventEmitter} from '../eventemitter.mjs';
import {FSBlob} from '../FSBlob.mjs';
import {ALL_FORMATS, BlobSource, EncodedPacketSink, Input} from './mediabunny.mjs';
import {MP4Writer} from './mp4-writer.mjs';

/**
 * Copies a stream's video and audio into one MP4 as they are, where MP4Merger gives up:
 * WebM input, several mdat, moof or traf boxes, a zero sample duration, a codec it does not
 * list.
 *
 * Mediabunny reads each track (the init segment followed by the track's fragments), and its
 * packets go into the MP4 with nothing decoded or encoded, so the save is quick and
 * loses nothing. The re-encoder this replaces turned everything into H.264 and AAC with
 * WebCodecs encoders, which Firefox has on no Windows: there every such save failed. An
 * MP4 takes every codec a DASH stream carries (VP8, VP9, AV1, AVC, HEVC; AAC, Opus,
 * Vorbis, MP3, FLAC, AC-3, E-AC-3), so the file is always an .mp4.
 */
export class Remuxer extends EventEmitter {
  /**
   * @param {function(function(): void): void} [registerCancel] called with the function
   *     that cancels the save
   */
  constructor(registerCancel) {
    super();
    this.blobManager = new FSBlob();
    this.cancelled = false;
    this.destroyed = false;
    this.inputs = [];
    this.writer = null;
    if (registerCancel) {
      registerCancel(() => {
        this.cancel();
      });
    }
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Ends the save with 'Cancelled' once the user has cancelled it.
   */
  checkCancelled() {
    if (this.cancelled) {
      throw new Error('Cancelled');
    }
  }

  /**
   * @param {Blob} blob a track's init segment followed by its fragments
   * @return {Input}
   */
  makeInput(blob) {
    const input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });
    // Disposed in destroy(), which every way out of convert() reaches.
    this.inputs.push(input);
    return input;
  }

  /**
   * The track's codec and the decoder config its first packet carries into the file.
   * @param {Object} track a Mediabunny input track
   * @return {Promise<{codec: string, decoderConfig: Object}>}
   */
  async describe(track) {
    const codec = await track.getCodec();
    if (!codec) {
      const id = await track.getInternalCodecId();
      throw new Error(`The ${track.type} codec (${id ?? 'unknown'}) cannot be saved`);
    }
    const decoderConfig = await track.getDecoderConfig();
    if (!decoderConfig) {
      throw new Error(`The ${track.type} track has no decoder config`);
    }
    return {codec, decoderConfig};
  }

  /**
   * Copies the streams into one MP4.
   *
   * @param {string} videoMimeType unused: Mediabunny reads the container from the data
   * @param {number} videoDuration in seconds; 0 when there is no video
   * @param {ArrayBuffer|Blob} videoInitSegment
   * @param {string} audioMimeType unused, as videoMimeType
   * @param {number} audioDuration in seconds; 0 when there is no separate audio
   * @param {ArrayBuffer|Blob} audioInitSegment
   * @param {Object[]} zippedFragments the saved fragments in order; track 0 is the video,
   *     1 the audio
   * @return {Promise<Blob>} the MP4
   */
  async convert(videoMimeType, videoDuration, videoInitSegment, audioMimeType, audioDuration, audioInitSegment, zippedFragments) {
    try {
      const separateAudio = !!(audioDuration && audioInitSegment);
      if (!videoDuration && !separateAudio) {
        throw new Error('no video or audio');
      }

      // One Blob per track. A Blob made of Blobs only refers to them, so nothing is read
      // into memory here; Mediabunny reads what it needs as it goes.
      const videoParts = videoDuration && videoInitSegment ? [videoInitSegment] : [];
      const audioParts = separateAudio ? [audioInitSegment] : [];
      for (const fragment of zippedFragments) {
        this.checkCancelled();
        const blob = await (await fragment.getEntry()).getData();
        (fragment.track === 0 ? videoParts : audioParts).push(blob);
      }

      const videoInput = videoParts.length ? this.makeInput(new Blob(videoParts)) : null;
      const audioInput = separateAudio ? this.makeInput(new Blob(audioParts)) : null;
      const videoTrack = videoInput ? await videoInput.getPrimaryVideoTrack() : null;
      // Without a separate audio stream, the audio the video stream carries, if any.
      const audioTrack = audioInput ? await audioInput.getPrimaryAudioTrack() :
        videoInput ? await videoInput.getPrimaryAudioTrack() : null;
      if (audioInput && !audioTrack) {
        throw new Error('The audio stream has no audio track');
      }
      if (!videoTrack && !audioTrack) {
        throw new Error('no video or audio');
      }

      const video = videoTrack ? await this.describe(videoTrack) : null;
      const audio = audioTrack ? await this.describe(audioTrack) : null;

      this.writer = new MP4Writer(this.blobManager, {
        video: video?.codec ?? null,
        audio: audio?.codec ?? null,
      });
      await this.writer.start();

      // The two tracks go in together, the packet with the smaller timestamp first, so the
      // muxer does not hold one whole track back waiting for the other. Each track's
      // packets stay in their decode order.
      const next = (packets) => packets ? packets.next() : {done: true};
      const videoPackets = videoTrack ? new EncodedPacketSink(videoTrack).packets() : null;
      const audioPackets = audioTrack ? new EncodedPacketSink(audioTrack).packets() : null;
      let videoHead = await next(videoPackets);
      let audioHead = await next(audioPackets);
      let videoMeta = video ? {decoderConfig: video.decoderConfig} : undefined;
      let audioMeta = audio ? {decoderConfig: audio.decoderConfig} : undefined;

      const duration = Math.max(videoDuration || 0, audioDuration || 0);
      let first = Infinity;
      let lastPercent = 0;

      while (!videoHead.done || !audioHead.done) {
        this.checkCancelled();
        const takeVideo = !videoHead.done && (audioHead.done || videoHead.value.timestamp <= audioHead.value.timestamp);
        const packet = takeVideo ? videoHead.value : audioHead.value;

        // Waits until the file has taken it: reading runs no further ahead than writing.
        if (takeVideo) {
          await this.writer.add('video', packet, videoMeta);
          videoMeta = undefined;
          videoHead = await next(videoPackets);
        } else {
          await this.writer.add('audio', packet, audioMeta);
          audioMeta = undefined;
          audioHead = await next(audioPackets);
        }

        first = Math.min(first, packet.timestamp);
        if (duration > 0) {
          const percent = Math.min(100, Math.floor((packet.timestamp - first) / duration * 100));
          if (percent > lastPercent) {
            lastPercent = percent;
            this.emit('progress', percent / 100);
          }
        }
      }

      this.checkCancelled();
      const blob = await this.writer.finalize();
      this.emit('progress', 1);
      this.destroy();
      return blob;
    } catch (e) {
      // Nothing will read the pieces written so far.
      this.destroy(/* immediate */ true);
      throw e;
    }
  }

  /**
   * Frees what the save opened: the inputs, a file still being written and its pieces.
   * @param {boolean} [immediate] whether the pieces go now; after a save that worked, the
   *     file returned reads from them, so they stay two minutes, as MP4Merger's do
   */
  destroy(immediate) {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    for (const input of this.inputs) {
      input.dispose();
    }
    this.inputs = [];

    if (this.writer) {
      // Stops a file still being written; a finished one stays as it is.
      this.writer.cancel().catch((e) => console.warn(e));
      this.writer = null;
    }

    const blobManager = this.blobManager;
    this.blobManager = null;
    if (immediate) {
      blobManager.close();
    } else {
      setTimeout(() => blobManager.close(), 120000);
    }
  }
}
