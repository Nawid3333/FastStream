import fs from 'node:fs';
import * as acorn from 'acorn';
import {describe, expect, it} from 'vitest';

// SweetAlert2 parses a dialog's `title` as HTML; `titleText` and `text` are set as text.
// The error dialog put the caught error's message in the title, and a message can quote
// what the code failed on (a URL, a file's text): markup in it was rendered, an <img>
// loaded. AlertPolyfill imports the generated sweetalert.mjs, which does not exist before
// the build (CI runs the unit tests first), so its dialogs are read from the source: the
// options each Dialog.fire() call hands SweetAlert2.

const source = fs.readFileSync(new URL('../../chrome/player/utils/AlertPolyfill.mjs', import.meta.url), 'utf8');

/**
 * The option names of every Dialog.fire({...}) call, by the method it is in.
 * @return {Map<string, string[]>}
 */
function fireOptionsByMethod() {
  const calls = new Map();
  const walk = (node, method) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child) => walk(child, method));
      return;
    }
    if (node.type === 'MethodDefinition') method = node.key.name;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'Dialog' && node.callee.property.name === 'fire') {
      const [options] = node.arguments;
      expect(options.type, `Dialog.fire in ${method}`).toBe('ObjectExpression');
      calls.set(method, options.properties.map((prop) => prop.key.name));
    }
    for (const key of Object.keys(node)) {
      if (key !== 'start' && key !== 'end') walk(node[key], method);
    }
  };
  walk(acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'}), null);
  return calls;
}

describe('AlertPolyfill', () => {
  const calls = fireOptionsByMethod();

  it('finds the dialogs it checks', () => {
    expect([...calls.keys()].sort()).toEqual(['alert', 'confirm', 'errorSendToDeveloper', 'prompt', 'toast']);
  });

  it('shows an error\'s message in the error dialog as text, not HTML', () => {
    expect(calls.get('errorSendToDeveloper')).toContain('titleText');
    expect(calls.get('errorSendToDeveloper')).not.toContain('title');
  });

  it('shows a toast\'s message as text', () => {
    expect(calls.get('toast')).toContain('titleText');
    expect(calls.get('toast')).not.toContain('title');
  });

  it('never hands SweetAlert2 a title to parse', () => {
    for (const [method, options] of calls) {
      expect(options, method).not.toContain('title');
    }
  });
});
