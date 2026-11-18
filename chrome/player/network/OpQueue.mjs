// @ts-check
export class OpQueue {
  constructor() {
    this.tail = Promise.resolve();
  }

  /**
   * @param {() => Promise<any>} task
   * @return {Promise<any>}
   */
  push(task) {
    const run = this.tail.then(() => task(), () => task());
    this.tail = run.then(() => {}, () => {});
    return run;
  }
}
