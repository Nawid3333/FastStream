// Methods of a class read from its source file, for a module that cannot be imported in Node
// (one that queries the page's DOM as it loads): each is compiled as a method of a plain
// object, with the module-level names a test hands over in scope, and called with the `this`
// the test makes.
import fs from 'node:fs';

/**
 * @param {URL|string} file - The module's source.
 * @param {string[]} names - The methods; a name ending in "?" may be missing.
 * @param {Object<string, *>} [scope] - The module-level names the methods use.
 * @return {Object<string, Function>}
 */
export function methodsOf(file, names, scope = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const parts = [];
  for (const entry of names) {
    const optional = entry.endsWith('?');
    const name = optional ? entry.slice(0, -1) : entry;
    const start = new RegExp(`^ {2}(async )?${name}\\(`, 'm').exec(source);
    if (!start) {
      if (optional) continue;
      throw new Error(`No method ${name}`);
    }
    const end = source.indexOf('\n  }\n', start.index);
    parts.push(source.slice(start.index, end + 4));
  }
  const keys = Object.keys(scope);
  return new Function(...keys, `return {\n${parts.join(',\n')}\n};`)(...keys.map((key) => scope[key]));
}

/**
 * The methods bound to a stand-in `this`, which also gets them as its own.
 * @param {Object} self
 * @param {Object<string, Function>} methods
 * @return {Object}
 */
export function withMethods(self, methods) {
  for (const [name, method] of Object.entries(methods)) self[name] = method.bind(self);
  return self;
}
