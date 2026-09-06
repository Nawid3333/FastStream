const {FlatCompat} = require('@eslint/eslintrc');
const globals = require('globals');

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
];
