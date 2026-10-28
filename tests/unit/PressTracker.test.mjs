import {describe, expect, it, vi} from 'vitest';

import {PressTracker} from '../../chrome/player/ui/PressTracker.mjs';

// How a press ends (PressTracker), on a stand-in document and window: each listener is kept
// with its phase, and an event is handed to the listeners of the target it is fired at.
// The hold on the video ended only at the next click, so a window switched while the video
// was held left it at twice the speed (measured in Firefox, 2026-10-28); every drag ended on
// a mouseup of its own, with patches for the ones it never heard.

class Target {
  constructor() {
    /** @type {Array<{type: string, fn: Function, capture: boolean}>} */
    this.listeners = [];
  }
  addEventListener(type, fn, options) {
    this.listeners.push({type, fn, capture: options === true || !!options?.capture});
  }
  removeEventListener(type, fn, options) {
    const capture = options === true || !!options?.capture;
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (i !== -1) this.listeners.splice(i, 1);
  }
  fire(type, props = {}) {
    const event = {type, target: this, stopped: false, prevented: false,
      stopImmediatePropagation() {
        this.stopped = true;
      },
      preventDefault() {
        this.prevented = true;
      },
      ...props};
    for (const {fn} of this.listeners.filter((l) => l.type === type)) {
      fn(event);
      if (event.stopped) break;
    }
    return event;
  }
}

/** A document, its window, and a press begun on one of its elements. */
function setup({type = 'mousedown', button = 0} = {}) {
  const doc = new Target();
  doc.hidden = false;
  doc.defaultView = new Target();
  const element = {ownerDocument: doc};
  const move = vi.fn();
  const end = vi.fn();
  const press = PressTracker.follow({type, button, target: element}, {move, end});
  return {doc, win: doc.defaultView, move, end, press};
}

describe('PressTracker: a press of the mouse', () => {
  it('follows the moves and ends at its release, anywhere in the document, once', () => {
    const {doc, move, end} = setup();
    doc.fire('mousemove', {buttons: 1, clientX: 5});
    expect(move).toHaveBeenCalledTimes(1);
    const release = doc.fire('mouseup', {button: 0, buttons: 0});
    expect(end).toHaveBeenCalledExactlyOnceWith(release);
    // Every listener it added is gone: nothing more is heard.
    expect(doc.listeners).toEqual([]);
    doc.fire('mousemove', {buttons: 1});
    doc.fire('mouseup', {button: 0});
    expect(move).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('listens in the capture phase, before any element can stop the release', () => {
    const {doc} = setup();
    expect(doc.listeners.every((l) => l.capture)).toBe(true);
  });

  it('is not ended by another button\'s release', () => {
    const {doc, end} = setup();
    doc.fire('mouseup', {button: 2, buttons: 1});
    expect(end).not.toHaveBeenCalled();
  });

  for (const [what, act] of [
    ['the window loses the focus (another window or app)', ({win}) => win.fire('blur')],
    ['the tab is hidden', ({doc}) => {
      doc.hidden = true;
      doc.fire('visibilitychange');
    }],
    ['a context menu takes the mouse', ({doc}) => doc.fire('contextmenu')],
    ['the browser\'s own drag takes the mouse', ({doc}) => doc.fire('dragstart')],
    ['a move comes with the button up (let go where no mouseup was heard)', ({doc}) => doc.fire('mousemove', {buttons: 0})],
    ['the player ends it (cancel)', ({press}) => press.cancel()],
  ]) {
    it(`ends without a release when ${what}`, () => {
      const parts = setup();
      act(parts);
      expect(parts.end).toHaveBeenCalledExactlyOnceWith(null);
      expect(parts.doc.listeners).toEqual([]);
      expect(parts.win.listeners).toEqual([]);
      expect(parts.move).not.toHaveBeenCalled();
    });
  }

  it('is not ended by an element\'s blur, which passes the window in the capture phase', () => {
    const {win, end} = setup();
    win.fire('blur', {target: {}});
    expect(end).not.toHaveBeenCalled();
  });

  it('is not ended when the tab comes back into view', () => {
    const {doc, end} = setup();
    doc.fire('visibilitychange');
    expect(end).not.toHaveBeenCalled();
  });

  it('goes by its own button: a right-button press, a move with only the left held ends it', () => {
    const {doc, move, end} = setup({button: 2});
    doc.fire('mousemove', {buttons: 2});
    expect(move).toHaveBeenCalledTimes(1);
    doc.fire('mousemove', {buttons: 1});
    expect(end).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe('PressTracker: a touch', () => {
  it('follows it and ends at touchend', () => {
    const {doc, move, end} = setup({type: 'touchstart'});
    doc.fire('touchmove');
    expect(move).toHaveBeenCalledTimes(1);
    const release = doc.fire('touchend');
    expect(end).toHaveBeenCalledExactlyOnceWith(release);
  });

  it('ends without a release when it is cancelled', () => {
    const {doc, end} = setup({type: 'touchstart'});
    doc.fire('touchcancel');
    expect(end).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe('PressTracker.swallowClick', () => {
  it('keeps the click a hold\'s release brings from everything after it', () => {
    const doc = new Target();
    const clicked = vi.fn();
    PressTracker.swallowClick({target: {ownerDocument: doc}});
    doc.addEventListener('click', clicked);
    const click = doc.fire('click', {detail: 1});
    expect(click.stopped).toBe(true);
    expect(click.prevented).toBe(true);
    expect(clicked).not.toHaveBeenCalled();
    // Only that one.
    doc.fire('click', {detail: 1});
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('lets a click of the keyboard or of a script through, and waits for the mouse\'s', () => {
    // Enter on a focused button, or element.click(): detail 0. Let go outside the document
    // after a hold, the catcher waited, and the next of those was eaten.
    const doc = new Target();
    const clicked = vi.fn();
    PressTracker.swallowClick({target: {ownerDocument: doc}});
    doc.addEventListener('click', clicked);
    expect(doc.fire('click', {detail: 0}).stopped).toBe(false);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(doc.fire('click', {detail: 1}).stopped).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('is taken out at the next press when no click came', () => {
    const doc = new Target();
    const clicked = vi.fn();
    PressTracker.swallowClick({target: {ownerDocument: doc}});
    doc.addEventListener('click', clicked);
    doc.fire('mousedown');
    doc.fire('click', {detail: 1});
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(doc.listeners.map((l) => l.type)).toEqual(['click']);
  });
});
