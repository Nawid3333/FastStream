import {describe, expect, it, vi} from 'vitest';
import {EmitterCancel, EventEmitter} from '../../chrome/player/modules/eventemitter.mjs';

// emit() walked the listener list and the context list as they were changed under it: a
// listener that removed itself (once(), or a handler that destroys its own context) took
// its place in the list away while the walk was on it, and the next one moved into that
// place and was skipped for that event.

describe('EventEmitter, a listener that removes itself while the event is sent', () => {
  it('still sends the event to the listener after a once()', () => {
    const emitter = new EventEmitter();
    const heard = [];
    emitter.once('ready', () => heard.push('first'));
    emitter.once('ready', () => heard.push('second'));
    emitter.on('ready', () => heard.push('third'));

    emitter.emit('ready');

    expect(heard).toEqual(['first', 'second', 'third']);
    // The two once() listeners are gone afterwards.
    heard.length = 0;
    emitter.emit('ready');
    expect(heard).toEqual(['third']);
  });

  it('still sends it to the next context when a context destroys itself on it', () => {
    // The analyzers' DESTROYED handlers destroy their own context.
    const emitter = new EventEmitter();
    const first = emitter.createContext();
    const second = emitter.createContext();
    const heard = [];
    first.on('destroyed', () => {
      heard.push('first');
      first.destroy();
    });
    second.on('destroyed', () => heard.push('second'));

    emitter.emit('destroyed');

    expect(heard).toEqual(['first', 'second']);
    expect(emitter.contexts).not.toContain(first);
  });

  it('does not send the event to a listener added while it is sent', () => {
    const emitter = new EventEmitter();
    const late = vi.fn();
    emitter.on('tick', () => emitter.on('tick', late));
    emitter.emit('tick');
    expect(late).not.toHaveBeenCalled();
  });

  it('still lets a listener stop the event for the ones after it', () => {
    const emitter = new EventEmitter();
    const context = emitter.createContext();
    const after = vi.fn();
    emitter.on('durationchange', () => EmitterCancel);
    context.on('durationchange', after);
    expect(emitter.emit('durationchange')).toBe(EmitterCancel);
    expect(after).not.toHaveBeenCalled();
  });
});
