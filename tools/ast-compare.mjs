// Structural comparison of two JavaScript files, ignoring the differences
// that the project's own `eslint --fix` introduces.
//
// Why this exists
// ---------------
// Every vendored library in this tree was run through the project's eslint
// before being committed. That produces enormous textual diffs from files
// that are functionally untouched - pako's diff was 12,855 lines and collapsed
// to 25 once whitespace was ignored - which makes "is this the same code as
// the published release?" impossible to answer by reading a diff.
//
// Comparing parsed programs answers it. The normalisation below undoes only
// transformations that eslint's autofixer performs and that cannot change
// behaviour, so anything still differing afterwards is a real difference.
//
// This is the tool that found mp4-muxer's base version (4.3.3, where a
// line-count search pointed at 5.0.0), proved gif.js and vtt.js, and would
// have prevented the mp4box mistake, which was argued from the shape of a
// diff rather than from the parsed program.

import fs from 'node:fs';
import * as acorn from 'acorn';

/** Wraps a bare statement in a block, so `curly` cannot cause a mismatch. */
function block(n) {
  if (!n || typeof n !== 'object' || Array.isArray(n)) return n;
  if (n.type === 'BlockStatement') return n;
  return {type: 'BlockStatement', body: [n]};
}

const LOOPS = new Set([
  'ForStatement', 'ForInStatement', 'ForOfStatement',
  'WhileStatement', 'DoWhileStatement',
]);

/**
 * Rewrites an AST into a canonical form.
 *
 * Each rule below corresponds to an eslint rule in this project's config
 * whose autofix rewrites source without changing what it does:
 *
 * | Rule                      | What it changes                          |
 * |---------------------------|------------------------------------------|
 * | `one-var`                 | `var a, b` into `var a; var b`            |
 * | `curly`                   | `if (x) stmt;` into `if (x) { stmt; }`    |
 * | `quotes`                  | a literal's raw text, not its value       |
 * | `no-var` / `prefer-const` | the declaration keyword                   |
 * | `indent`                  | whitespace inside a template literal      |
 * | `no-extra-semi`           | a stray `;` between statements            |
 *
 * Positions and comments are dropped too: they carry no behaviour.
 *
 * @param {any} node an AST node, array of nodes, or primitive
 * @return {any} the node in canonical form
 */
export function normalise(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const n of node) {
      // `no-extra-semi`: a stray `;` parses to a statement that does nothing.
      if (n && n.type === 'EmptyStatement') continue;
      // `one-var`: a grouped declaration and separate ones are the same
      // program, so flatten every group to single declarators.
      if (n && n.type === 'VariableDeclaration' && n.declarations.length > 1) {
        for (const d of n.declarations) {
          out.push(normalise(
              {type: 'VariableDeclaration', kind: n.kind, declarations: [d]}));
        }
      } else {
        out.push(normalise(n));
      }
    }
    return out;
  }

  if (node && typeof node === 'object') {
    const out = {};
    // Sorted so that a node this function rebuilds cannot differ from an
    // equivalent one merely by key order.
    for (const k of Object.keys(node).sort()) {
      // `raw` is the literal's original text, including its quote characters.
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'range' ||
          k === 'raw') {
        continue;
      }
      if (node.type === 'TemplateElement' && k === 'value') {
        // `indent` re-wraps multi-line template literals, which changes the
        // whitespace inside the string. Only error messages are affected.
        out[k] = {
          cooked: String(node.value.cooked).replace(/\s+/g, ' ').trim(),
        };
        continue;
      }
      if (node.type === 'VariableDeclaration' && k === 'kind') {
        out[k] = 'decl';
        continue;
      }
      let v = node[k];
      if ((node.type === 'IfStatement' &&
           (k === 'consequent' || k === 'alternate')) ||
          (LOOPS.has(node.type) && k === 'body')) {
        v = block(v);
      }
      out[k] = normalise(v);
    }
    return out;
  }

  return node;
}

/**
 * Parses source as a module, falling back to a script.
 *
 * Several vendored bundles are classic scripts rather than modules, and
 * acorn needs to be told which; trying both avoids having to record it.
 *
 * @param {string} src JavaScript source
 * @return {object} the parsed program
 */
