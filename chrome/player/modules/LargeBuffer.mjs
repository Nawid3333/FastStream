// @ts-check
export class LargeBuffer {
  /**
   * @param {number} byteLength - The file's size in bytes.
   * @param {number} bufferLength - How many chunks it comes in.
   */
  constructor(byteLength, bufferLength) {
    this.byteLength = byteLength;
    this.bufferLength = bufferLength;
    this.currentBuffer = null;
    this.nextPreloadedBuffer = null;
    this.offset = 0;
    this.index = 0;
    this.bufferIndex = 0;
  }

  /**
   * @param {(index: number) => Promise<Uint8Array>} getBufferFn - Fetches a chunk by its index.
   */
  async initialize(getBufferFn) {
    /** @type {(index: number) => Promise<Uint8Array>} */
    this.getBuffer = getBufferFn;
    this.nextPreloadedBuffer = this.getBuffer(this.bufferIndex);
    return this.nextBuffer();
  }

  async nextBuffer() {
    this.index = 0;
    this.bufferIndex++;
    const preloaded = this.nextPreloadedBuffer;
    // Past the last chunk there is none: the last one stayed queued, so a read past the
    // end of chunks that came back shorter than asked (a server answering a range short)
    // got the last chunk's bytes again instead of the error below.
    this.nextPreloadedBuffer = this.bufferIndex < this.bufferLength ? this.getBuffer(this.bufferIndex) : null;
    this.currentBuffer = preloaded ? await preloaded : null;
  }

  /**
   * @param {number} length - Bytes to read.
   * @return {Promise<Uint8Array[]>} Views of the chunks that hold them, in order.
   */
  async getParts(length) {
    // Lengths come from the file itself (an archive's headers): a negative one, or one
    // that is no number, read nothing, and the next read started in the wrong place.
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Invalid length ' + length);
    }
    const parts = [];
    this.offset += length;
    if (this.offset > this.byteLength) {
      throw new Error('Index ' + this.offset + ' out of range');
    }

    while (length > 0) {
      if (this.currentBuffer && this.index >= this.currentBuffer.byteLength) {
        await this.nextBuffer();
      }

      if (!this.currentBuffer) {
        throw new Error('Buffer ' + this.bufferIndex + ' not found');
      }

      const newlen = Math.min(this.currentBuffer.byteLength - this.index, length);
      parts.push(this.currentBuffer.subarray(this.index, this.index + newlen));

      this.index += newlen;
      length = length - newlen;
    }
    return parts;
  }

  /**
   * @param {number} length - Bytes to read.
   * @return {Promise<Uint8Array>}
   */
  async read(length) {
    // Checked first: a length from a damaged or crafted archive asked for up to 4 GB of
    // memory before it was found out of range.
    const parts = await this.getParts(length);
    const uint8 = new Uint8Array(length);
    let offset = 0;

    for (let i = 0; i < parts.length; i++) {
      uint8.set(parts[i], offset);
      offset += parts[i].byteLength;
    }

    return uint8;
  }

  async uint8() {
    return (await this.read(1))[0];
  }

  async uint16() {
    const arr = await this.read(2);
    return (arr[0] << 8) | arr[1];
  }

  async uint32() {
    const arr = await this.read(4);
    // >>> 0: `<< 24` is signed, and a size from 2 GB up came out negative.
    return ((arr[0] << 24) | (arr[1] << 16) | (arr[2] << 8) | arr[3]) >>> 0;
  }
}
