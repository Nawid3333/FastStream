// A small stand-in DOM for the content scripts (content.js, overlay-guard.js), which are
// classic scripts written for a page: enough of a document, its elements and their inline
// styles to run their message handlers in Node (vm), with layout given by each test. It
// is no browser: what it proves is the scripts' own bookkeeping, not how Firefox lays a
// page out. The e2e suites (tests/e2e/classic-specs) cover that.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '../..');

const CAMEL_PROPERTIES = ['width', 'height', 'overflow', 'margin', 'contain', 'display', 'position',
  'zIndex', 'border', 'borderRadius', 'boxShadow', 'transition', 'visibility', 'top', 'left',
  'right', 'bottom', 'opacity', 'padding'];

/** An element's inline style (CSSStyleDeclaration). */
export class FakeStyle {
  constructor(owner) {
    this.owner = owner;
    /** @type {Map<string, {value: string, priority: string}>} */
    this.props = new Map();
  }

  setProperty(name, value, priority = '') {
    this.owner.hasStyle = true;
    if (value === null || value === undefined || value === '') {
      this.props.delete(name);
      return;
    }
    this.props.set(name, {value: String(value), priority: priority || ''});
  }

  getPropertyValue(name) {
    return this.props.has(name) ? this.props.get(name).value : '';
  }

  getPropertyPriority(name) {
    return this.props.has(name) ? this.props.get(name).priority : '';
  }

  removeProperty(name) {
    const value = this.getPropertyValue(name);
    this.props.delete(name);
    return value;
  }

  get cssText() {
    return Array.from(this.props, ([name, {value, priority}]) =>
      `${name}: ${value}${priority ? ' !important' : ''};`).join(' ');
  }

  set cssText(text) {
    this.props.clear();
    for (const part of String(text).split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const name = part.slice(0, colon).trim();
      let value = part.slice(colon + 1).trim();
      let priority = '';
      if (value.endsWith('!important')) {
        priority = 'important';
        value = value.slice(0, -'!important'.length).trim();
      }
      if (name && value) this.props.set(name, {value, priority});
    }
  }
}

for (const camel of CAMEL_PROPERTIES) {
  const name = camel.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
  Object.defineProperty(FakeStyle.prototype, camel, {
    get() {
      return this.getPropertyValue(name);
    },
    set(value) {
      this.setProperty(name, value);
    },
  });
}

/**
 * Whether an element matches a selector: a tag or '*', with an optional [attr^="value"],
 * or a comma-separated list of those.
 * @param {FakeElement} el - The element.
 * @param {string} selector - The selector.
 * @return {boolean}
 */
function matches(el, selector) {
  return selector.split(',').some((one) => {
    const simple = /^\s*([a-zA-Z*]+)?(?:\[([a-z-]+)\^="([^"]*)"\])?\s*$/.exec(one);
    if (!simple) throw new Error('contentDom: unsupported selector ' + one);
    const [, tag, attr, prefix] = simple;
    if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
    if (attr && !String(el.getAttribute(attr) || '').startsWith(prefix)) return false;
    return true;
  });
}

/** An element. Its box is `rect` ({x, y, width, height}, or a function giving one). */
export class FakeElement {
  constructor(doc, tagName) {
    this.ownerDocument = doc;
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.parentNode = null;
    this.children = [];
    this.attrs = new Map();
    this.hasStyle = false;
    this.style = new FakeStyle(this);
    this.dataset = {};
    this.classList = [];
    this.listeners = [];
    this.shadowRoot = null;
    this.id = '';
    this.rect = {x: 0, y: 0, width: 0, height: 0};
    // Paint order: later in the document is painted above, unless set.
    this.z = doc.nextZ++;
    if (this.tagName === 'IFRAME') {
      this.contentWindow = {postMessage() {}};
    }
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument;
  }

  get src() {
    return this.getAttribute('src') || '';
  }

  set src(value) {
    this.setAttribute('src', value);
  }

  getAttribute(name) {
    if (name === 'style') return this.hasStyle ? this.style.cssText : null;
    if (name === 'id') return this.id || null;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    if (name === 'style') {
      this.hasStyle = true;
      this.style.cssText = value;
    } else if (name === 'id') {
      this.id = String(value);
    } else {
      this.attrs.set(name, String(value));
    }
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name) {
    if (name === 'style') {
      this.hasStyle = false;
      this.style.props.clear();
    } else {
      this.attrs.delete(name);
    }
  }

