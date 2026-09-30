import {EncodedAudioPacketSource, EncodedVideoPacketSource, Mp4OutputFormat, Output, StreamTarget} from './mediabunny.mjs';
import {TimestampRebaser} from './TimestampRebaser.mjs';

// The file is kept in RAM in pieces of this size, and each piece that is full moves to
// the blob manager (disk).
const PIECE_SIZE = 16 * 1024 * 1024;

/**
 * Writes packets copied from a stream into a fragmented MP4, with Mediabunny.
 *
 * Takes Mediabunny's packets as its readers give them, in decode order per track, and
 * gives the file back as a Blob. The file starts at 0: see TimestampRebaser.mjs.
 */
export class MP4Writer {
  /**
   * @param {Object} blobManager the FSBlob full pieces move to
   * @param {{video: ?string, audio: ?string}} tracks each track's codec as Mediabunny
   *     names it ('vp9', 'opus', ...), or null for a track the file does not have
   * @param {number} [pieceSize] how much to keep in RAM at a time, for the tests
   */
  constructor(blobManager, tracks, pieceSize = PIECE_SIZE) {
    this.blobManager = blobManager;
    this.pieceSize = pieceSize;
    this.pieces = [];
    this.error = null;
    // One packet at a time, in the order they came: the muxer takes a track's packets in
    // decode order.
    this.muxing = Promise.resolve();

    this.sources = {};
    if (tracks.video) {
      this.sources.video = new EncodedVideoPacketSource(tracks.video);
    }
    if (tracks.audio) {
      this.sources.audio = new EncodedAudioPacketSource(tracks.audio);
    }
    this.rebaser = new TimestampRebaser(Object.keys(this.sources), (track, timestamp, item) => {
      this.mux(track, timestamp, item);
    });

    this.output = new Output({
      format: new Mp4OutputFormat({fastStart: 'fragmented'}),
      target: new StreamTarget(new WritableStream({
        write: (chunk) => {
          if (chunk.type !== 'write') {
            throw new Error(`MP4Writer: Mediabunny sent a ${chunk.type} chunk`);
          }
          this.store(chunk.data, chunk.position);
        },
      })),
    });
    if (this.sources.video) {
      this.output.addVideoTrack(this.sources.video);
    }
    if (this.sources.audio) {
      this.output.addAudioTrack(this.sources.audio);
    }
  }

  /**
   * Opens the file. Packets can be added after this resolves.
   */
  async start() {
    await this.output.start();
  }

  /**
   * Adds a packet.
   *
   * @param {string} track 'video' or 'audio'
   * @param {EncodedPacket} packet the next of its track, in decode order
   * @param {Object} [meta] the first packet of a track carries its decoder config:
   *     `{decoderConfig}`
   * @return {Promise<void>} resolves once the file has taken it (the first packets wait in
   *     TimestampRebaser until every track has sent one), and rejects with the first error
   *     the file hit
   */
  add(track, packet, meta) {
    if (!this.error) {
      try {
        // Whole microseconds: seconds would gather float error in the subtraction.
        this.rebaser.push(track, packet.microsecondTimestamp, {packet, meta});
      } catch (e) {
        this.fail(e);
      }
    }
    return this.muxing.then(() => {
      if (this.error) {
        throw this.error;
      }
    });
  }

  /**
   * Queues a packet the rebaser passed on.
   *
   * @param {string} track 'video' or 'audio'
   * @param {number} timestamp the packet's, moved, in microseconds
   * @param {{packet: EncodedPacket, meta: Object}} item
   */
  mux(track, timestamp, {packet, meta}) {
    const moved = packet.clone({timestamp: timestamp / 1e6});
    const source = this.sources[track];
    this.muxing = this.muxing
        .then(() => this.error ? undefined : source.add(moved, meta))
        .catch((e) => this.fail(e));
  }

  /**
   * @param {Error} e
   */
  fail(e) {
    if (!this.error) {
      this.error = e;
    }
  }

  /**
   * Finishes the file, once every chunk has been added.
   *
   * @return {Promise<Blob>} the MP4
   */
  async finalize() {
    this.rebaser.flush();
    await this.muxing;
    if (this.error) {
      throw this.error;
    }
    await this.output.finalize();
    return this.assemble();
  }

  /**
   * Stops writing. Does nothing once finalize() has begun.
   */
  async cancel() {
    if (this.output.state === 'pending' || this.output.state === 'started') {
      await this.output.cancel();
    }
  }

  /**
   * Puts data where Mediabunny says it goes. A piece moves to the blob manager as soon
   * as it is full; Mediabunny writes a fragmented MP4 front to back, so nothing comes
   * back to a piece after that.
   *
   * @param {Uint8Array} data
   * @param {number} position where data starts in the file
   */
  store(data, position) {
    const pieceSize = this.pieceSize;
    const startPos = position;
    const endPos = position + data.byteLength;
    const startPiece = Math.floor(startPos / pieceSize);
    const endPiece = Math.floor((endPos - 1) / pieceSize);

    for (let i = startPiece; i <= endPiece; i++) {
      let piece = this.pieces[i];
      if (!piece) {
        piece = {
          filledRanges: [],
          data: new Uint8Array(pieceSize),
          flushed: false,
        };
        this.pieces[i] = piece;
      }

      if (piece.flushed) {
        throw new Error('MP4Writer: data came back to a piece already moved to disk');
      }

      const start = Math.max(startPos, i * pieceSize);
      const end = Math.min(endPos, (i + 1) * pieceSize);
      const offset = start - i * pieceSize;
      const length = end - start;

      piece.data.set(data.subarray(start - startPos, end - startPos), offset);
      piece.filledRanges.push([offset, offset + length]);

      // Merge filled ranges
      const newFilledRanges = [];
      const ranges = piece.filledRanges;
      let last;
      ranges.sort(function(a, b) {
        return a[0]-b[0] || a[1]-b[1];
      });
      ranges.forEach(function(r) {
        if (!last || r[0] > last[1]) {
          newFilledRanges.push(last = r);
        } else if (r[1] > last[1]) {
          last[1] = r[1];
        }
      });
      piece.filledRanges = newFilledRanges;

      // Check if the piece is full
      if (piece.filledRanges.length === 1 && piece.filledRanges[0][0] === 0 && piece.filledRanges[0][1] === pieceSize) {
        piece.data = this.blobManager.createBlob(piece.data);
        piece.flushed = true;
      }
    }
  }

  /**
   * @return {Promise<Blob>} the pieces, back in one file
   */
  async assemble() {
    // Every piece but the last is full and on disk
    for (let i = 0; i < this.pieces.length; i++) {
      if (!this.pieces[i]) {
        throw new Error('MP4Writer: a piece of the file was never written');
      }
    }

    const data = await Promise.all(this.pieces.map((piece, i) => {
      if (piece.flushed) {
        return this.blobManager.getBlob(piece.data);
      } else if (i === this.pieces.length - 1) {
        // Last piece: up to where it was filled
        const end = piece.filledRanges[piece.filledRanges.length - 1][1];
        return piece.data.slice(0, end);
      } else {
        throw new Error('MP4Writer: a piece before the last was never filled');
      }
    }));

    return new Blob(data, {
      type: 'video/mp4',
    });
  }
}
