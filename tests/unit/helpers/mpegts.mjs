// Builds MPEG transport streams for the HLS save's tests: a PAT, a PMT and PES packets
// with the timestamps a test asks for, around access units made from real parameter sets.
//
// The parameter sets were taken from 64x64 encodes of ffmpeg's testsrc2 (libopenh264 for
// H.264, libkvazaar for HEVC). The slices are only their first bytes: hls.js reads a
// slice's NAL type and first header bits to find frames and keyframes, never the picture,
// and the tests check the boxes written around the data, not what it decodes to.

const PACKET = 188;
const PAT_PID = 0;
const PMT_PID = 0x1000;

export const VIDEO_PID = 0x100;
export const AUDIO_PID = 0x101;

/** The 90 kHz clock MPEG-TS timestamps count in. */
export const TS_CLOCK = 90000;

/** PMT stream types. */
export const StreamTypes = {
  H264: 0x1b,
  HEVC: 0x24,
  AAC: 0x0f,
  MP3: 0x03,
};

const hex = (text) => Uint8Array.from(text.match(/../g).map((byte) => parseInt(byte, 16)));

const H264 = {
  aud: hex('09f0'),
  sps: hex('6742c0148c68424c0407844235'),
  pps: hex('68ce3c80'),
  idr: hex('65b8000409f88445401811d59f80229b'),
  slice: hex('61e0007e409fe0bf80a266d52023d5ee'),
};

const HEVC = {
  aud: hex('460150'),
  vps: hex('40010c02ffff0160000003008000000300000300ba000004021024'),
  sps: hex('4201020160000003008000000300000300ba0000a0208105b04021924cab01010000030001000003001908'),
  pps: hex('4401c062460a6480'),
  idr: hex('2601af3e6ab4091be829df3ae1e58e4f'),
  slice: hex('0201d08527f118845b1c8d8236191205'),
};

/** The parameter sets the access units carry, for checking what the writer copies. */
export const ParameterSets = {H264, HEVC};

/**
 * @param {Uint8Array[]} nals
 * @return {Uint8Array} the units in Annex B byte stream form
 */
function annexB(nals) {
  const out = [];
  for (const nal of nals) {
    out.push(0, 0, 0, 1, ...nal);
  }
  return Uint8Array.from(out);
}

/**
 * One H.264 picture: an access unit delimiter, the parameter sets before a keyframe, and a
 * slice.
 * @param {boolean} key whether it is an IDR picture
 * @return {Uint8Array}
 */
export function h264AccessUnit(key) {
  return annexB(key ? [H264.aud, H264.sps, H264.pps, H264.idr] : [H264.aud, H264.slice]);
}

/**
 * One HEVC picture, as h264AccessUnit.
 * @param {boolean} key whether it is an IDR picture
 * @return {Uint8Array}
 */
export function hevcAccessUnit(key) {
  return annexB(key ? [HEVC.aud, HEVC.vps, HEVC.sps, HEVC.pps, HEVC.idr] : [HEVC.aud, HEVC.slice]);
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

/**
 * One AAC-LC frame (1024 samples) in an ADTS header. The payload is not real AAC; hls.js
 * reads only the header.
 * @param {number} sampleRate one of the ADTS rates
 * @param {number} [channels]
 * @return {Uint8Array}
 */
export function adtsFrame(sampleRate, channels = 2) {
  const rateIndex = ADTS_RATES.indexOf(sampleRate);
  if (rateIndex === -1) {
    throw new Error(`no ADTS index for ${sampleRate} Hz`);
  }
  const payload = [0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c];
  const length = 7 + payload.length;
  const profile = 1; // AAC LC, written as the object type minus one
  return Uint8Array.from([
    0xff, 0xf1,
    (profile << 6) | (rateIndex << 2) | (channels >> 2),
    ((channels & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc,
    ...payload,
  ]);
}

/**
 * One MPEG-1 Layer III frame: 1152 samples at 44100 Hz, 128 kbit/s, so 417 bytes. The
 * payload after the header is not real MP3; hls.js reads only the header.
 * @return {Uint8Array}
 */
export function mp3Frame() {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x44]);
  return frame;
}

/**
 * CRC-32/MPEG-2, which closes every PSI section.
 * @param {number[]} bytes
 * @return {number}
 */
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    }
  }
  return crc >>> 0;
}

/**
 * @param {number} tableId
 * @param {number} idExtension
 * @param {number[]} body
 * @return {number[]} the section with its pointer field and CRC
 */
