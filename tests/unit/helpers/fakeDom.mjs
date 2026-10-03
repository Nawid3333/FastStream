// A small stand-in DOM built from a page's HTML, for unit tests of page scripts that run in
// Node (vitest's environment is 'node', and no DOM library is installed). It knows the
// little those scripts use: ids, classes, data-* and other attributes, the element tree,
// simple selectors (tag, .class, #id, [attr], tag.class, and lists of those), listeners
// called directly by the test (no bubbling), and focus. It is no browser: layout, CSS and
// events the script does not listen for are not there.

import fs from 'node:fs';

// Elements this HTML writes without a closing tag (an <option> inside a <datalist>).
const VOID = new Set(['input', 'br', 'meta', 'link', 'img', 'hr', 'source', 'option']);

const camel = (name) => name.replace(/-([a-z])/g, (m, c) => c.toUpperCase());

/** One element of the stand-in DOM. */
export class FakeElement {
  /**
   * @param {FakeDocument} doc - The document it belongs to.
   * @param {string} tag - Its tag name.
   * @param {Object<string, string>} [attrs] - Its attributes.
   */
  constructor(doc, tag, attrs = {}) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    // Layout, as the test sets it: getBoundingClientRect() answers with `rect`.
    this.rect = {left: 0, top: 0, width: 0, height: 0};
    this.offsetLeft = 0;
    this.offsetTop = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      values: () => [...classes],
    };
    for (const [name, value] of Object.entries(attrs)) {
      this.setAttribute(name, value);
    }
  }

  get className() {
    return this.classList.values().join(' ');
  }

  set className(value) {
    for (const name of this.classList.values()) this.classList.remove(name);
    this.classList.add(...String(value).split(/\s+/).filter(Boolean));
  }

  get id() {
    return this.attributes.id || '';
  }

  set id(value) {
    this.attributes.id = String(value);
  }

  setAttribute(name, value) {
    value = String(value);
    this.attributes[name] = value;
    if (name === 'class') {
      this.className = value;
    } else if (name.startsWith('data-')) {
      this.dataset[camel(name.slice(5))] = value;
    } else if (name === 'style') {
      for (const rule of value.split(';')) {
        const [prop, ...rest] = rule.split(':');
        if (prop.trim()) this.style[camel(prop.trim())] = rest.join(':').trim();
      }
    } else if (name === 'value') {
      this.value = value;
    } else if (name === 'hidden') {
      this.hidden = true;
    }
  }

  getAttribute(name) {
    if (name === 'class') return this.className;
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }

  removeAttribute(name) {
    delete this.attributes[name];
    if (name === 'hidden') this.hidden = false;
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentNode = null;
    }
  }

  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
  }

  /**
   * Calls this element's listeners for an event, the way the browser would on its target.
   * @param {string} type - The event type.
   * @param {Object} [props] - The event's properties (key, code, button, ...).
   * @return {Object} The event, with what the listeners did to it.
   */
  fire(type, props = {}) {
    const event = {
      type, target: this, currentTarget: this, defaultPrevented: false, propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...props,
    };
    for (const fn of (this.listeners[type] || []).slice()) fn.call(this, event);
    return event;
  }

  dispatchEvent(event) {
    for (const fn of (this.listeners[event.type] || []).slice()) fn.call(this, event);
    return true;
  }

  getBoundingClientRect() {
    const {left, top, width, height} = this.rect;
    return {left, top, width, height, right: left + width, bottom: top + height, x: left, y: top};
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  blur() {
    if (this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = this.ownerDocument.body;
      this.fire('blur');
    }
  }

  click() {
    this.fire('click');
  }

  /**
   * @param {string} selector - A selector of the kinds listed at the top.
   * @return {boolean}
   */
  matches(selector) {
    return selector.split(',').some((part) => {
      const tokens = part.trim().match(/^[a-z0-9]+|\.[\w-]+|#[\w-]+|\[[\w-]+\]/gi) || [];
      if (tokens.join('') !== part.trim()) {
        throw new Error(`fakeDom: unsupported selector ${part}`);
      }
      return tokens.every((token) => {
        if (token[0] === '.') return this.classList.contains(token.slice(1));
        if (token[0] === '#') return this.id === token.slice(1);
        if (token[0] === '[') return this.hasAttribute(token.slice(1, -1));
        return this.tagName === token.toUpperCase();
      });
    });
  }

  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  get nextElementSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  get previousElementSibling() {
    const siblings = this.parentNode?.children || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
}

/** The document of a stand-in DOM. */
export class FakeDocument {
  /**
   * @param {string} html - The page's HTML.
   */
  constructor(html) {
    this.documentElement = new FakeElement(this, 'html');
    const stack = [this.documentElement];
    for (const match of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g)) {
      const [, closing, rawTag, rawAttrs] = match;
      const tag = rawTag.toLowerCase();
      if (closing) {
        const index = stack.map((el) => el.tagName).lastIndexOf(tag.toUpperCase());
        if (index > 0) stack.length = index;
        continue;
      }
      if (tag === 'html') {
        this.setAttributes(this.documentElement, rawAttrs);
        continue;
      }
      const el = new FakeElement(this, tag);
      this.setAttributes(el, rawAttrs);
      stack[stack.length - 1].appendChild(el);
      if (!VOID.has(tag) && !/\/\s*$/.test(rawAttrs)) stack.push(el);
    }
    this.body = this.documentElement.querySelector('body') || this.documentElement.appendChild(new FakeElement(this, 'body'));
    this.head = this.documentElement.querySelector('head');
    this.activeElement = this.body;
    this.listeners = {};
  }

  /**
   * @param {FakeElement} el
   * @param {string} raw - The text of a tag after its name.
   */
  setAttributes(el, raw) {
    for (const [, name, dq, sq, bare] of raw.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
      el.setAttribute(name, dq ?? sq ?? bare ?? '');
    }
  }

  getElementById(id) {
    return this.documentElement.querySelector('#' + id);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    if (list.includes(fn)) list.splice(list.indexOf(fn), 1);
  }

  /**
   * Calls the document's own listeners for an event (one that reached the document).
   * @param {string} type - The event type.
   * @param {Object} [props] - The event's properties.
   */
  fire(type, props = {}) {
    const event = {type, target: this, preventDefault() {}, stopPropagation() {}, ...props};
    for (const fn of (this.listeners[type] || []).slice()) fn.call(this, event);
  }
}

/**
 * A stand-in document for one of the extension's pages.
 * @param {string} path - The page, from the repository root.
 * @return {FakeDocument}
 */
export function loadPage(path) {
  return new FakeDocument(fs.readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
}
