/**
 * Runs async tasks strictly one at a time, in the order they were queued.
 *
 * FileSystemSyncAccessHandle throws (NoModificationAllowedError) if a handle
 * on the same file is already open, and unlike IndexedDB transactions that
 * serialization isn't free - this gives every filesystem operation in
 * opfs-worker.mjs a single choke point instead of per-identifier locking.
 */
export class OpQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  /**
   * Queues `task` to run only after every previously queued task has
   * settled (successfully or not).
   * @param {() => Promise<any>} task
   * @return {Promise<any>} resolves/rejects with this task's own outcome -
   *   a failing task does not block tasks queued after it.
   */
  push(task) {
    const run = this.tail.then(() => task(), () => task());
    this.tail = run.then(() => {}, () => {});
    return run;
  }
}
