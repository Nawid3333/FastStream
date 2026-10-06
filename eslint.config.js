const {FlatCompat} = require('@eslint/eslintrc');
const globals = require('globals');
const noUnsanitized = require('eslint-plugin-no-unsanitized');
const promise = require('eslint-plugin-promise');

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

// `eslint-config-google@0.14.0` still references `valid-jsdoc` and
// `require-jsdoc`, which were removed from core in ESLint 9. Strip them from
// the compat output so the config loads under ESLint 10.
const google = compat.extends('google').map((entry) => {
  if (entry.rules) {
    delete entry.rules['valid-jsdoc'];
    delete entry.rules['require-jsdoc'];
  }
  return entry;
});

module.exports = [
  {
    ignores: [
      'node_modules/',
      'built/',
      'build_*/',
      'web-ext-artifacts/',
      'chrome/player/modules/',
      'chrome/player/assets/',
      'coverage/',
      // ESLint 8 ignored dot-directories by default; ESLint 9+ does not.
      // These are generated/throwaway and must stay out of the lint scope.
      '.dev-profile/',
      '.git/',
      '.vscode/',
      '.claude/',
      // Stryker's copies of the repo; one outlives a run that could not delete it.
      '.stryker-tmp/',
      // The e2e fixtures are all generated (gitignored): the media buildFixtures makes, and the
      // hls.js and dash.js releases the live suite downloads (live-libs), 136,000 errors.
      'tests/e2e/fixtures/',
    ],
  },
  ...google,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      'max-len': 0,
      'camelcase': 'off',
      // ESLint 9+ changed the default for `caughtErrors` from 'none' to
      // 'all', so empty `catch (e) {}` blocks now flag. Preserve the ESLint 8
      // behaviour this repo was linted clean under rather than churning
      // shipped code for a stylistic rule.
      'no-unused-vars': ['error', {args: 'none', caughtErrors: 'none'}],
    },
  },
  {
    // A promise chain with no error path: a rejection left a message's sender waiting for
    // an answer that never came, or a flag half set. And HTML reaches a page only through
    // the DOM, never as a string (none does today; this keeps it so).
    files: ['chrome/**/*.{js,mjs}', 'build.mjs', 'tools/**/*.mjs'],
    plugins: {'promise': promise, 'no-unsanitized': noUnsanitized},
    rules: {
      'promise/catch-or-return': ['error', {allowThen: true, allowFinally: true}],
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
  {
    // fc.assert of an async property returns a promise. Left unawaited, the test ends
    // before the runs do, and a failing run surfaces as an unhandled rejection that names
    // no test (#250).
    files: ['tests/**/*.mjs'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: 'ExpressionStatement > CallExpression[callee.object.name="fc"][callee.property.name="assert"][arguments.0.callee.property.name="asyncProperty"]',
        message: 'await (or return) fc.assert of an fc.asyncProperty, or its failures name no test.',
      }],
    },
  },
];
