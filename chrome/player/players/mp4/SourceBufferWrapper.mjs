// @ts-check
import {EventEmitter} from '../../modules/eventemitter.mjs';

/**
 * @typedef {{resolve: (value: void) => void, reject: (reason?: unknown) => void} & ({type: 'append', buffer: BufferSource, media?: boolean} |
 *   {type: 'remove', start: number, end: number} | {type: 'changeType', mimeType: string})} SourceBufferOp
 */

export class SourceBufferWrapper extends EventEmitter {
  /**
   * @param {MediaSource} mediaSource
   * @param {string} codec - As isTypeSupported takes it.
   */
  constructor(mediaSource, codec) {
    super();
    if (!MediaSource.isTypeSupported(codec)) {
      throw new Error('Codec not supported: ' + codec);
    }
    this.sourceBuffer = mediaSource.addSourceBuffer(codec);
    this.updating = false;
    // Held: starts no further operation until released (DurationSync).
    this.held = false;
    /** @type {?(SourceBufferOp & {type: 'remove'})} */
    this.removing = null;
    /** @type {Array<SourceBufferOp>} */
    this.toDo = [];
    this.disposed = false;
    this.onUpdateEnd = () => {
      this.updating = false;
      this.removing = null;
      this.emit('updateend');
      this.sourceBufferDo();
    };
    this.sourceBuffer.addEventListener('updateend', this.onUpdateEnd);
  }

  /** The player is destroyed: what is queued is dropped unsettled, and nothing starts any more. */
  dispose() {
    this.disposed = true;
    this.toDo.length = 0;
    this.sourceBuffer.removeEventListener('updateend', this.onUpdateEnd);
  }

  /**
   * Whether a removal over time is queued or running: until it has run, buffered still holds it.
   * @param {number} time - Seconds.
   * @return {boolean}
   */
  hasPendingRemove(time) {
    /** @param {?{start: number, end: number}} op */
    const covers = (op) => !!op && time >= op.start && time <= op.end;
    return covers(this.removing) || this.toDo.some((op) => op.type === 'remove' && covers(op));
  }
  abort() {
    // abort() throws while a removal runs, and a removal has nothing to abort.
    try {
      this.sourceBuffer.abort();
    } catch (e) {
      console.warn('SourceBuffer.abort refused', e);
    }
  }

  /**
   * @param {BufferSource} buffer
   * @param {{media?: boolean}} [options] - media: a media segment, which dropQueuedMedia may drop.
   * @return {Promise<void>} Resolves once the SourceBuffer took it.
   */
  appendBuffer(buffer, {media = false} = {}) {
    return new Promise((resolve, reject) => {
      this.do({
        type: 'append',
        buffer: buffer,
        media,
        resolve,
        reject,
      });
    });
  }

  /**
   * Drops the queued media segments, which a seek that loads afresh removes; they reject with an AbortError.
   */
  dropQueuedMedia() {
    const isMedia = (/** @type {SourceBufferOp} */ op) => op.type === 'append' && !!op.media;
    const dropped = this.toDo.filter(isMedia);
    if (!dropped.length) return;
    this.toDo = this.toDo.filter((op) => !isMedia(op));
    for (const op of dropped) {
      op.reject(new DOMException('Dropped: the player loads afresh', 'AbortError'));
    }
  }

  /**
   * @param {number} start - Seconds.
   * @param {number} end - Seconds.
   * @return {Promise<void>} Once the removal started: buffered holds the range until its updateend.
   */
  remove(start, end) {
    return new Promise((resolve, reject) => {
      this.do({
        type: 'remove',
        start,
        end,
        resolve,
        reject,
      });
    });
  }

  /**
   * Another type for the media that follows (an MP4's other audio track), queued: taken only while idle.
   * @param {string} mimeType
   * @return {Promise<void>} Resolves once the SourceBuffer took it.
   */
  changeType(mimeType) {
    return new Promise((resolve, reject) => {
      this.do({
        type: 'changeType',
        mimeType,
        resolve,
        reject,
      });
    });
  }

  /** Starts no further operation until release(); the one running goes on. */
  hold() {
    this.held = true;
  }

  release() {
    this.held = false;
    this.sourceBufferDo();
  }

  sourceBufferDo() {
    if (this.updating || this.held || this.disposed) return;
    if (this.toDo.length) {
      const current = this.toDo[0];

      // An operation that throws starts no update, so no updateend follows it.
      try {
        if (current.type === 'append') {
          this.sourceBuffer.appendBuffer(current.buffer);
        } else if (current.type === 'remove') {
          this.sourceBuffer.remove(current.start, current.end);
        } else {
          // Done at once: no update, so no updateend follows. The next operation runs now.
          this.sourceBuffer.changeType(current.mimeType);
          current.resolve();
          this.toDo.splice(0, 1);
          this.sourceBufferDo();
          return;
        }
      } catch (e) {
        console.log(e);
        current.reject(e);
        this.toDo.splice(0, 1);
        this.sourceBufferDo();
        return;
      }
      current.resolve();
      this.updating = true;
      this.removing = current.type === 'remove' ? current : null;
      this.toDo.splice(0, 1);
    }
  }
  /** @param {SourceBufferOp} obj */
  do(obj) {
    this.toDo.push(obj);
    this.sourceBufferDo();
  }

  get buffered() {
    return this.sourceBuffer.buffered;
  }
}

/**
 * A seek decides from buffered whether to load anew: a queued removal of the time makes that stale.
 * @param {Array<?SourceBufferWrapper>} wrappers
 * @param {number} time - Seconds.
 * @return {boolean}
 */
export function removalPending(wrappers, time) {
  return wrappers.some((wrapper) => !!wrapper && wrapper.hasPendingRemove(time));
}
