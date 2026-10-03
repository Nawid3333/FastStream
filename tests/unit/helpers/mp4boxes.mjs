// Reads back the boxes the save's MP4 writers put in a file, for the tests to check the
// bytes themselves: which version a box was written in, signed or unsigned fields, the
// edit list. Only what the tests look at is decoded.

/**
 * @typedef {Object} Box
 * @property {string} type
 * @property {number} start where the box starts in the file
 * @property {number} size
 * @property {DataView} body the box after its header
 * @property {Box[]} children for container boxes
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

/**
 * @param {Uint8Array} bytes
 * @param {number} [start]
 * @param {number} [end]
 * @return {Box[]}
 */
export function readBoxes(bytes, start = 0, end = bytes.byteLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) {
      throw new Error(`box ${type} at ${offset} runs past its parent (${size} bytes)`);
    }
    const box = {
      type,
      start: offset,
      size,
      body: new DataView(bytes.buffer, bytes.byteOffset + offset + header, size - header),
      children: CONTAINERS.has(type) ? readBoxes(bytes, offset + header, offset + size) : [],
    };
    boxes.push(box);
    offset += size;
  }
  if (offset !== end) {
    throw new Error(`${end - offset} stray bytes after the last box`);
  }
  return boxes;
}

/**
 * @param {Box[]} boxes
 * @param {string} path box types separated by '/', e.g. 'mdia/minf/stbl/ctts'
 * @return {Box|undefined}
 */
export function find(boxes, path) {
  let found;
  let level = boxes;
  for (const type of path.split('/')) {
    found = level.find((box) => box.type === type);
    if (!found) return undefined;
    level = found.children;
  }
  return found;
}

/**
 * @param {DataView} body
 * @param {number} offset
 * @param {boolean} wide whether the field is 64-bit
 * @param {boolean} [signed]
 * @return {number}
 */
function field(body, offset, wide, signed = false) {
  if (wide) {
    return Number(signed ? body.getBigInt64(offset) : body.getBigUint64(offset));
  }
  return signed ? body.getInt32(offset) : body.getUint32(offset);
}

/**
 * @param {Box} box an elst
 * @return {{version: number, entries: Array<{duration: number, mediaTime: number}>}}
 */
export function readElst(box) {
  const body = box.body;
  const version = body.getUint8(0);
  const count = body.getUint32(4);
  const wide = version === 1;
  const entries = [];
  let offset = 8;
  for (let i = 0; i < count; i++) {
    const duration = field(body, offset, wide);
    const mediaTime = field(body, offset + (wide ? 8 : 4), wide, true);
    entries.push({duration, mediaTime});
    offset += wide ? 20 : 12;
  }
  return {version, entries};
}

/**
 * @param {Box} box a ctts
 * @return {{version: number, offsets: number[]}} one composition offset per sample, read
 *     as the box's version says: unsigned in version 0, signed in version 1
 */
export function readCtts(box) {
  const body = box.body;
  const version = body.getUint8(0);
  const count = body.getUint32(4);
  const offsets = [];
  for (let i = 0; i < count; i++) {
    const samples = body.getUint32(8 + i * 8);
    const offset = version === 1 ? body.getInt32(12 + i * 8) : body.getUint32(12 + i * 8);
    for (let j = 0; j < samples; j++) offsets.push(offset);
  }
  return {version, offsets};
}

/**
 * @param {Box} box an stts
 * @return {number[]} one duration per sample
 */
export function readStts(box) {
  const body = box.body;
  const count = body.getUint32(4);
  const durations = [];
  for (let i = 0; i < count; i++) {
    const samples = body.getUint32(8 + i * 8);
    const delta = body.getUint32(12 + i * 8);
    for (let j = 0; j < samples; j++) durations.push(delta);
  }
  return durations;
}

/**
 * @param {Box} box an mvhd or mdhd (both carry the timescale at the same place)
 * @return {number}
 */
export function readTimescale(box) {
  return box.body.getUint32(box.body.getUint8(0) === 1 ? 20 : 12);
}

/**
 * @param {Box} box an stsd
 * @return {{type: string, entry: Uint8Array}} the first sample entry and its bytes
 */
export function readSampleEntry(box) {
  const body = box.body;
  const size = body.getUint32(8);
  const entry = new Uint8Array(body.buffer, body.byteOffset + 8, size);
  return {type: String.fromCharCode(...entry.subarray(4, 8)), entry};
}

/**
 * What a player shows of one track, on the movie's timeline.
 *
 * @param {Box[]} file the file's top-level boxes
 * @param {Box} trak
 * @return {{handler: string, timescale: number, movieTimescale: number, elst: Object,
 *     ctts: ?Object, durations: number[], firstShown: number, mediaEnd: number,
 *     editEnd: number}} firstShown is when the track's first picture or sound appears, in
 *     movie seconds; mediaEnd when its last presented sample ends, in media seconds from the
 *     edit's start; editEnd when the edit list stops showing it, in movie seconds
 */
export function describeTrack(file, trak) {
  const movieTimescale = readTimescale(find(file, 'moov/mvhd'));
  const timescale = readTimescale(find(trak.children, 'mdia/mdhd'));
  const hdlr = find(trak.children, 'mdia/hdlr').body;
  const handler = String.fromCharCode(hdlr.getUint8(8), hdlr.getUint8(9), hdlr.getUint8(10), hdlr.getUint8(11));
  const elst = readElst(find(trak.children, 'edts/elst'));
  const cttsBox = find(trak.children, 'mdia/minf/stbl/ctts');
  const ctts = cttsBox ? readCtts(cttsBox) : null;
  const durations = readStts(find(trak.children, 'mdia/minf/stbl/stts'));

  let delay = 0;
  let edit = null;
  for (const entry of elst.entries) {
    if (entry.mediaTime === -1) {
      delay += entry.duration;
    } else {
      edit = entry;
      break;
    }
  }
  if (!edit) {
    throw new Error('the edit list shows none of the media');
  }

  let decode = 0;
  let earliest = Infinity;
  let latest = -Infinity;
  durations.forEach((duration, i) => {
    const shown = decode + (ctts ? ctts.offsets[i] : 0);
    earliest = Math.min(earliest, shown);
    latest = Math.max(latest, shown + duration);
    decode += duration;
  });

  return {
    handler,
    timescale,
    movieTimescale,
    elst,
    ctts,
    durations,
    firstShown: delay / movieTimescale + Math.max(0, earliest - edit.mediaTime) / timescale,
    mediaEnd: (latest - edit.mediaTime) / timescale,
    editEnd: (delay + edit.duration) / movieTimescale,
  };
}

/**
 * @param {Uint8Array} bytes a whole MP4
 * @return {{boxes: Box[], tracks: Object[]}} the top-level boxes, and describeTrack() of
 *     each track, by handler: {vide: ..., soun: ...}
 */
export function readMp4(bytes) {
  const boxes = readBoxes(bytes);
  const moov = find(boxes, 'moov');
  const tracks = {};
  for (const trak of moov.children.filter((box) => box.type === 'trak')) {
    const track = describeTrack(boxes, trak);
    track.trak = trak;
    tracks[track.handler] = track;
  }
  return {boxes, tracks};
}
