// @ts-check
import {EventEmitter} from '../../modules/eventemitter.mjs';

/**
 * A queued operation on the SourceBuffer, with its promise's resolve and reject: an append of
 * bytes (media: a media segment, not an initialization segment), a removal of a time
 * range, in seconds, or a change of the type its next initialization segment has.
 * @typedef {{resolve: (value: void) => void, reject: (reason?: unknown) => void} & ({type: 'append', buffer: BufferSource, media?: boolean} |
 *   {type: 'remove', start: number, end: number} | {type: 'changeType', mimeType: string})} SourceBufferOp
 */

export class SourceBufferWrapper extends EventEmitter {
  /**
   * @param {MediaSource} mediaSource
   * @param {string} codec - The MIME type with its codecs, as isTypeSupported takes it.
   */
  constructor(mediaSource, codec) {
    super();
    if (!MediaSource.isTypeSupported(codec)) {
      throw new Error('Codec not supported: ' + codec);
    }
    this.sourceBuffer = mediaSource.addSourceBuffer(codec);
    this.updating = false;
    // Held: starts no further operation until released (DurationSync, which needs every
    // SourceBuffer idle to set the MediaSource's duration).
    this.held = false;
    // The removal running, as its operation ({start, end}), or null (hasPendingRemove).
    /** @type {?(SourceBufferOp & {type: 'remove'})} */
    this.removing = null;
    /** @type {Array<SourceBufferOp>} */
    this.toDo = [];
    this.sourceBuffer.addEventListener('updateend', () => {
      this.updating = false;
      this.removing = null;
      this.emit('updateend');
      this.sourceBufferDo();
    });
  }

  /**
   * Whether a removal that takes `time` away is queued here or running: until it has run,
   * `buffered` still holds it (removalPending). Only one over `time`: the player trims its
   * back buffer while it plays, and a seek within what stays must not count it.
   * @param {number} time - In seconds.
   * @return {boolean}
   */
  hasPendingRemove(time) {
    /** @param {?{start: number, end: number}} op */
    const covers = (op) => !!op && time >= op.start && time <= op.end;
    return covers(this.removing) || this.toDo.some((op) => op.type === 'remove' && covers(op));
  }
  abort() {
    // SourceBuffer.abort() also throws while a removal runs (the back buffer goes while the
    // video plays): the player being destroyed then stopped half way, its media source URL
    // never revoked and DESTROYED never emitted. A removal has nothing to abort.
    try {
      this.sourceBuffer.abort();
    } catch (e) {
      console.warn('SourceBuffer.abort refused', e);
    }
  }

  /**
   * @param {BufferSource} buffer
   * @param {{media?: boolean}} [options] - media: a media segment, which dropQueuedMedia may
   *   drop; an initialization segment is never dropped.
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
   * Drops the media segments still queued; the operation running, initialization segments and
   * removals stay. A seek that loads afresh removes what they would add, and Firefox parsed
   * every one of them before that removal ran: hundreds of one-frame segments behind a fast
   * download (Codex's review, 2026-11-07). Their promises reject with an AbortError.
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
   * @param {number} start - In seconds.
   * @param {number} end - In seconds.
   * @return {Promise<void>} Resolves once the range is gone.
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
   * Makes the media that follows of another type (codec): an MP4's other audio track, say.
   * In the queue, as the SourceBuffer takes it only while no update runs.
   * @param {string} mimeType - As isTypeSupported takes it.
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

  /** Runs the operations queued again. */
  release() {
    this.held = false;
    this.sourceBufferDo();
  }

  sourceBufferDo() {
    if (this.updating || this.held) return;
    if (this.toDo.length) {
      const current = this.toDo[0];

      // An operation that throws starts no update, so no updateend follows it. Marking the
      // wrapper updating then left every later operation queued for good, and an append that
      // threw stayed at the head and was run again, and threw again, by every later call.
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
 * Whether any of a player's SourceBuffers still has a removal of `time` to run. A seek
 * decides from `buffered` whether to start loading anew, and while such a removal is
 * queued that answer is stale: a seek to 0 just after a jump to the end found the start
 * still buffered (the removal of everything, queued by the jump's reload, waited behind
 * the end's appends), did not reload, and the removal then took the start away with
 * nothing loading it again - the player sat at 0 for good (#265, about once a week on
 * GitHub's Windows runner).
 * @param {Array<?SourceBufferWrapper>} wrappers - The player's video and audio wrappers.
 * @param {number} time - The seek's target, in seconds.
 * @return {boolean}
 */
export function removalPending(wrappers, time) {
  return wrappers.some((wrapper) => !!wrapper && wrapper.hasPendingRemove(time));
}
