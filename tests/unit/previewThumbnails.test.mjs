import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {MinSpacingPx, PreviewThumbnails, nextKeyframe, thumbnailSpacing} from '../../chrome/player/ui/PreviewThumbnails.mjs';

// A 100 s video on a 1000 px bar: 10 px a second.
const px = (a, b) => Math.abs(a - b) * 10;

const image = () => ({close: vi.fn()});

/**
 * @param {number[]} times
 * @param {number} [budget]
 * @return {PreviewThumbnails}
 */
function holding(times, budget = 1e9) {
  const thumbnails = new PreviewThumbnails(budget);
  times.forEach((time) => thumbnails.add(time, image(), 10));
  return thumbnails;
}

describe('the seek preview\'s pictures', () => {
  it('finds the nearest picture on either side', () => {
    const thumbnails = holding([40, 10, 20]);
    expect(thumbnails.list.map((t) => t.time)).toEqual([10, 20, 40]);
    expect(thumbnails.nearest(14)?.time).toBe(10);
    expect(thumbnails.nearest(16)?.time).toBe(20);
    expect(thumbnails.nearest(99)?.time).toBe(40);
    expect(thumbnails.gap(31)).toBe(9);
    expect(new PreviewThumbnails(1).gap(5)).toBe(Infinity);
  });

  it('gives a picture only for its own place, within 30 px', () => {
    const thumbnails = holding([10, 40]);
    expect(thumbnails.near(13, px)?.time).toBe(10);
    expect(thumbnails.near(14, px)).toBe(null);
    expect(thumbnails.near(25, px)).toBe(null);
  });

  it('replaces a picture of the same place and lets go of the old one', () => {
    const thumbnails = new PreviewThumbnails(1e9);
    const old = image();
    thumbnails.add(10, old, 10);
    thumbnails.add(10, image(), 10);
    expect(thumbnails.list).toHaveLength(1);
    expect(thumbnails.bytes).toBe(10);
    expect(old.close).toHaveBeenCalled();
  });

  it('over its budget drops the most crowded picture and keeps the rest spread', () => {
    const thumbnails = new PreviewThumbnails(40);
    const images = [0, 30, 32, 60].map(() => image());
    [0, 30, 32, 60].forEach((time, i) => thumbnails.add(time, images[i], 10));
    thumbnails.add(90, image(), 10);
    expect(thumbnails.list.map((t) => t.time)).toEqual([0, 30, 60, 90]);
    expect(thumbnails.bytes).toBe(40);
    expect(images[2].close).toHaveBeenCalled();
  });

  it('lets go of every picture when cleared', () => {
    const thumbnails = new PreviewThumbnails(1e9);
    const images = [image(), image()];
    thumbnails.add(1, images[0], 10);
    thumbnails.add(2, images[1], 10);
    thumbnails.clear();
    expect(thumbnails.list).toEqual([]);
    expect(thumbnails.bytes).toBe(0);
    images.forEach((i) => expect(i.close).toHaveBeenCalled());
  });
});

describe('the spacing of the seek preview\'s pictures', () => {
  it('is MinSpacingPx on the bar while the budget holds that many', () => {
    expect(thumbnailSpacing({duration: 100, width: 1000, bytesEach: 1, budget: 1e9})).toBeCloseTo(MinSpacingPx / 10);
  });

  it('widens where the budget holds fewer', () => {
    // 50 pictures over 1000 px: one in 20 px, 2 s.
    expect(thumbnailSpacing({duration: 100, width: 1000, bytesEach: 100, budget: 5000})).toBeCloseTo(2);
  });

  it('has none for a bar that cannot be measured', () => {
    expect(thumbnailSpacing({duration: Infinity, width: 1000, bytesEach: 1, budget: 1e9})).toBe(Infinity);
    expect(thumbnailSpacing({duration: 100, width: 0, bytesEach: 1, budget: 1e9})).toBe(Infinity);
  });
});

