import {EventEmitter} from '../../modules/eventemitter.mjs';

export class SourceBufferWrapper extends EventEmitter {
  constructor(mediaSource, codec) {
    super();
    if (!MediaSource.isTypeSupported(codec)) {
      throw new Error('Codec not supported: ' + codec);
    }
    this.sourceBuffer = mediaSource.addSourceBuffer(codec);
    this.updating = false;
    // The removal running, as its operation ({start, end}), or null (hasPendingRemove).
    this.removing = null;
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
    const covers = (op) => !!op && time >= op.start && time <= op.end;
    return covers(this.removing) || this.toDo.some((op) => op.type === 'remove' && covers(op));
  }
  abort() {
    this.sourceBuffer.abort();
  }

  appendBuffer(buffer) {
    return new Promise((resolve, reject) => {
      this.do({
        type: 'append',
        buffer: buffer,
        resolve,
        reject,
      });
    });
  }

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

  sourceBufferDo() {
    if (this.updating) return;
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
  do(obj) {
    this.toDo.push(obj);
    if (!this.updating) this.sourceBufferDo();
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