export function parse(src) {
  try {
    return acorn.parse(src, {ecmaVersion: 'latest', sourceType: 'module'});
  } catch {
    return acorn.parse(src, {ecmaVersion: 'latest', sourceType: 'script'});
  }
}

/**
 * Canonical fingerprint of a source string.
 *
 * @param {string} src JavaScript source
 * @return {string} a string equal for programs that differ only by lint fixes
 */
export function fingerprint(src) {
  return JSON.stringify(normalise(parse(src)));
}

/**
 * Extracts every top-level named declaration, keyed by name.
 *
 * Whole-file comparison answers "is this the same program?" but says nothing
 * useful when the answer is no. These files are concatenations or adapted
 * forks, so the interesting question is *which parts* match: a candidate
 * where 40 of 44 functions are byte-for-byte the published ones is the base,
 * and the four that differ are the modifications to document.
 *
 * Ranking by whole-file size cannot see that. It ranked coloris v0.25.0 top
 * only because the vendored file is larger than every release, which makes
 * "newest" and "nearest" the same answer for the wrong reason.
 *
 * @param {string} src JavaScript source
 * @return {Map<string, string>} declaration name to its canonical form
 */
export function declarations(src) {
  const out = new Map();
  const walk = (body) => {
    for (const node of body) {
      if (node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportDefaultDeclaration') {
        if (node.declaration) walk([node.declaration]);
        continue;
      }
      // A bundle's whole payload is often one IIFE or one block; descend so
      // its contents are compared rather than treated as a single unit.
      if (node.type === 'ExpressionStatement' &&
          node.expression.type === 'CallExpression' &&
          /Function/.test(node.expression.callee.type) &&
          node.expression.callee.body?.type === 'BlockStatement') {
        walk(node.expression.callee.body.body);
        continue;
      }
      if (node.type === 'BlockStatement') {
        walk(node.body);
        continue;
      }
      if (node.type === 'ClassDeclaration' ||
          node.type === 'FunctionDeclaration') {
        if (node.id) out.set(node.id.name, JSON.stringify(normalise(node)));
        continue;
      }
      if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations) {
          if (d.id.type === 'Identifier' && d.init) {
            out.set(d.id.name, JSON.stringify(normalise(d.init)));
          }
        }
      }
    }
  };
  walk(parse(src).body);
  return out;
}

/**
 * Compares two sources declaration by declaration.
 *
 * @param {string} a first source
 * @param {string} b second source
 * @return {{same: string[], differs: string[], onlyA: string[],
 *   onlyB: string[]}} the four buckets
 */
export function compareDeclarations(a, b) {
  const da = declarations(a);
  const db = declarations(b);
  const same = [];
  const differs = [];
  const onlyA = [];
  for (const [name, code] of da) {
    if (!db.has(name)) onlyA.push(name);
    else if (db.get(name) === code) same.push(name);
    else differs.push(name);
  }
  const onlyB = [...db.keys()].filter((n) => !da.has(n));
  return {same, differs, onlyA, onlyB};
}

/**
 * Compares two sources and reports where they first differ.
 *
 * @param {string} a first source
 * @param {string} b second source
 * @return {{equal: boolean, at?: number, aCtx?: string, bCtx?: string}} result
 */
export function compare(a, b) {
  const fa = fingerprint(a);
  const fb = fingerprint(b);
  if (fa === fb) return {equal: true};
  let i = 0;
  while (i < fa.length && fa[i] === fb[i]) i++;
  return {
    equal: false,
    at: i,
    aCtx: fa.slice(Math.max(0, i - 100), i + 160),
    bCtx: fb.slice(Math.max(0, i - 100), i + 160),
  };
}

/**
 * Convenience wrapper for comparing two files on disk.
 *
 * @param {string} fileA path to the first file
 * @param {string} fileB path to the second file
 * @return {{equal: boolean, at?: number, aCtx?: string, bCtx?: string}} result
 */
export function compareFiles(fileA, fileB) {
  return compare(fs.readFileSync(fileA, 'utf8'), fs.readFileSync(fileB, 'utf8'));
}