describe('the keyframe decoded next for the seek preview', () => {
  const keyframes = (times) => times.map((time) => ({time}));
  // 0.8 s apart (8 px), and NearPx (30 px) is 3 s.
  const at = (pointer, playhead = 0) => ({spacing: 0.8, near: 3, pointer, playhead});

  it('takes the one nearest the playhead first, then the one farthest from every picture', () => {
    const candidates = keyframes([0, 10, 20, 30, 40]);
    const thumbnails = new PreviewThumbnails(1e9);
    expect(nextKeyframe(candidates, thumbnails, at(null, 21))?.time).toBe(20);
    thumbnails.add(20, image(), 10);
    // 0 and 40 both 20 s from it: the one nearer the playhead.
    expect(nextKeyframe(candidates.filter((c) => c.time !== 20), thumbnails, at(null, 21))?.time).toBe(40);
    thumbnails.add(40, image(), 10);
    expect(nextKeyframe(keyframes([0, 10, 30]), thumbnails, at(null, 21))?.time).toBe(0);
  });

  it('takes none once every keyframe has a picture this near', () => {
    const thumbnails = holding([0, 10]);
    expect(nextKeyframe(keyframes([0.5, 10.7]), thumbnails, at(null))).toBe(null);
    expect(nextKeyframe(keyframes([0.5, 10.9]), thumbnails, at(null))?.time).toBe(10.9);
  });

  it('takes the pointer\'s place first when no picture is as near to it', () => {
    const thumbnails = holding([0]);
    expect(nextKeyframe(keyframes([40, 60, 61]), thumbnails, at(60.4))?.time).toBe(60);
  });

  it('leaves the pointer\'s place when a picture is near it, or no keyframe near enough to show there', () => {
    expect(nextKeyframe(keyframes([40, 61]), holding([60.2]), at(60.4))?.time).toBe(40);
    // 61 is 5 s, 50 px, from the pointer: the farthest from every picture goes first.
    expect(nextKeyframe(keyframes([10, 61]), holding([50]), at(56))?.time).toBe(10);
  });
});

