// @ts-check
// Structural comparison of two JavaScript files, ignoring what the project's `eslint --fix` changes.
// Vendored libraries were run through eslint, so a text diff cannot tell whether code matches a release.
// The normalisation undoes only autofixes that cannot change behaviour: what still differs is real.

import * as acorn from 'acorn';

/**
 * Wraps a bare statement in a block, so `curly` cannot cause a mismatch.
 * @param {any} n
 */
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
 * Rewrites an AST into a canonical form, undoing the eslint autofixes that change no behaviour
 * (one-var, curly, quotes, no-var/prefer-const, indent, no-extra-semi); positions and comments are dropped.
 * @param {any} node
 * @return {any}
 */
export function normalise(node) {
  if (Array.isArray(node)) {
    const out = [];
    for (const n of node) {
      // `no-extra-semi`: a stray `;` parses to a statement that does nothing.
      if (n && n.type === 'EmptyStatement') continue;
      // `one-var`: flatten every group to single declarators.
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
    /** @type {{[key: string]: any}} */
    const out = {};
    // Sorted, so a rebuilt node cannot differ by key order alone.
    for (const k of Object.keys(node).sort()) {
      // `raw` is the literal's original text, including its quote characters.
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'range' ||
          k === 'raw') {
        continue;
      }
      if (node.type === 'TemplateElement' && k === 'value') {
        // `indent` re-wraps multi-line template literals, changing the whitespace inside them.
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

  // JSON.stringify refuses a BigInt.
  if (typeof node === 'bigint') return `${node}n`;

  return node;
}

/**
 * Parses source as a module, falling back to a script (several vendored bundles are scripts).
 * @param {string} src
 * @return {any}
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
 * @param {string} src
 * @return {string} equal for programs that differ only by lint fixes
 */
export function fingerprint(src) {
  return JSON.stringify(normalise(parse(src)));
}

/**
 * Every top-level named declaration, keyed by name: which parts match shows the base and its modifications.
 * @param {string} src
 * @return {Map<string, string>}
 */
export function declarations(src) {
  const out = new Map();
  /** @param {any[]} body */
  const walk = (body) => {
    for (const node of body) {
      if (node.type === 'ExportNamedDeclaration' ||
          node.type === 'ExportDefaultDeclaration') {
        if (node.declaration) walk([node.declaration]);
        continue;
      }
      // A bundle's payload is often one IIFE or block: its contents are compared, not the unit.
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
 * Every top-level `A.b.c = ...` assignment, keyed by its path: a prototype-based library declares almost nothing.
 * @param {string} src
 * @return {Map<string, string>}
 */
export function prototypeAssignments(src) {
  const out = new Map();
  /** @param {any} node */
  const pathOf = (node) => {
    if (!node || node.type !== 'MemberExpression') return null;
    const parts = [];
    let cur = node;
    while (cur && cur.type === 'MemberExpression') {
      const k = cur.property;
      parts.unshift(k.name ?? k.value ?? '?');
      cur = cur.object;
    }
    if (!cur || cur.type !== 'Identifier') return null;
    parts.unshift(cur.name);
    return parts.join('.');
  };
  for (const stmt of parse(src).body) {
    if (stmt.type !== 'ExpressionStatement') continue;
    const e = stmt.expression;
    if (e.type !== 'AssignmentExpression' || e.operator !== '=') continue;
    const key = pathOf(e.left);
    if (key) out.set(key, JSON.stringify(normalise(e.right)));
  }
  return out;
}

/**
 * Buckets two maps of the shape `declarations` and `prototypeAssignments` return.
 * @param {Map<string, string>} da
 * @param {Map<string, string>} db
 * @return {{same: string[], differs: string[], onlyA: string[],
 *   onlyB: string[]}} the four buckets
 */
function bucket(da, db) {
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
 * Compares two sources by their top-level assignments.
 * @param {string} a
 * @param {string} b
 * @return {{same: string[], differs: string[], onlyA: string[],
 *   onlyB: string[]}} the four buckets
 */
export function comparePrototypes(a, b) {
  return bucket(prototypeAssignments(a), prototypeAssignments(b));
}

/**
 * Compares two sources declaration by declaration.
 * @param {string} a
 * @param {string} b
 * @return {{same: string[], differs: string[], onlyA: string[],
 *   onlyB: string[]}} the four buckets
 */
export function compareDeclarations(a, b) {
  return bucket(declarations(a), declarations(b));
}

/**
 * Compares two sources and reports where they first differ.
 * @param {string} a
 * @param {string} b
 * @return {{equal: boolean, at?: number, aCtx?: string, bCtx?: string}}
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
