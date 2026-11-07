// @ts-check
// The save's MP4 writer: a whole MP4 file (sample tables, edit lists, no fragments). It began as
// hls.js's mp4-generator; what was still hls.js's own comes from hls.js now, and the rest is
// checked against it (tests/unit/mp4WriterUpstream.test.mjs, docs/vendored-libraries.md).

/**
 * A sample of a track, as the saves give it (hls2mp4's samplesFromMoof, MP4Merger).
 * @typedef {{duration: number, size: number, cts: number, flags: Mp4SampleFlags}} Mp4Sample
 */
/**
 * @typedef {{isLeading?: number, isDependedOn: number, hasRedundancy: number, degradPrio?: number,
 *   paddingValue?: number, dependsOn: number, isNonSync: number}} Mp4SampleFlags
 */
/**
 * A run of a track's samples stored one after the other in the file (stsc, stco).
 * @typedef {{id: number, samples: Array<Mp4Sample>, offset: number}} Mp4Chunk
 */
/**
 * A track to write (hls2mp4's makeTrack, MP4Merger's makeVideoTrack and makeAudioTrack).
 * @typedef {Object} Mp4Track
 * @property {number} id
 * @property {string} type - 'video' or 'audio'.
 * @property {number} timescale
 * @property {number} [movieTimescale] - The movie's (its first track's): tkhd and the edits count in
 *   it. Set before the file is written (hls2mp4, MP4Merger.finalize).
 * @property {number} duration - In seconds.
 * @property {number} [width]
 * @property {number} [height]
 * @property {Array<Mp4Sample>} samples
 * @property {Array<Mp4Chunk>} chunks
 * @property {Array<{media_time: number, segment_duration: number}>} elst
 * @property {boolean} [use64Offsets] - co64 instead of stco: a file past 4 GB.
 * @property {ArrayBuffer|Uint8Array} [codecBuffer] - Its sample entry, written already: a DASH
 *   or fMP4 track's from its own init segment, an HLS video track's by hls.js (hls2mp4).
 * @property {?string} [segmentCodec]
 * @property {string} [codec]
 * @property {Array<number>|Uint8Array} [config] - AAC's AudioSpecificConfig bytes, or AC-3's dac3.
 * @property {Array<number>|Uint8Array} [esds] - An esds box's payload after its version and flags.
 * @property {number} [channelCount]
 * @property {number} [samplerate]
 * @property {*} [params]
 */

const UINT32_MAX = Math.pow(2, 32) - 1;
export class MP4 {
  /**
   * Each box type's four character codes, set by init() on the first file.
   * @type {Object<string, Array<number>>}
   */
  static types;
  /** @type {Object<string, Uint8Array>} */
  static HDLR_TYPES;
  /** @type {Uint8Array} */
  static VMHD;
  /** @type {Uint8Array} */
  static SMHD;
  /** @type {Uint8Array} */
  static STSD;
  /** @type {Uint8Array} */
  static FTYP;
  /** @type {Uint8Array} */
  static DINF;