describe('the seek preview\'s pictures made with WebCodecs', () => {
  /** @type {Array<{data: Uint8Array}>} */
  let decoded;
  let supported;
  let PreviewThumbnailer;
  let thumbnailBudget;
  let thumbnailSize;
  let ThumbnailBudget;
  let DiskOnlyThumbnailBudget;
  let BackgroundGapMs;
  let DownloadStatus;
  let Fragment;

  beforeEach(async () => {
    vi.resetModules();
    decoded = [];
    supported = true;
    // A segment's first byte is its number; its last, its keyframe's distance from its first packet in quarter seconds.
    vi.doMock('../../chrome/player/modules/remux/mediabunny.mjs', () => ({
      ALL_FORMATS: [],
      BufferSource: class {
        constructor(bytes) {
          this.bytes = bytes;
        }
      },
      Input: class {
        constructor({source}) {
          this.bytes = source.bytes;
        }
        async getPrimaryVideoTrack() {
          return {bytes: this.bytes, getDecoderConfig: async () => ({codec: 'avc1.42c028', codedWidth: 1920, codedHeight: 1080})};
        }
        dispose() {}
      },
      EncodedPacketSink: class {
        constructor(track) {
          this.bytes = track.bytes;
        }
        async getFirstPacket() {
          const after = this.bytes[this.bytes.length - 1] / 4;
          return {type: after ? 'delta' : 'key', timestamp: 10, toEncodedVideoChunk: () => ({data: this.bytes})};
        }
        async getNextKeyPacket(packet) {
          const after = this.bytes[this.bytes.length - 1] / 4;
          return {type: 'key', timestamp: packet.timestamp + after, toEncodedVideoChunk: () => ({data: this.bytes})};
        }
      },
    }));
    vi.stubGlobal('VideoDecoder', class {
      static async isConfigSupported() {
        return {supported};
      }
      constructor({output}) {
        this.output = output;
        this.state = 'unconfigured';
      }
      configure() {
        this.state = 'configured';
      }
      decode(chunk) {
        decoded.push(chunk);
        this.pending = {displayWidth: 1920, displayHeight: 1080, close: vi.fn()};
      }
      async flush() {
        this.output(this.pending);
      }
      close() {
        this.state = 'closed';
      }
    });
    vi.stubGlobal('createImageBitmap', async (frame, {resizeWidth, resizeHeight}) =>
      ({width: resizeWidth, height: resizeHeight, close: vi.fn()}));
    ({PreviewThumbnailer, thumbnailBudget, thumbnailSize, ThumbnailBudget, DiskOnlyThumbnailBudget, BackgroundGapMs} =
      await import('../../chrome/player/ui/PreviewThumbnailer.mjs'));
    ({DownloadStatus} = await import('../../chrome/player/enums/DownloadStatus.mjs'));
    ({Fragment} = await import('../../chrome/player/players/Fragment.mjs'));
    vi.stubGlobal('EncodedVideoChunk', class {
      constructor(init) {
        Object.assign(this, init);
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../../chrome/player/modules/remux/mediabunny.mjs');
  });

  /**
   * @param {number} sn
   * @param {number} start
   * @param {string} url
   * @return {Fragment} Downloaded.
   */
  function part(sn, start, url) {
    const fragment = new Fragment('0:0', sn);
    fragment.start = start;
    fragment.end = start + 4;
    fragment.status = DownloadStatus.DOWNLOAD_COMPLETE;
    fragment.getContext = () => ({url});
    return fragment;
  }

  /**
   * A client with an HLS stream of 4 s segments, all downloaded; 10 px a second on the bar.
   * @param {Object} [options]
   * @return {Object}
   */
  function hlsClient({segments = 10, mode = 'accelerated_hls', options = {}} = {}) {
    const source = {mode};
    const fragments = [];
    for (let sn = 0; sn < segments; sn++) {
      fragments.push(part(sn, sn * 4, `seg${sn}`));
    }
    return {
      options: {ramBudget: 1e9, bufferToDisk: true, ...options},
      player: {getSource: () => source},
      duration: segments * 4,
      currentTime: 0,
      getCurrentVideoLevelID: () => '0:0',
      getFragments: () => fragments,
      getFragment: (level, sn) => fragments[sn],
      downloadManager: {getEntry: ({url}) => ({getDataFromBlob: async () => new Uint8Array([Number(url.slice(3)), 0]).buffer})},
      previewPxApart: (a, b) => Math.abs(a - b) * 10,
      updatePreview: vi.fn(),
    };
  }

  const box = () => ({
    ownerDocument: {createElement: () => ({classList: {add() {}}, style: {}, isConnected: false, remove: vi.fn(),
      getContext: () => ({drawImage: vi.fn()})})},
    appendChild: vi.fn(),
  });

  /**
   * Runs the thumbnailer until it rests.
   * @param {*} thumbnailer
   */
  async function settle(thumbnailer) {
    for (let i = 0; i < 200 && (thumbnailer.running || thumbnailer.timer !== null); i++) {
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  it('makes one picture of each downloaded segment\'s keyframe, the pointer\'s first, one decode at a time', async () => {
    vi.useFakeTimers();
    try {
      const client = hlsClient();
      const thumbnailer = new PreviewThumbnailer(client, box());
      thumbnailer.point(21);
      await settle(thumbnailer);
      expect(decoded[0].data[0]).toBe(5);
      expect(thumbnailer.thumbnails.list.map((t) => t.time)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32, 36]);
      expect(decoded).toHaveLength(10);
      expect(thumbnailer.near(21)?.time).toBe(20);
      expect(client.updatePreview).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('decodes in the background only after its gap, also while the pointer moves', async () => {
    vi.useFakeTimers();
    try {
      const thumbnailer = new PreviewThumbnailer(hlsClient(), box());
      thumbnailer.point(21);
      await vi.advanceTimersByTimeAsync(0);
      expect(decoded).toHaveLength(1);
      thumbnailer.point(21.5);
      thumbnailer.point(22);
      await vi.advanceTimersByTimeAsync(BackgroundGapMs - 1);
      expect(decoded).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(decoded).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the picture\'s place from the segment\'s start and its keyframe\'s offset', async () => {
    vi.useFakeTimers();
    try {
      const client = hlsClient({segments: 1});
      client.getFragments()[0].start = 30;
      client.downloadManager.getEntry = () => ({getDataFromBlob: async () => new Uint8Array([0, 2]).buffer});
      const thumbnailer = new PreviewThumbnailer(client, box());
      thumbnailer.wake();
      await settle(thumbnailer);
      expect(thumbnailer.thumbnails.list.map((t) => t.time)).toEqual([30.5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes none of segments not downloaded yet, nor of an fMP4 level before its init segment', async () => {
    vi.useFakeTimers();
    try {
      const client = hlsClient({segments: 3});
      const fragments = client.getFragments();
      fragments[1].status = DownloadStatus.DOWNLOAD_INITIATED;
      fragments[-1] = part(-1, -1, 'seg9');
      fragments[-1].status = DownloadStatus.WAITING;
      const thumbnailer = new PreviewThumbnailer(client, box());
      thumbnailer.wake();
      await settle(thumbnailer);
      expect(decoded).toHaveLength(0);
      fragments[-1].status = DownloadStatus.DOWNLOAD_COMPLETE;
      thumbnailer.wake();
      await settle(thumbnailer);
      expect(thumbnailer.thumbnails.list.map((t) => t.time)).toEqual([0, 8]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops for a codec the decoder does not take, and leaves the preview as it was', async () => {
    vi.useFakeTimers();
    try {
      supported = false;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const thumbnailer = new PreviewThumbnailer(hlsClient(), box());
      thumbnailer.wake();
      await settle(thumbnailer);
      expect(thumbnailer.stopped).toBe(true);
      expect(decoded).toHaveLength(0);
      expect(thumbnailer.near(0)).toBe(null);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('makes none for a direct video', () => {
    expect(new PreviewThumbnailer(hlsClient({mode: 'direct'}), box()).stopped).toBe(true);
    expect(new PreviewThumbnailer(hlsClient({mode: 'accelerated_dash'}), box()).stopped).toBe(false);
    expect(new PreviewThumbnailer(hlsClient({mode: 'accelerated_mp4'}), box()).stopped).toBe(false);
  });

  it('puts a progressive file\'s keyframe together from the parts that hold it, and skips one not all downloaded', async () => {
    vi.useFakeTimers();
    try {
      // Parts of 10 bytes, byte n of the file is n; keyframes at 2 s (bytes 8-13) and 6 s (bytes 25-34).
      const client = hlsClient({segments: 4, mode: 'accelerated_mp4'});
      const fragments = client.getFragments();
      fragments[3].status = DownloadStatus.DOWNLOAD_INITIATED;
      client.downloadManager.getEntry = ({url}) => {
        const start = 10 * Number(url.slice(3));
        return {getDataFromBlob: async () => Uint8Array.from({length: 10}, (_, i) => start + i).buffer};
      };
      const keyframes = [{offset: 8, size: 6, cts: 2000, timescale: 1000}, {offset: 25, size: 10, cts: 6000, timescale: 1000}];
      client.player.previewKeyframes = () => ({config: {codec: 'avc1.640028'}, keyframes, partSize: 10});
      const thumbnailer = new PreviewThumbnailer(client, box());
      thumbnailer.wake();
      await settle(thumbnailer);
      expect(decoded).toHaveLength(1);
      expect([...decoded[0].data]).toEqual([8, 9, 10, 11, 12, 13]);
      expect(decoded[0].timestamp).toBe(2e6);
      expect(thumbnailer.thumbnails.list.map((t) => t.time)).toEqual([2]);
      fragments[3].status = DownloadStatus.DOWNLOAD_COMPLETE;
      thumbnailer.wake();
      await settle(thumbnailer);
      expect(thumbnailer.thumbnails.list.map((t) => t.time)).toEqual([2, 6]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets go of its pictures and its decoder when destroyed', async () => {
    vi.useFakeTimers();
    try {
      const thumbnailer = new PreviewThumbnailer(hlsClient({segments: 2}), box());
      thumbnailer.wake();
      await settle(thumbnailer);
      const images = thumbnailer.thumbnails.list.map((t) => t.image);
      thumbnailer.destroy();
      images.forEach((i) => expect(i.close).toHaveBeenCalled());
      expect(thumbnailer.decoder).toBe(null);
      expect(thumbnailer.canvas.remove).toHaveBeenCalled();
      thumbnailer.point(4);
      expect(thumbnailer.running).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps less in RAM with "Disk only", and sizes a picture to the preview box', () => {
    expect(thumbnailBudget({ramBudget: 0, bufferToDisk: true})).toBe(DiskOnlyThumbnailBudget);
    expect(thumbnailBudget({ramBudget: 1e9, bufferToDisk: true})).toBe(ThumbnailBudget);
    expect(thumbnailBudget({ramBudget: 512e6, bufferToDisk: false})).toBe(ThumbnailBudget);
    expect(thumbnailSize(1920, 1080, 1)).toEqual({width: 178, height: 100});
    expect(thumbnailSize(1920, 1080, 3)).toEqual({width: 356, height: 200});
  });
});

describe('the MP4 player\'s keyframes for the seek preview', () => {
  /**
   * A player of a 1080p H.264 file, its metadata in.
   * @param {Object} entry - The video track's sample entry.
   * @return {Object}
   */
  async function playerWith(entry) {
    const {default: MP4Player} = await import('../../chrome/player/players/mp4/MP4Player.mjs');
    const player = Object.create(MP4Player.prototype);
    const keyframes = [{cts: 0, timescale: 1000, offset: 48, size: 10, is_sync: true}];
    Object.assign(player, {
      isAudioOnly: false, currentVideoTrack: 0, previewDecoderConfig: null, previewDecoderTrak: undefined,
      metaData: {videoTracks: [{id: 1, codec: 'avc1.640028', video: {width: 1920, height: 1080}}], audioTracks: []},
      videoTracks: [{trak: {mdia: {minf: {stbl: {stsd: {entries: [entry]}}}}}, sortedSamples: keyframes}],
    });
    return {player, keyframes};
  }

  it('gives the played track\'s keyframes and a decoder config with the codec box\'s contents', async () => {
    const avcC = {write: (stream) => {
      stream.writeUint32(12);
      [...'avcC', 1, 100, 0, 40].forEach((byte) => stream.writeUint8(typeof byte === 'string' ? byte.charCodeAt(0) : byte));
    }};
    const {player, keyframes} = await playerWith({avcC});
    const index = player.previewKeyframes();
    expect(index.config).toMatchObject({codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080});
    expect([...index.config.description]).toEqual([1, 100, 0, 40]);
    expect(index.keyframes).toBe(keyframes);
    expect(index.partSize).toBe(1e6);
    expect(player.previewKeyframes().config).toBe(index.config);
  });

  it('gives none before the metadata, and no description for a codec without a box', async () => {
    const {player} = await playerWith({});
    expect(player.previewKeyframes().config.description).toBeUndefined();
    player.metaData = null;
    expect(player.previewKeyframes()).toBe(null);
  });
});
