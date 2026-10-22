// @ts-check
export const EmitterCancel = Symbol('EmitterCancel');

/**
 * A listener of an event. It is called with what emit() was given for that event, which
 * differs from event to event: the emitter does not type its events, so a listener's
 * parameters are typed where it is written. Returning EmitterCancel stops the listeners
 * after it. (A function type with `*` arguments here made every inline listener's
 * parameters `any` without a word.)
 * @typedef {Function} EmitterListener
 */

class EventEmitterContext {
  /**
   * @param {EventEmitter} parent
   */
  constructor(parent) {
    this.parent = parent;
    /** @type {Map<string, EmitterListener[]>} */
    this.events = new Map();
  }

  destroy() {
    this.parent.removeContext(this);
  }

  /**
   * @param {string} event
   * @param {EmitterListener} callback
   * @param {boolean} [prepend] - Called before the listeners already there.
   */
  on(event, callback, prepend = false) {
    if (!this.events.has(event)) {
      this.events.set(event, []);
    }
    if (prepend) {
      /** @type {EmitterListener[]} */ (this.events.get(event)).unshift(callback);
    } else {
      /** @type {EmitterListener[]} */ (this.events.get(event)).push(callback);
    }
    return this;
  }

  /**
   * @param {string} event
   * @param {EmitterListener} callback
   */
  off(event, callback) {
    if (!this.events.has(event)) {
      return this;
    }
    const callbacks = /** @type {EmitterListener[]} */ (this.events.get(event));
    const index = callbacks.indexOf(callback);
    if (index !== -1) {
      callbacks.splice(index, 1);
    }
    return this;
  }

  /**
   * @param {string} event
   * @param {EmitterListener} callback
   */
  once(event, callback) {
    /** @param {...*} args - What emit() was given, passed on. */
    const onceCallback = (...args) => {
      this.off(event, onceCallback);
      callback(...args);
    };
    this.on(event, onceCallback);
    return this;
  }

  /**
   * @param {string} event
   */
  clear(event) {
    this.events.delete(event);
    return this;
  }

  /**
   * @param {string} event
   * @param {...*} args - What the event's listeners are called with.
   */
  emit(event, ...args) {
    if (!this.events.has(event)) {
      return this;
    }
    // A copy: a listener that removes itself (once()) took its place away while this was
    // on it, and the next one, moved into that place, was skipped.
    if (![.../** @type {EmitterListener[]} */ (this.events.get(event))].every((callback) => {
      try {
        const result = callback(...args);
        if (result === EmitterCancel) {
          return false;
        }
      } catch (e) {
        console.log(`Error in event ${event}`);
        console.error(e);
      }

      return true;
    })) {
      return EmitterCancel;
    }
    return this;
  }
}


export class EventEmitter {
  constructor() {
    this.mainContext = new EventEmitterContext(this);
    this.contexts = [this.mainContext];
    this.debug = false;
  }

  createContext() {
    const context = new EventEmitterContext(this);
    this.contexts.push(context);
    return context;
  }

  logAllEvents() {
    this.debug = true;
  }

  /**
   * @param {EventEmitterContext} context
   */
  removeContext(context) {
    const index = this.contexts.indexOf(context);
    if (index === 0) {
      throw new Error('Cannot remove main context');
    }
    if (index !== -1) {
      this.contexts.splice(index, 1);
    }

    return this;
  }

  /**
   * @param {string} event
   * @param {EmitterListener} callback
   */
  on(event, callback) {
    this.mainContext.on(event, callback);
    return this;
  }

  /**
   * @param {string} event
   * @param {EmitterListener} callback
   */
  off(event, callback) {
    this.mainContext.off(event, callback);
    return this;
  }

  /**
   * @param {string} event
   * @param {EmitterListener} callback
   */
  once(event, callback) {
    this.mainContext.once(event, callback);
    return this;
  }

  /**
   * @param {string} event
   * @param {...*} args - What the event's listeners are called with.
   */
  emit(event, ...args) {
    if (this.debug) {
      console.log(event, ...args);
    }
    // A copy, as in the context's emit(): a context destroyed by its own handler skipped
    // the one after it.
    if (![...this.contexts].every((context) => {
      const val = context.emit(event, ...args);
      if (val === EmitterCancel) {
        return false;
      }
      return true;
    })) {
      return EmitterCancel;
    }
    return this;
  }
}

export class EmitterRelay {
  /**
   * @param {EventEmitter|EventEmitter[]} [outs] - Where each event goes, in order.
   */
  constructor(outs) {
    /** @type {EventEmitter[]} */
    this.outs = [];

    if (Array.isArray(outs)) {
      outs.forEach((out) => this.appendOutput(out));
    } else if (outs) {
      this.appendOutput(outs);
    }
  }

  /**
   * @param {EventEmitter} out
   */
  appendOutput(out) {
    this.outs.push(out);
    return this;
  }

  /**
   * @param {EventEmitter} out
   */
  prependOutput(out) {
    this.outs.unshift(out);
    return this;
  }

  /**
   * @param {EventEmitter} out
   */
  removeOutput(out) {
    const index = this.outs.indexOf(out);
    if (index !== -1) {
      this.outs.splice(index, 1);
    }
    return this;
  }

  /**
   * @param {string} event
   * @param {...*} args - What the event's listeners are called with.
   */
  emit(event, ...args) {
    for (let i = 0; i < this.outs.length; i++) {
      const val = this.outs[i].emit(event, ...args);
      if (val === EmitterCancel) {
        break;
      }
    }
  }
}