  static init() {
    MP4.types = {
      'avc1': [],
      // codingname
      'avcC': [],
      'hvc1': [],
      'hvcC': [],
      'btrt': [],
      'dinf': [],
      'dref': [],
      'esds': [],
      'ftyp': [],
      'hdlr': [],
      'mdat': [],
      'mdhd': [],
      'mdia': [],
      'mfhd': [],
      'minf': [],
      'moof': [],
      'moov': [],
      'mp4a': [],
      '.mp3': [],
      'ac-3': [],
      'dac3': [],
      'mvex': [],
      'mvhd': [],
      'pasp': [],
      'sdtp': [],
      'stbl': [],
      'stco': [],
      'stsc': [],
      'stsd': [],
      'stsz': [],
      'stts': [],
      'tfdt': [],
      'tfhd': [],
      'traf': [],
      'trak': [],
      'trun': [],
      'trex': [],
      'tkhd': [],
      'vmhd': [],
      'smhd': [],
      'stss': [],
      'ctts': [],
      'co64': [],
      'edts': [],
      'elst': [],
    };
    let i;
    for (i in MP4.types) {
      if (MP4.types.hasOwnProperty(i)) {
        MP4.types[i] = [i.charCodeAt(0), i.charCodeAt(1), i.charCodeAt(2), i.charCodeAt(3)];
      }
    }
    const videoHdlr = new Uint8Array([0x00,
      // version 0
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00, 0x00, 0x00,
      // pre_defined
      0x76, 0x69, 0x64, 0x65,
      // handler_type: 'vide'
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x56, 0x69, 0x64, 0x65, 0x6f, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0x00, // name: 'VideoHandler'
    ]);

    const audioHdlr = new Uint8Array([0x00,
      // version 0
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00, 0x00, 0x00,
      // pre_defined
      0x73, 0x6f, 0x75, 0x6e,
      // handler_type: 'soun'
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x53, 0x6f, 0x75, 0x6e, 0x64, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0x00, // name: 'SoundHandler'
    ]);

    MP4.HDLR_TYPES = {
      video: videoHdlr,
      audio: audioHdlr,
    };
    const dref = new Uint8Array([0x00,
      // version 0
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00, 0x00, 0x01,
      // entry_count
      0x00, 0x00, 0x00, 0x0c,
      // entry_size
      0x75, 0x72, 0x6c, 0x20,
      // 'url' type
      0x00,
      // version 0
      0x00, 0x00, 0x01, // entry_flags
    ]);


    MP4.VMHD = new Uint8Array([0x00,
      // version
      0x00, 0x00, 0x01,
      // flags
      0x00, 0x00,
      // graphicsmode
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // opcolor
    ]);

    MP4.SMHD = new Uint8Array([0x00,
      // version
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00,
      // balance
      0x00, 0x00, // reserved
    ]);

    MP4.STSD = new Uint8Array([0x00,
      // version 0
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00, 0x00, 0x01]); // entry_count

    const majorBrand = new Uint8Array([105, 115, 111, 109]); // isom
    const avc1Brand = new Uint8Array([97, 118, 99, 49]); // avc1
    const minorVersion = new Uint8Array([0, 0, 0, 1]);
    MP4.FTYP = MP4.box(MP4.types.ftyp, majorBrand, minorVersion, majorBrand, avc1Brand);
    MP4.DINF = MP4.box(MP4.types.dinf, MP4.box(MP4.types.dref, dref));
  }
  /**
   * @param {ArrayLike<number>} type - The box type's four character codes (MP4.types).
   * @param {...ArrayLike<number> & {byteLength: number}} payload
   * @return {Uint8Array<ArrayBuffer>}
   */
  static box(type, ...payload) {
    let size = 8;
    let i = payload.length;
    const len = i;
    // calculate the total size we need to allocate
    while (i--) {
      size += payload[i].byteLength;
    }
    const result = new Uint8Array(size);
    result[0] = size >> 24 & 0xff;
    result[1] = size >> 16 & 0xff;
    result[2] = size >> 8 & 0xff;
    result[3] = size & 0xff;
    result.set(type, 4);
    // copy the payload into the result
    for (i = 0, size = 8; i < len; i++) {
      // copy payload[i] array @ offset size
      result.set(payload[i], size);
      size += payload[i].byteLength;
    }
    return result;
  }
  /**
   * @param {string} type - 'video' or 'audio'.
   * @return {Uint8Array}
   */
  static hdlr(type) {
    return MP4.box(MP4.types.hdlr, MP4.HDLR_TYPES[type]);
  }
  /**
   * @param {number} timescale
   * @param {number} duration - In seconds.
   * @return {Uint8Array}
   */
  static mdhd(timescale, duration) {
    duration *= timescale;
    const upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
    const lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
    return MP4.box(MP4.types.mdhd, new Uint8Array([0x01,
      // version 1
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
      // creation_time
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
      // modification_time
      timescale >> 24 & 0xff, timescale >> 16 & 0xff, timescale >> 8 & 0xff, timescale & 0xff,
      // timescale
      upperWordDuration >> 24, upperWordDuration >> 16 & 0xff, upperWordDuration >> 8 & 0xff, upperWordDuration & 0xff, lowerWordDuration >> 24, lowerWordDuration >> 16 & 0xff, lowerWordDuration >> 8 & 0xff, lowerWordDuration & 0xff, 0x55, 0xc4,
      // 'und' language (undetermined)
      0x00, 0x00]));
  }
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static mdia(track) {
    return MP4.box(MP4.types.mdia, MP4.mdhd(track.timescale, track.duration), MP4.hdlr(track.type), MP4.minf(track));
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static minf(track) {
    if (track.type === 'audio') {
      return MP4.box(MP4.types.minf, MP4.box(MP4.types.smhd, MP4.SMHD), MP4.DINF, MP4.stbl(track));
    } else {
      return MP4.box(MP4.types.minf, MP4.box(MP4.types.vmhd, MP4.VMHD), MP4.DINF, MP4.stbl(track));
    }
  }

  /**
   * @param {Array<Mp4Track>} tracks - The movie's tracks.
   * @return {Uint8Array}
   */
  static moov(tracks) {
    let i = tracks.length;
    /** @type {Array<Uint8Array>} */
    const boxes = [];
    while (i--) {
      boxes[i] = MP4.trak(tracks[i]);
    }
    return MP4.box(MP4.types.moov, MP4.mvhd(tracks[0].timescale, tracks[0].duration), ...boxes);
  }
  /**
   * @param {number} timescale
   * @param {number} duration - In seconds.
   * @return {Uint8Array}
   */
  static mvhd(timescale, duration) {
    duration *= timescale;
    const upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
    const lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
    const bytes = new Uint8Array([0x01,
      // version 1
      0x00, 0x00, 0x00,
      // flags
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
      // creation_time
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
      // modification_time
      timescale >> 24 & 0xff, timescale >> 16 & 0xff, timescale >> 8 & 0xff, timescale & 0xff,
      // timescale
      upperWordDuration >> 24, upperWordDuration >> 16 & 0xff, upperWordDuration >> 8 & 0xff, upperWordDuration & 0xff, lowerWordDuration >> 24, lowerWordDuration >> 16 & 0xff, lowerWordDuration >> 8 & 0xff, lowerWordDuration & 0xff, 0x00, 0x01, 0x00, 0x00,
      // 1.0 rate
      0x01, 0x00,
      // 1.0 volume
      0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
      // transformation: unity matrix
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // pre_defined
      0xff, 0xff, 0xff, 0xff, // next_track_ID
    ]);

    return MP4.box(MP4.types.mvhd, bytes);
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stts(track) {
    /** @type {Array<number>} */
    const sample_counts = [];
    /** @type {Array<number>} */
    const sample_deltas = [];

    for (let i = 0; i < track.samples.length; i++) {
      const sample = track.samples[i];
      const delta = sample.duration;
      const last = sample_deltas.length - 1;

      if (last < 0 || sample_deltas[last] !== delta) {
        sample_deltas.push(delta);
        sample_counts.push(1);
      } else {
        sample_counts[last]++;
      }
    }

    const len = sample_counts.length;
    const table = new ArrayBuffer(len * 8 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, 0);
    view.setUint32(4, len);
    let index = 8;
    for (let i = 0; i < len; i++) {
      view.setUint32(index, sample_counts[i]);
      index += 4;
      view.setUint32(index, sample_deltas[i]);
      index += 4;
    }

    return MP4.box(MP4.types.stts, new Uint8Array(table));
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stsc(track) {
    /** @type {Array<number>} */
    const first_chunks = [];
    /** @type {Array<number>} */
    const samples_per_chunk = [];
    /** @type {Array<number>} */
    const sample_description_index = [];

    for (let i = 0; i < track.chunks.length; i++) {
      const chunk = track.chunks[i];
      const last = first_chunks.length - 1;

      if (last < 0 || samples_per_chunk[last] !== chunk.samples.length) {
        first_chunks.push(chunk.id);
        samples_per_chunk.push(chunk.samples.length);
        sample_description_index.push(1);
      }
    }

    const len = first_chunks.length;
    const table = new ArrayBuffer(len * 12 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, 0);
    view.setUint32(4, len);
    let index = 8;
    for (let i = 0; i < len; i++) {
      view.setUint32(index, first_chunks[i]);
      index += 4;
      view.setUint32(index, samples_per_chunk[i]);
      index += 4;
      view.setUint32(index, sample_description_index[i]);
      index += 4;
    }

    return MP4.box(MP4.types.stsc, new Uint8Array(table));
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stsz(track) {
    const len = track.samples.length;
    const table = new ArrayBuffer(len * 4 + 4 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, 0);
    view.setUint32(4, 0);
    view.setUint32(8, len);
    let index = 12;
    for (let i = 0; i < len; i++) {
      view.setUint32(index, track.samples[i].size);
      index += 4;
    }

    return MP4.box(MP4.types.stsz, new Uint8Array(table));
  }


  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stco(track) {
    const len = track.chunks.length;
    const table = new ArrayBuffer(len * 4 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, 0);
    view.setUint32(4, len);
    let index = 8;
    for (let i = 0; i < len; i++) {
      const offset = track.chunks[i].offset || 0;
      if (offset > UINT32_MAX) {
        throw new Error('Offset is too large');
      }
      view.setUint32(index, offset);
      index += 4;
    }

    return MP4.box(MP4.types.stco, new Uint8Array(table));
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static co64(track) {
    const len = track.chunks.length;
    const table = new ArrayBuffer(len * 8 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, 0);
    view.setUint32(4, len);
    let index = 8;
    for (let i = 0; i < len; i++) {
      view.setBigUint64(index, BigInt(track.chunks[i].offset || 0));
      index += 8;
    }

    return MP4.box(MP4.types.co64, new Uint8Array(table));
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stss(track) {
    /** @type {Array<number>} */
    const keySamples = [];
    for (let i = 0; i < track.samples.length; i++) {
      if (track.samples[i].flags && !track.samples[i].flags.isNonSync) {
        keySamples.push(i + 1);
      }
    }

    const len = keySamples.length;
    const table = new ArrayBuffer(len * 4 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, 0);
    view.setUint32(4, len);
    let index = 8;
    for (let i = 0; i < len; i++) {
      view.setUint32(index, keySamples[i]);
      index += 4;
    }

    return MP4.box(MP4.types.stss, new Uint8Array(table));
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static ctts(track) {
    /** @type {Array<number>} */
    const sample_counts = [];
    /** @type {Array<number>} */
    const composition_offsets = [];

    for (let i = 0; i < track.samples.length; i++) {
      const sample = track.samples[i];
      const offset = sample.cts;
      const last = composition_offsets.length - 1;
      if (last < 0 || composition_offsets[last] !== offset) {
        composition_offsets.push(offset);
        sample_counts.push(1);
      } else {
        sample_counts[last]++;
      }
    }

    // FastStream: version 1 offsets are signed. MP4Merger copies a stream's offsets as they
    // are, and CMAF packagers (ffmpeg's +negative_cts_offsets) make some negative: written
    // into version 0, which is unsigned, -3000 read as 4294964296. Without a negative one
    // the box stays version 0.
    const version = composition_offsets.some((offset) => offset < 0) ? 1 : 0;
    const len = sample_counts.length;
    const table = new ArrayBuffer(len * 8 + 4 + 4);
    const view = new DataView(table);
    view.setUint32(0, version << 24);
    view.setUint32(4, len);
    let index = 8;
    for (let i = 0; i < len; i++) {
      view.setUint32(index, sample_counts[i]);
      index += 4;
      if (version === 1) {
        view.setInt32(index, composition_offsets[i]);
      } else {
        view.setUint32(index, composition_offsets[i]);
      }
      index += 4;
    }

    return MP4.box(MP4.types.ctts, new Uint8Array(table));
  }


  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stbl(track) {
    const co = track.use64Offsets ? MP4.co64(track) : MP4.stco(track);
     
    if (track.type === 'video') {
      return MP4.box(MP4.types.stbl,
          MP4.stsd(track),
          MP4.stts(track),
          MP4.stsc(track),
          MP4.stsz(track),
          co,
          MP4.stss(track),
          MP4.ctts(track),
          MP4.sdtp(track));
    } else {
      return MP4.box(MP4.types.stbl,
          MP4.stsd(track),
          MP4.stts(track),
          MP4.stsc(track),
          MP4.stsz(track),
          co);
    }
  };

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static sdtp(track) {
    const samples = track.samples || [];
    const bytes = new Uint8Array(4 + samples.length);
    let i;
    let flags;
    // leave the full box header (4 bytes) all zero
    // write the sample table
    for (i = 0; i < samples.length; i++) {
      flags = samples[i].flags;
      bytes[i + 4] = flags.dependsOn << 4 | flags.isDependedOn << 2 | flags.hasRedundancy;
    }
    return MP4.box(MP4.types.sdtp, bytes);
  }

  // FastStream: hls.js 1.7.3's MP4.hvc1 (src/remux/mp4-generator.ts), as it writes the
  // sample entry for the HEVC it demuxes from a transport stream. track.params is what its
  // HEVC parser read from the VPS and SPS.
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static esds(track) {
    if (track.esds) {
      return new Uint8Array([
        0x00,
        // version 0
        0x00, 0x00, 0x00,
        // flags
        ...track.esds,
      ]);
    }
    const config = /** @type {Array<number>} */ (track.config);
    const configlen = config.length;
    return new Uint8Array([
      0x00,
      // version 0
      0x00, 0x00, 0x00,
      // flags

      0x03,
      // descriptor_type
      0x17 + configlen,
      // length
      0x00, 0x01,
      // es_id
      0x00,
      // stream_priority

      0x04,
      // descriptor_type
      0x0f + configlen,
      // length
      0x40,
      // codec : mpeg4_audio
      0x15,
      // stream_type
      0x00, 0x00, 0x00,
      // buffer_size
      0x00, 0x00, 0x00, 0x00,
      // maxBitrate
      0x00, 0x00, 0x00, 0x00,
      // avgBitrate

      0x05, // descriptor_type
    ].concat([configlen]).concat(config).concat([0x06, 0x01, 0x02])); // GASpecificConfig)); // length + audio config descriptor
  }

  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static mp4a(track) {
    const samplerate = /** @type {number} */ (track.samplerate);
    return MP4.box(MP4.types.mp4a, new Uint8Array([0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00,
      // reserved
      0x00, 0x01,
      // data_reference_index
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, /** @type {number} */ (track.channelCount),
      // channelcount
      0x00, 0x10,
      // sampleSize:16bits
      0x00, 0x00, 0x00, 0x00,
      // reserved2
      samplerate >> 8 & 0xff, samplerate & 0xff,
      //
      0x00, 0x00]), MP4.box(MP4.types.esds, MP4.esds(track)));
  }
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static mp3(track) {
    const samplerate = /** @type {number} */ (track.samplerate);
    return MP4.box(MP4.types['.mp3'], new Uint8Array([0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00,
      // reserved
      0x00, 0x01,
      // data_reference_index
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, /** @type {number} */ (track.channelCount),
      // channelcount
      0x00, 0x10,
      // sampleSize:16bits
      0x00, 0x00, 0x00, 0x00,
      // reserved2
      samplerate >> 8 & 0xff, samplerate & 0xff,
      //
      0x00, 0x00]));
  }
  // FastStream: hls.js 1.7.3's MP4.ac3 (src/remux/mp4-generator.ts, with its audioStsd), as
  // it writes the sample entry for the AC-3 it demuxes from a transport stream. track.config
  // is the dac3 payload hls.js's AC-3 parser (src/demux/audio/ac3-demuxer.ts, appendFrame)
  // built from the first frame header: fscod, bsid, bsmod, acmod, lfeon, bit_rate_code.
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static ac3(track) {
    const samplerate = track.samplerate || 0;
    return MP4.box(MP4.types['ac-3'], new Uint8Array([0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00, 0x00,
      // reserved
      0x00, 0x01,
      // data_reference_index
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, track.channelCount || 0,
      // channelcount
      0x00, 0x10,
      // sampleSize:16bits
      0x00, 0x00, 0x00, 0x00,
      // reserved2
      samplerate >> 8 & 0xff, samplerate & 0xff,
      //
      0x00, 0x00]), MP4.box(MP4.types.dac3, /** @type {Uint8Array} */ (track.config)));
  }
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static stsd(track) {
    if (track.codecBuffer) {
      return MP4.box(MP4.types.stsd, MP4.STSD, new Uint8Array(track.codecBuffer));
    }
    if (track.type === 'audio') {
      if (track.segmentCodec === 'mp3' && track.codec === 'mp3') {
        return MP4.box(MP4.types.stsd, MP4.STSD, MP4.mp3(track));
      }
      // FastStream: AC-3 from a transport stream, which the save's transmuxer takes.
      if (track.segmentCodec === 'ac3' && track.config) {
        return MP4.box(MP4.types.stsd, MP4.STSD, MP4.ac3(track));
      }
      return MP4.box(MP4.types.stsd, MP4.STSD, MP4.mp4a(track));
    }
    // A video track comes with its sample entry: a DASH or fMP4 track's from its own init
    // segment (mp4merger), an HLS transport stream's written by hls.js's MP4 writer (hls2mp4).
    throw new Error(`A ${track.type} track without its sample entry (codecBuffer)`);
  }
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static tkhd(track) {
    const id = track.id;
    const duration = track.duration * /** @type {number} */ (track.movieTimescale);
    const width = /** @type {number} */ (track.width);
    const height = /** @type {number} */ (track.height);
    const upperWordDuration = Math.floor(duration / (UINT32_MAX + 1));
    const lowerWordDuration = Math.floor(duration % (UINT32_MAX + 1));
    return MP4.box(MP4.types.tkhd, new Uint8Array([0x01,
      // version 1
      0x00, 0x00, 0x07,
      // flags
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02,
      // creation_time
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03,
      // modification_time
      id >> 24 & 0xff, id >> 16 & 0xff, id >> 8 & 0xff, id & 0xff,
      // track_ID
      0x00, 0x00, 0x00, 0x00,
      // reserved
      upperWordDuration >> 24, upperWordDuration >> 16 & 0xff, upperWordDuration >> 8 & 0xff, upperWordDuration & 0xff, lowerWordDuration >> 24, lowerWordDuration >> 16 & 0xff, lowerWordDuration >> 8 & 0xff, lowerWordDuration & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // reserved
      0x00, 0x00,
      // layer
      0x00, 0x00,
      // alternate_group
      (track.type === 'audio' ? 0x01 : 0x00), 0x00,
      // non-audio track volume
      0x00, 0x00,
      // reserved
      0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
      // transformation: unity matrix
      width >> 8 & 0xff, width & 0xff, 0x00, 0x00,
      // width
      height >> 8 & 0xff, height & 0xff, 0x00, 0x00, // height
    ]));
  }



  /**
   * @param {Array<number>} segment_durations - In the movie's timescale.
   * @param {Array<number>} media_times - In the track's timescale; -1 for an empty edit.
   * @return {Uint8Array}
   */
  static elst(segment_durations, media_times) {
    // FastStream: version 1 counts in 64 bits. The movie timescale is the first track's,
    // and a DASH video track's can be 10 MHz: 32 bits ran out after 7 minutes, and the
    // edit wrapped to a fraction of the media. An edit that fits stays version 0.
    const wide = segment_durations.some((duration) => duration > UINT32_MAX) ||
      media_times.some((time) => time > 0x7fffffff || time < -0x80000000);
    const entrySize = wide ? 20 : 12;
    const entries = new ArrayBuffer(8 + segment_durations.length * entrySize);
    const view = new DataView(entries);


    view.setUint32(0, wide ? 1 << 24 : 0); // version and flags
    view.setUint32(4, segment_durations.length); // entry count
    let offset = 8;

    for (let i = 0; i < segment_durations.length; i++) {
      if (wide) {
        view.setBigUint64(offset, BigInt(segment_durations[i]));
        offset += 8;
        view.setBigInt64(offset, BigInt(media_times[i]));
        offset += 8;
      } else {
        view.setUint32(offset, segment_durations[i]);
        offset += 4;
        view.setInt32(offset, media_times[i]);
        offset += 4;
      }
      view.setUint32(offset, 1 << 16);
      offset += 4;
    }
    return MP4.box(MP4.types.elst, new Uint8Array(entries));
  }
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static edts(track) {
    /** @type {Array<number>} */
    const segment_durations = [];
    /** @type {Array<number>} */
    const media_times = [];


    const len = track.elst.length;
    for (let i = 0; i < len; i++) {
      const entry = track.elst[i];
      segment_durations.push(entry.segment_duration);
      media_times.push(entry.media_time);
    }
    return MP4.box(MP4.types.edts, MP4.elst(segment_durations, media_times));
  }
  /**
     * Generate a track box.
     * @param track {object} a track definition
     * @return {Uint8Array} the track box
     */
  /**
   * @param {Mp4Track} track
   * @return {Uint8Array}
   */
  static trak(track) {
    track.duration = track.duration || 0xffffffff;
    return MP4.box(MP4.types.trak, MP4.tkhd(track), MP4.mdia(track), MP4.edts(track));
  }

  /**
   * @param {Array<Mp4Track>} tracks
   * @return {Uint8Array<ArrayBuffer>} ftyp and moov.
   */
  static initSegment(tracks) {
    if (!MP4.types) {
      MP4.init();
    }
    const movie = MP4.moov(tracks);
    const result = new Uint8Array(MP4.FTYP.byteLength + movie.byteLength);
    result.set(MP4.FTYP);
    result.set(movie, MP4.FTYP.byteLength);
    return result;
  }
}
