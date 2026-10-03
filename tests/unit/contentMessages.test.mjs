import fs from 'node:fs';
import * as acorn from 'acorn';
import {describe, expect, it} from 'vitest';

// content.js runs in every page, which can go away while a message to the background is
// on its way. A chrome.runtime.sendMessage with no callback returns a promise, which then
// rejects ("Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved"), and
// unhandled it reached the page's console as an error and failed content-cleanup's Back
// case on Windows. Every message there either has a callback (Firefox then reports the
// failure through chrome.runtime.lastError) or goes through notifyBackground, which
// catches it. The promise/catch-or-return lint rule only sees .then() chains, not a
// promise left on its own, so this checks the source.
//
// Parsed, not scanned: a hand-rolled scanner took an apostrophe in a comment for the start
// of a string, and a harmless comment in content.js hung this file for a minute (#252).

const source = fs.readFileSync(new URL('../../chrome/content.js', import.meta.url), 'utf8');
const ast = acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'script', locations: true});

/**
 * The nodes of a syntax tree that pass a test, each with the node it sits in.
 * @param {Object} root - The tree.
 * @param {function(Object): boolean} test - Whether a node is wanted.
 * @return {Array<{node: Object, parent: ?Object}>}
 */
function nodesOf(root, test) {
  const found = [];
  const visit = (node, parent) => {
    if (test(node)) {
      found.push({node, parent});
    }
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child]) {
        if (item && typeof item.type === 'string') {
          visit(item, node);
        }
      }
    }
  };
  visit(root, null);
  return found;
}

/**
 * Whether a node is a dotted name, e.g. chrome.runtime.sendMessage.
 * @param {Object} node - The node.
 * @param {string} name - The dotted name.
 * @return {boolean}
 */
function isName(node, name) {
  const parts = name.split('.');
  const last = parts.pop();
  if (parts.length === 0) {
    return node.type === 'Identifier' && node.name === last;
  }
  return node.type === 'MemberExpression' && !node.computed && node.property.name === last &&
    isName(node.object, parts.join('.'));
}

const callsOf = (name) => nodesOf(ast, (node) => node.type === 'CallExpression' && isName(node.callee, name));
const isFunction = (node) => ['ArrowFunctionExpression', 'FunctionExpression', 'Identifier'].includes(node.type);
const caught = ({node, parent}) => parent?.type === 'MemberExpression' && parent.object === node &&
  parent.property.name === 'catch';

describe('content.js messages to the background', () => {
  const sends = callsOf('chrome.runtime.sendMessage');

  it('are found', () => {
    expect(sends.length).toBeGreaterThan(3);
  });

  it('each have a callback, or go through notifyBackground, which catches', () => {
    const bare = sends.filter((call) => !caught(call) &&
      !(call.node.arguments.length >= 2 && isFunction(call.node.arguments.at(-1))));
    expect(bare.map(({node}) => `content.js:${node.loc.start.line}`)).toEqual([]);
  });

  it('notifyBackground catches, and is used', () => {
    const declarations = nodesOf(ast, (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'notifyBackground');
    expect(declarations).toHaveLength(1);
    const [{node: declaration}] = declarations;

    const withCatch = sends.filter(caught);
    expect(withCatch).toHaveLength(1);
    // The one caught send is notifyBackground's own, and it sends the message it was given.
    const [{node: send}] = withCatch;
    expect(send.start > declaration.start && send.end < declaration.end).toBe(true);
    expect(isName(send.arguments[0], 'message')).toBe(true);
    expect(callsOf('notifyBackground').length).toBeGreaterThan(1);
  });
});