  getBoundingClientRect() {
    const r = typeof this.rect === 'function' ? this.rect() : this.rect;
    return {x: r.x, y: r.y, left: r.x, top: r.y, width: r.width, height: r.height,
      right: r.x + r.width, bottom: r.y + r.height};
  }

  get clientWidth() {
    return this.getBoundingClientRect().width;
  }

  get clientHeight() {
    return this.getBoundingClientRect().height;
  }

  /** @return {Array<FakeElement>} Every element below this one, in document order. */
  descendants() {
    const found = [];
    const walk = (el) => {
      for (const child of el.children) {
        found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelectorAll(selector) {
    return this.descendants().filter((el) => matches(el, selector));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  matches(selector) {
    return matches(this, selector);
  }

  contains(other) {
    for (let node = other; node; node = node.parentNode) {
      if (node === this) return true;
    }
    return false;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const at = ref ? this.children.indexOf(ref) : this.children.length;
    if (at === -1) throw new Error('contentDom: insertBefore a node that is not a child');
    this.children.splice(at, 0, node);
    node.parentNode = this;
    this.ownerDocument.mutated();
    return node;
  }

  removeChild(node) {
    const at = this.children.indexOf(node);
    if (at === -1) throw new Error('contentDom: removeChild of a node that is not a child');
    this.children.splice(at, 1);
    node.parentNode = null;
    this.ownerDocument.mutated();
    return node;
  }

  replaceChild(node, old) {
    this.insertBefore(node, old);
    return this.removeChild(old);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  replaceWith(node) {
    if (this.parentNode) this.parentNode.replaceChild(node, this);
  }

  addEventListener(type, listener) {
    this.listeners.push({type, listener});
  }

  removeEventListener(type, listener) {
    this.listeners = this.listeners.filter((l) => l.type !== type || l.listener !== listener);
  }

  pause() {
    this.paused = true;
  }
}

/** A document: <html> with <head> and <body>. */
export class FakeDocument {
  constructor() {
    this.nodeType = 9;
    this.nextZ = 0;
    this.listeners = [];
    this.observers = new Set();
    this.parentNode = null;
    this.fullscreenEnabled = true;
    this.fullscreenElement = null;
    this.baseURI = 'https://site.example/page';
    this.documentElement = this.createElement('html');
    this.documentElement.parentNode = this;
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName) {
    return new FakeElement(this, tagName);
  }

  querySelectorAll(selector) {
    return [this.documentElement, ...this.documentElement.descendants()].filter((el) => matches(el, selector));
  }

  /**
   * The elements whose box holds a point, topmost first (by `z`); an element with
   * pointer-events: none is left out, as Firefox's hit test leaves it out.
   * @param {number} x - The point.
   * @param {number} y - The point.
   * @return {Array<FakeElement>}
   */
  elementsFromPoint(x, y) {
    return this.querySelectorAll('*').filter((el) => {
      if (el.style.getPropertyValue('pointer-events') === 'none' || el.pointerEventsNone) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
    }).sort((a, b) => b.z - a.z);
  }

  addEventListener(type, listener) {
    this.listeners.push({type, listener});
  }

  removeEventListener() {}

  /**
   * Runs the MutationObservers watching the document once the current task is done, as
   * Firefox does (with no records: the scripts' own lists are what is tested).
   */
  mutated() {
    if (this.mutationQueued) return;
    this.mutationQueued = true;
    queueMicrotask(() => {
      this.mutationQueued = false;
      for (const observer of [...this.observers]) observer.callback([], observer);
    });
  }
}

/**
 * A page with content.js (and overlay-guard.js, which it uses) loaded in it.
 * @param {Object} [options]
 * @param {string} [options.hostname] - The page's host.
 * @param {Array<Object>} [options.entries] - Its Resource Timing entries.
 * @param {Object<string, string>} [options.responses] - What its requests get, by URL.
 * @return {Object} The page: its document, what content.js sent, and how to talk to it.
 */
export function loadContentScript({hostname = 'site.example', entries = [], responses = {}} = {}) {
  const document = new FakeDocument();
  const sent = [];
  let onMessage = null;
  const windowListeners = [];
  const timers = [];
  let now = 0;

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {
      document.observers.add(this);
    }
    disconnect() {
      document.observers.delete(this);
    }
  }

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  }

  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe(el) {
      // Everything with a box is on screen.
      const r = el.getBoundingClientRect();
      Promise.resolve().then(() => this.callback([{intersectionRatio: r.width > 0 && r.height > 0 ? 1 : 0}], this));
    }
    disconnect() {}
  }

  const context = {
    document,
    location: {hostname, href: `https://${hostname}/page`, origin: `https://${hostname}`, pathname: '/page', search: ''},
    navigator: {userActivation: {isActive: false}},
    performance: {
      timeOrigin: 1000,
      getEntriesByType: (type) => (type === 'resource' ? entries.slice(0, 250) : []),
    },
    screen: {width: 1920, height: 1080},
    innerWidth: 1280,
    innerHeight: 720,
    crypto: webcrypto,
    URL,
    URLSearchParams,
    Node: {ELEMENT_NODE: 1},
    ShadowRoot: class ShadowRoot {},
    MutationObserver: FakeMutationObserver,
    ResizeObserver: FakeResizeObserver,
    IntersectionObserver: FakeIntersectionObserver,
    // Answers with `responses` (URL -> text; 404 for any other), a moment after send(). A
    // URL with a bad host makes open() throw, as Firefox's does.
    XMLHttpRequest: class {
      open(method, url) {
        if (url.startsWith('http://[')) throw new SyntaxError('An invalid or illegal string was specified');
        this.url = url;
      }
      setRequestHeader() {}
      abort() {}
      send() {
        Promise.resolve().then(() => {
          this.readyState = 4;
          this.status = this.url in responses ? 200 : 404;
          this.responseText = responses[this.url] || '';
          this.onreadystatechange();
        });
      }
    },
    console: {log() {}, error() {}, warn() {}, debug() {}, info() {}},
    setTimeout: (fn, ms = 0) => {
      timers.push({at: now + ms, fn});
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    addEventListener: (type, listener) => windowListeners.push({type, listener}),
    removeEventListener: () => {},
    parent: {postMessage() {}},
    getComputedStyle: (el) => ({
      display: el.style.getPropertyValue('display') || el.computed?.display || 'block',
      position: el.style.getPropertyValue('position') || el.computed?.position || 'static',
      overflow: el.computed?.overflow || 'visible',
      zIndex: 'auto',
      border: '',
      borderRadius: '',
      boxShadow: '',
    }),
    chrome: {
      runtime: {
        getURL: (file) => 'moz-extension://test/' + file,
        lastError: undefined,
        onMessage: {addListener: (listener) => {
          onMessage = listener;
        }},
        sendMessage: (message, callback) => {
          sent.push(message);
          if (callback) {
            callback(undefined);
            return undefined;
          }
          return Promise.resolve(undefined);
        },
      },
    },
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['chrome/overlay-guard.js', 'chrome/content.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, {filename: file});
  }

  return {
    document,
    window: context,
    sent,
    timers,
    /**
     * Sends content.js a message, as the background does.
     * @param {Object} request - The message.
     * @return {Promise<*>} Its answer; undefined when it gives none.
     */
    send(request) {
      return new Promise((resolve) => {
        // Copied when sent, as Firefox copies it: what the script changes after is not in it.
        const sendResponse = (response) => resolve(response === undefined ? undefined : structuredClone(response));
        const async = onMessage(request, {id: 'test'}, sendResponse);
        if (async !== true) resolve(undefined);
      });
    },
    /**
     * Posts a message to the page's window, as a frame in it does.
     * @param {*} data - The message.
     * @param {Object} source - The window it comes from.
     */
    postMessage(data, source) {
      for (const {type, listener} of windowListeners) {
        if (type === 'message') listener({data, source});
      }
    },
    /**
     * Runs the timers due within this many milliseconds, in order.
     * @param {number} ms - How far to move the clock.
     */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.done && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.done = true;
        now = due.at;
        due.fn();
      }
      now = until;
    },
  };
}
