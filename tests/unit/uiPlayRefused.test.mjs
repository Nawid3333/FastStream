import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as acorn from 'acorn';
import {describe, expect, it} from 'vitest';

// client.play() rejects when Firefox refuses the play (autoplay rules) or a pause cuts it
// short. The play button, the speed-up key, the loop menu, a dropped file and a source picked
// in the Sources browser left that rejection to no one: an uncaught error in the console each
// time. Every call from the interface handles it, or hands it on to its own caller.

const uiDir = fileURLToPath(new URL('../../chrome/player/ui', import.meta.url));

/**
 * @param {string} dir
 * @return {string[]}
 */
function moduleFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return moduleFiles(full);
    return entry.name.endsWith('.mjs') ? [full] : [];
  });
}

/**
 * Whether a call's rejection is taken: .catch(f), .then(f, g), awaited inside a try that
 * catches, or returned to the caller.
 * @param {Array<{node: Object, key: string}>} ancestors - Outermost first; key: the field of
 *   the ancestor that holds the next one.
 * @return {boolean}
 */
function isHandled(ancestors) {
  const parent = ancestors[ancestors.length - 1]?.node;
  const grand = ancestors[ancestors.length - 2]?.node;
  if (parent?.type === 'MemberExpression' && grand?.type === 'CallExpression' && grand.callee === parent) {
    if (parent.property.name === 'catch') return true;
    if (parent.property.name === 'then' && grand.arguments.length >= 2) return true;
    return false;
  }
  if (parent?.type === 'ReturnStatement') return true;
  if (parent?.type === 'AwaitExpression') {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      const {node, key} = ancestors[i];
      if (/Function/.test(node.type)) return false;
      if (node.type === 'TryStatement' && key === 'block' && node.handler) return true;
    }
  }
  return false;
}

/**
 * The calls of `this.client.play()` whose rejection nothing takes.
 * @param {string} file
 * @return {number[]} Their lines.
 */
function unhandledPlays(file) {
  const ast = acorn.parse(fs.readFileSync(file, 'utf8'), {ecmaVersion: 'latest', sourceType: 'module', locations: true});
  const found = [];
  const ancestors = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed &&
        node.callee.property.name === 'play' && node.callee.object.type === 'MemberExpression' &&
        node.callee.object.object.type === 'ThisExpression' && node.callee.object.property.name === 'client' &&
        !isHandled(ancestors)) {
      found.push(node.loc.start.line);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const value = node[key];
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && typeof child.type === 'string') {
          ancestors.push({node, key});
          walk(child);
          ancestors.pop();
        }
      }
    }
  };
  walk(ast);
  return found;
}

describe('a play refused in the interface', () => {
  it('is handled at every call of client.play()', () => {
    const files = moduleFiles(uiDir);
    expect(files.length).toBeGreaterThan(10);
    const unhandled = files.flatMap((file) => unhandledPlays(file).map((line) => `${path.relative(uiDir, file)}:${line}`));
    expect(unhandled).toEqual([]);
  });

  it('tells a handled call from one left alone', () => {
    const lines = (code) => {
      const file = path.join(fileURLToPath(new URL('.', import.meta.url)), '.ui-play-probe.mjs');
      fs.writeFileSync(file, code);
      try {
        return unhandledPlays(file);
      } finally {
        fs.rmSync(file);
      }
    };
    expect(lines([
      'class A {',
      '  a() { this.client.play().catch(() => {}); }',
      '  b() { this.client.play().then(() => {}, () => {}); }',
      '  async c() { try { await this.client.play(); } catch (e) {} }',
      '  d() { return this.client.play(); }',
      '}',
    ].join('\n'))).toEqual([]);
    expect(lines([
      'class A {',
      '  a() { this.client.play(); }',
      '  b() { this.client.play().then(() => {}); }',
      '  async c() { await this.client.play(); }',
      '  async d() { try { x(() => this.client.play()); } catch (e) {} }',
      '}',
    ].join('\n'))).toEqual([2, 3, 4, 5]);
  });
});
