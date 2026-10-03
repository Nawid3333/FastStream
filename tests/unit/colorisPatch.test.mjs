import fs from 'node:fs';
import vm from 'node:vm';
import {describe, expect, it} from 'vitest';
import {FakeDocument, FakeElement} from './helpers/fakeDom.mjs';

// For tests/unit/, once patches/Coloris@0.25.0.patch has the change (#298) and
// node_modules/Coloris is patched again by `pnpm install`. It runs the patched dist file,
// as tools/sync-vendor.mjs copies it, on the stand-in DOM.
// - The patch builds the picker (init) inside configure's `parent` case, so an option
//   handled before `parent` that touches the picker (clearLabel, closeLabel, a11y)
//   threw: InterfaceController lists `parent` first, and only that kept it working.
// - A second configure({parent}) built a second picker and bound every listener again.

const source = fs.readFileSync(new URL('../../node_modules/Coloris/dist/coloris.js', import.meta.url), 'utf8');

/**
 * Runs Coloris on a page with a .mainplayer and calls it with each set of options.
 * @param {...Object} calls - What Coloris() is called with, in turn.
 * @return {{doc: FakeDocument, container: FakeElement}}
 */
function runColoris(...calls) {
  const doc = new FakeDocument('<html><body><div class="mainplayer"></div></body></html>');
  doc.readyState = 'complete';
  doc.getElementsByClassName = (name) => doc.querySelectorAll('.' + name);
  class Element extends FakeElement {}
  Object.assign(FakeElement.prototype, {
    append(...nodes) {
      nodes.forEach((node) => this.appendChild(node));
    },
    getContext: () => ({fillStyle: '', fillRect() {}, getImageData: () => ({data: [0, 0, 0, 255]})}),
  });
  const win = {matchMedia: () => ({matches: true})};
  vm.runInNewContext(source, {
    window: win, document: doc, Math, NodeList: class {}, HTMLElement: FakeElement, Element,
    CustomEvent: class {}, setTimeout,
  });
  const coloris = win.Coloris; // a plain function, despite the capital
  for (const options of calls) coloris(options);
  return {doc, container: doc.querySelector('.mainplayer')};
}

describe('the patched Coloris', () => {
  it('takes options that touch the picker before `parent`', () => {
    const {doc, container} = runColoris({clearLabel: 'Clear it', parent: '.mainplayer'});
    expect(container.querySelectorAll('.clr-picker')).toHaveLength(1);
    expect(doc.getElementById('clr-clear').textContent).toBe('Clear it');
  });

  it('builds one picker when configured twice', () => {
    const {container} = runColoris({parent: '.mainplayer', theme: 'pill'}, {parent: '.mainplayer', alpha: true});
    expect(container.querySelectorAll('.clr-picker')).toHaveLength(1);
    const once = runColoris({parent: '.mainplayer', theme: 'pill'}).container;
    const count = (el) => Object.values(el.listeners).reduce((n, list) => n + list.length, 0);
    expect(count(container)).toBe(count(once));
  });
});
