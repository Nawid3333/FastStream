import vm from 'node:vm';
import {describe, expect, it} from 'vitest';

import source from '../../chrome/page-listeners.js?raw';

// A page that writes a document into a frame with document.open() erases the content scripts' window and document
// listeners (docs/notes/player.md, "Frames with no address of their own"): PageListeners adds them again.

/**
 * page-listeners.js in a frame whose listeners are recorded, and its document's observer.
 * @return {{PageListeners: *, window: Object, document: Object, added: Array<string>, mutate: () => void}}
 */
function frame() {
  const added = [];
  const target = (name) => ({addEventListener: (type, listener, options) => added.push(`${name} ${type} ${options === true}`)});
  const document = {documentElement: {}, ...target('document')};
  const window = target('window');
  /** @type {?Function} */
  let observed = null;
  const context = {
    document,
    window,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe(node, options) {
        if (node === document && options.childList) observed = this.callback;
      }
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, {filename: 'chrome/page-listeners.js'});
  return {PageListeners: vm.runInContext('PageListeners', context), window, document, added, mutate: () => observed?.()};
}

describe('PageListeners', () => {
  it('adds the listeners again once document.open() replaced the document', () => {
    const page = frame();
    page.PageListeners.add(page.window, 'message', () => {});
    page.PageListeners.add(page.document, 'play', () => {}, true);
    expect(page.added).toEqual(['window message false', 'document play true']);
    // A change below the same document: nothing to add.
    page.mutate();
    expect(page.added).toHaveLength(2);
    page.document.documentElement = null;
    page.mutate();
    page.document.documentElement = {};
    page.mutate();
    expect(page.added.slice(2)).toEqual(['window message false', 'document play true', 'window message false',
      'document play true']);
  });
});
