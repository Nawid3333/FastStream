// @ts-check

// Relabels an AAC program config element (channelConfiguration 0) that Windows' decoder (WMF) plays as silence.

/** Reads bits, most significant first. */
class BitReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }

  /**
   * @param {number} count - Up to 24.
   * @return {number}
   */
  read(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.pos >= this.bytes.length * 8) {
        throw new RangeError('past the end');
      }
      const bit = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
      value = (value << 1) | bit;
      this.pos++;
    }
    return value;
  }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} pos
 * @param {number} count
 * @param {number} value
 */
function writeBits(bytes, pos, count, value) {
  for (let i = 0; i < count; i++) {
    const bit = (value >> (count - 1 - i)) & 1;
    const at = pos + i;
    const mask = 1 << (7 - (at & 7));
    bytes[at >> 3] = bit ? (bytes[at >> 3] | mask) : (bytes[at >> 3] & ~mask);
  }
}

/**
 * The AudioSpecificConfig relabelled so that Windows' decoder takes it, or null when it needs nothing.
 * @param {Uint8Array} asc
 * @return {?Uint8Array} A new array as long as the old one, or null.
 */
export function windowsAacLayout(asc) {
  try {
    const bits = new BitReader(asc);
    const objectType = bits.read(5);
    // AAC Main, LC, SSR and LTP; not HE-AAC's hierarchical signalling (5, 29).
    if (objectType < 1 || objectType > 4) return null;
    if (bits.read(4) === 15) bits.read(24);
    if (bits.read(4) !== 0) return null;
    // GASpecificConfig: frameLengthFlag, dependsOnCoreCoder (and its delay), extensionFlag; the PCE follows.
    bits.read(1);
    if (bits.read(1)) bits.read(14);
    bits.read(1);

    bits.read(4 + 2 + 4); // element_instance_tag, object_type, sampling_frequency_index
    const countsAt = bits.pos;
    const front = bits.read(4);
    const side = bits.read(4);
    const back = bits.read(4);
    bits.read(2 + 3 + 4); // LFE, data and coupling elements: after the three groups
    if (bits.read(1)) bits.read(4); // mono mixdown
    if (bits.read(1)) bits.read(4); // stereo mixdown
    if (bits.read(1)) bits.read(3); // matrix mixdown
    const elementsAt = bits.pos;
    /** @type {Array<{cpe: number, tag: number}>} */
    const elements = [];
    for (let i = 0; i < front + side + back; i++) {
      elements.push({cpe: bits.read(1), tag: bits.read(4)});
    }
    const groups = {
      front: elements.slice(0, front),
      side: elements.slice(front, front + side),
      back: elements.slice(front + side),
    };

    let changed = false;
    // The front centre first.
    const frontCentres = groups.front.filter((e) => !e.cpe);
    if (frontCentres.length === 1 && groups.front[0].cpe) {
      groups.front = [frontCentres[0], ...groups.front.filter((e) => e.cpe)];
      changed = true;
    }
    // A lone side channel to the back centre, where there is none.
    const sideSingles = groups.side.filter((e) => !e.cpe);
    if (sideSingles.length === 1 && !groups.back.some((e) => !e.cpe)) {
      groups.side = groups.side.filter((e) => e.cpe);
      groups.back = [...groups.back, sideSingles[0]];
      changed = true;
    } else if (sideSingles.length > 0) {
      return null;
    }
    if (!changed) return null;

    const out = new Uint8Array(asc);
    writeBits(out, countsAt, 4, groups.front.length);
    writeBits(out, countsAt + 4, 4, groups.side.length);
    writeBits(out, countsAt + 8, 4, groups.back.length);
    let pos = elementsAt;
    for (const e of [...groups.front, ...groups.side, ...groups.back]) {
      writeBits(out, pos, 1, e.cpe);
      writeBits(out, pos + 1, 4, e.tag);
      pos += 5;
    }
    return out;
  } catch (e) {
    // Shorter than it says: not ours to mend.
    return null;
  }
}

/**
 * An MPEG-4 descriptor's tag and length (ISO/IEC 14496-1: up to four bytes of seven bits).
 * @param {Uint8Array} bytes
 * @param {number} at
 * @return {?{tag: number, length: number, body: number}} body: where its content starts.
 */
function descriptorAt(bytes, at) {
  if (at >= bytes.length) return null;
  const tag = bytes[at];
  let length = 0;
  let pos = at + 1;
  for (let i = 0; i < 4; i++) {
    if (pos >= bytes.length) return null;
    const byte = bytes[pos++];
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return {tag, length, body: pos};
}

/**
 * Relabels the AAC layout in an esds box's ES_Descriptor, in place (windowsAacLayout).
 * @param {Uint8Array} esd
 * @return {boolean} Whether it changed anything.
 */
export function relabelEsdsAacLayout(esd) {
  const es = descriptorAt(esd, 0);
  if (!es || es.tag !== 0x03) return false;
  let pos = es.body + 2; // ES_ID
  const flags = esd[pos++];
  if (flags & 0x80) pos += 2; // streamDependenceFlag: dependsOn_ES_ID
  if (flags & 0x40) pos += 1 + (esd[pos] || 0); // URL_Flag: URLlength, URLstring
  if (flags & 0x20) pos += 2; // OCRstreamFlag: OCR_ES_Id
  const config = descriptorAt(esd, pos);
  if (!config || config.tag !== 0x04) return false;
  // 0x40: MPEG-4 audio, whose DecoderSpecificInfo is the AudioSpecificConfig.
  // The 13 bytes before it: objectTypeIndication, streamType, bufferSizeDB, the bitrates.
  if (esd[config.body] !== 0x40) return false;
  const info = descriptorAt(esd, config.body + 13);
  if (!info || info.tag !== 0x05 || info.body + info.length > esd.length) return false;
  const asc = esd.subarray(info.body, info.body + info.length);
  const relabelled = windowsAacLayout(asc);
  if (!relabelled) return false;
  asc.set(relabelled);
  return true;
}