function section(tableId, idExtension, body) {
  const length = 5 + body.length + 4;
  const bytes = [
    tableId, 0xb0 | (length >> 8), length & 0xff,
    idExtension >> 8, idExtension & 0xff, 0xc1, 0x00, 0x00,
    ...body,
  ];
  const crc = crc32(bytes);
  return [0x00, ...bytes, crc >>> 24, (crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff];
}

/**
 * A 33-bit timestamp in the PES header's five bytes.
 * @param {number} prefix 0b0010 for a lone PTS, 0b0011/0b0001 for PTS/DTS of a pair
 * @param {number} value in 90 kHz ticks; wrapped at 2^33
 * @return {number[]}
 */
function timestamp(prefix, value) {
  const ts = ((value % 2 ** 33) + 2 ** 33) % 2 ** 33;
  const high = Math.floor(ts / 2 ** 30);
  const mid = Math.floor(ts / 2 ** 15) & 0x7fff;
  const low = ts & 0x7fff;
  return [
    (prefix << 4) | (high << 1) | 1,
    mid >> 7, ((mid & 0x7f) << 1) | 1,
    low >> 7, ((low & 0x7f) << 1) | 1,
  ];
}

/**
 * @param {number} streamId 0xe0 for video, 0xc0 for audio
 * @param {{pts: number, dts?: number, data: Uint8Array}} unit times in 90 kHz ticks
 * @return {Uint8Array}
 */
function pes(streamId, {pts, dts, data}) {
  const hasDts = dts !== undefined && dts !== pts;
  const times = hasDts ? [...timestamp(3, pts), ...timestamp(1, dts)] : timestamp(2, pts);
  const header = [0x80, hasDts ? 0xc0 : 0x80, times.length, ...times];
  const length = header.length + data.length;
  return Uint8Array.from([
    0x00, 0x00, 0x01, streamId,
    length > 0xffff ? 0 : length >> 8, length > 0xffff ? 0 : length & 0xff,
    ...header, ...data,
  ]);
}

/**
 * Cuts a payload into 188-byte packets, the last one padded with an adaptation field.
 * @param {number} pid
 * @param {Uint8Array|number[]} payload
 * @param {Map<number, number>} counters continuity counters by PID
 * @return {number[][]}
 */
function packetize(pid, payload, counters) {
  const packets = [];
  let offset = 0;
  let first = true;
  do {
    const counter = counters.get(pid) ?? 0;
    counters.set(pid, (counter + 1) & 0x0f);
    const room = PACKET - 4;
    const take = Math.min(room, payload.length - offset);
    const header = [0x47, (first ? 0x40 : 0) | (pid >> 8), pid & 0xff];
    const packet = [];
    if (take < room) {
      const stuffing = room - take;
      header.push(0x30 | counter);
      packet.push(...header, stuffing - 1);
      if (stuffing > 1) {
        packet.push(0x00, ...new Array(stuffing - 2).fill(0xff));
      }
    } else {
      header.push(0x10 | counter);
      packet.push(...header);
    }
    for (let i = 0; i < take; i++) {
      packet.push(payload[offset + i]);
    }
    packets.push(packet);
    offset += take;
    first = false;
  } while (offset < payload.length);
  return packets;
}

/**
 * Muxes one transport stream segment.
 *
 * @param {Object} streams
 * @param {{type: number, units: Array<{pts: number, dts?: number, data: Uint8Array}>}} [streams.video]
 * @param {{type: number, units: Array<{pts: number, data: Uint8Array}>}} [streams.audio]
 * @return {Uint8Array} the segment: PAT, PMT, then each unit as a PES, video and audio in
 *     the order of their decode times
 */
export function muxSegment({video, audio}) {
  const counters = new Map();
  const entries = [];
  if (video) entries.push(video.type, 0xe0 | (VIDEO_PID >> 8), VIDEO_PID & 0xff, 0xf0, 0x00);
  if (audio) entries.push(audio.type, 0xe0 | (AUDIO_PID >> 8), AUDIO_PID & 0xff, 0xf0, 0x00);
  const pcrPid = video ? VIDEO_PID : AUDIO_PID;
  const packets = [
    ...packetize(PAT_PID, section(0x00, 1, [0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff]), counters),
    ...packetize(PMT_PID, section(0x02, 1, [0xe0 | (pcrPid >> 8), pcrPid & 0xff, 0xf0, 0x00, ...entries]), counters),
  ];

  const queue = [
    ...(video?.units || []).map((unit) => ({pid: VIDEO_PID, stream: 0xe0, unit, at: unit.dts ?? unit.pts})),
    ...(audio?.units || []).map((unit) => ({pid: AUDIO_PID, stream: 0xc0, unit, at: unit.pts})),
  ].sort((a, b) => a.at - b.at);
  for (const {pid, stream, unit} of queue) {
    packets.push(...packetize(pid, pes(stream, unit), counters));
  }
  return Uint8Array.from(packets.flat());
}

/**
 * The timestamps of a video stream in decode order: a keyframe every `gop` pictures, and,
 * with `bFrames`, each P picture sent ahead of the B pictures it is shown after, the way an
 * encoder with one B picture between references sends them.
 *
 * @param {Object} options
 * @param {number} options.start the first picture's presentation time, in 90 kHz ticks
 * @param {number} options.count how many pictures
 * @param {number} options.frame one picture's duration, in 90 kHz ticks
 * @param {boolean} [options.bFrames] whether pictures are reordered
 * @param {function(boolean): Uint8Array} options.picture makes an access unit
 * @return {Array<{pts: number, dts: number, data: Uint8Array}>}
 */
export function videoUnits({start, count, frame, bFrames = false, picture}) {
  const units = [];
  // Without reordering a picture is decoded when it is shown. With it, decoding runs one
  // picture ahead: the decode clock starts a frame before the first picture is shown.
  const delay = bFrames ? frame : 0;
  for (let i = 0; i < count; i++) {
    let shown = i;
    if (bFrames && i > 0) {
      // Decode order 0, 2, 1, 4, 3, ...: each pair sends the later picture first (a last
      // picture with no pair goes as it is).
      shown = i % 2 === 1 ? (i + 1 < count ? i + 1 : i) : i - 1;
    }
    units.push({
      pts: start + shown * frame,
      dts: start - delay + i * frame,
      data: picture(i === 0),
    });
  }
  return units;
}

/**
 * The timestamps of an AAC stream, one frame per PES.
 * @param {Object} options
 * @param {number} options.start the first frame's time, in 90 kHz ticks
 * @param {number} options.count how many frames
 * @param {number} options.sampleRate
 * @return {Array<{pts: number, data: Uint8Array}>}
 */
export function audioUnits({start, count, sampleRate}) {
  const units = [];
  for (let i = 0; i < count; i++) {
    units.push({
      pts: Math.round(start + i * 1024 * TS_CLOCK / sampleRate),
      data: adtsFrame(sampleRate),
    });
  }
  return units;
}
