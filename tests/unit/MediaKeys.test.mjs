import {describe, expect, it, vi} from 'vitest';

import {MediaKeys} from '../../chrome/player/ui/MediaKeys.mjs';

// The keyboard's next- and previous-track keys go to the next and previous episode, while the
// player has one (his report, 2026-10-22: they did nothing). The Media Session stands in for
// Firefox's: what matters is which actions have a handler, and what a handler does.

/** A Media Session that keeps what was set, as Firefox's does. */
function fakeSession() {
  const handlers = new Map();
  return {
    handlers,
    setActionHandler: vi.fn((action, handler) => {
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    }),
  };
}

/** A player whose next and previous episodes the test sets. */
function fakeClient() {
  return {
    next: false,
    previous: false,
    hasNextVideo() {
      return this.next;
    },
    hasPreviousVideo() {
      return this.previous;
    },
    nextVideo: vi.fn(),
    previousVideo: vi.fn(),
  };
}

describe('MediaKeys', () => {
  it('offers no key while the player has no episode to go to', () => {
    const session = fakeSession();
    new MediaKeys(/** @type {*} */ (fakeClient()), /** @type {*} */ (session)).update();
    expect(session.handlers.size).toBe(0);
    // Nothing to take back either: a key another player of the page offered stays untouched.
    expect(session.setActionHandler).not.toHaveBeenCalled();
  });

  it('goes to the next and the previous episode once the player knows them', () => {
    const session = fakeSession();
    const client = fakeClient();
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session));
    client.next = true;
    client.previous = true;
    keys.update();

    session.handlers.get('nexttrack')();
    expect(client.nextVideo).toHaveBeenCalledTimes(1);
    expect(client.previousVideo).not.toHaveBeenCalled();
    session.handlers.get('previoustrack')();
    expect(client.previousVideo).toHaveBeenCalledTimes(1);
  });

  it('takes a key back when its episode goes, so the overlay greys it out', () => {
    const session = fakeSession();
    const client = fakeClient();
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session));
    client.next = true;
    keys.update();
    expect(session.handlers.has('nexttrack')).toBe(true);

    client.next = false;
    keys.update();
    expect(session.handlers.has('nexttrack')).toBe(false);
    expect(session.setActionHandler).toHaveBeenLastCalledWith('nexttrack', null);
  });

  it('sets each key once, however often the buttons are updated', () => {
    const session = fakeSession();
    const client = fakeClient();
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (session));
    client.next = true;
    keys.update();
    keys.update();
    keys.update();
    expect(session.setActionHandler).toHaveBeenCalledTimes(1);
  });

  it('does nothing without a Media Session, and keeps going when Firefox refuses an action', () => {
    const client = fakeClient();
    client.next = true;
    expect(() => new MediaKeys(/** @type {*} */ (client), null).update()).not.toThrow();

    const refusing = {setActionHandler: vi.fn(() => {
      throw new TypeError('not supported');
    })};
    const keys = new MediaKeys(/** @type {*} */ (client), /** @type {*} */ (refusing));
    expect(() => keys.update()).not.toThrow();
    // Asked again next time: the action may be there by then.
    keys.update();
    expect(refusing.setActionHandler).toHaveBeenCalledTimes(2);
  });
});
