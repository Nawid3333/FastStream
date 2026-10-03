// A small stand-in for the DOM the vendored vtt.js parser builds cue trees with, so its
// cue parsing can run in vitest's node environment. createElement checks the name the
// way the DOM does (an invalid one throws InvalidCharacterError), which is what makes a
// bad tag name show up here as it does in Firefox.

/** A name document.createElement accepts: an ASCII letter, then no space, '/', '>' or NUL. */
const VALID_ELEMENT_NAME = /^[A-Za-z][^\t\n\f\r />\0]*$/;

class FakeNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, before) {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    if (index === -1) {
      throw new DOMException('The node before which the new node is to be inserted is not a child of this node.', 'NotFoundError');
    }
    this.childNodes.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.childNodes.indexOf(node);
    if (index === -1) {
      throw new DOMException('The node to be removed is not a child of this node.', 'NotFoundError');
    }
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }
}

class FakeElement extends FakeNode {
  constructor(name) {
    super(1);
    this.localName = name.toLowerCase();
    this.nodeName = name.toUpperCase();
    this.style = {};
    this.className = '';
    this.ownText = null;
  }

  get textContent() {
    return this.ownText !== null ? this.ownText : super.textContent;
  }

  set textContent(text) {
    this.childNodes = [];
    this.ownText = text;
  }

  // Only the parser's <textarea> uses this, to decode entities in cue text.
  set innerHTML(html) {
    this.ownText = html.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, String.fromCharCode(0xa0)).replace(/&amp;/g, '&');
  }
}

class FakeText extends FakeNode {
  constructor(text) {
    super(3);
    this.data = text;
  }

  get textContent() {
    return this.data;
  }
}

export const fakeDocument = {
  createElement(name) {
    const text = String(name);
    if (!VALID_ELEMENT_NAME.test(text)) {
      throw new DOMException(`String contains an invalid character: ${text}`, 'InvalidCharacterError');
    }
    return new FakeElement(text);
  },
  createTextNode(text) {
    return new FakeText(String(text));
  },
  createProcessingInstruction(target, data) {
    const node = new FakeNode(7);
    node.target = target;
    node.data = String(data);
    Object.defineProperty(node, 'textContent', {get: () => ''});
    return node;
  },
};

/**
 * Makes `window` and `document` the stand-ins, as vtt.mjs reads them when it loads.
 * Import vtt.mjs (or anything that imports it) only after this, with a dynamic import.
 */
export function installFakeDom() {
  globalThis.document = fakeDocument;
  globalThis.window = globalThis;
}

/**
 * Writes a cue tree as markup, for comparing in a test.
 * @param {FakeNode} node - The tree's root.
 * @return {string}
 */
export function markup(node) {
  if (node.nodeType === 3) {
    return node.data;
  }
  if (node.nodeType === 7) {
    return `<?${node.target} ${node.data}?>`;
  }
  const inner = node.childNodes.map(markup).join('');
  if (node.ownText !== null && node.ownText !== undefined && node.childNodes.length === 0) {
    return `<${node.localName}>${node.ownText}</${node.localName}>`;
  }
  const attributes = [];
  if (node.className) attributes.push(` class="${node.className}"`);
  if (node.title) attributes.push(` title="${node.title}"`);
  if (node.lang) attributes.push(` lang="${node.lang}"`);
  const style = Object.entries(node.style).map(([k, v]) => `${k}:${v}`).join(';');
  if (style) attributes.push(` style="${style}"`);
  return `<${node.localName}${attributes.join('')}>${inner}</${node.localName}>`;
}
