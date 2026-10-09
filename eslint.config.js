const stylistic = require('@stylistic/eslint-plugin');
const globals = require('globals');
const noUnsanitized = require('eslint-plugin-no-unsanitized');
const promise = require('eslint-plugin-promise');

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
  {
    // The rules of eslint-config-google 0.14.0 (2019, the style this code was written in), with
    // the formatting ones from @stylistic/eslint-plugin: ESLint deprecated its own formatting
    // rules for removal, and the google config could only be loaded through FlatCompat with its
    // removed JSDoc rules taken out. Same rules and options, as this repo had them in effect
    // (max-len and camelcase off); no-new-object and no-new-symbol under their current names.
    plugins: {'@stylistic': stylistic},
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },
    rules: {
      // Possible errors
      'no-cond-assign': 0,
      'no-irregular-whitespace': 2,
      'no-unexpected-multiline': 2,

      // Best practices
      'curly': [2, 'multi-line'],
      'guard-for-in': 2,
      'no-caller': 2,
      'no-extend-native': 2,
      'no-extra-bind': 2,
      'no-invalid-this': 2,
      '@stylistic/no-multi-spaces': 2,
      'no-multi-str': 2,
      'no-new-wrappers': 2,
      'no-throw-literal': 2,
      'no-with': 2,
      'prefer-promise-reject-errors': 2,

      // Variables. ESLint 9+ changed the default for `caughtErrors` from 'none' to 'all', so
      // empty `catch (e) {}` blocks now flag. Preserve the ESLint 8 behaviour this repo was
      // linted clean under rather than churning shipped code for a stylistic rule.
      'no-unused-vars': [2, {args: 'none', caughtErrors: 'none'}],

      // Style
      '@stylistic/array-bracket-newline': 0,
      '@stylistic/array-bracket-spacing': [2, 'never'],
      '@stylistic/array-element-newline': 0,
      '@stylistic/block-spacing': [2, 'never'],
      '@stylistic/brace-style': 2,
      '@stylistic/comma-dangle': [2, 'always-multiline'],
      '@stylistic/comma-spacing': 2,
      '@stylistic/comma-style': 2,
      '@stylistic/computed-property-spacing': 2,
      '@stylistic/eol-last': 2,
      '@stylistic/function-call-spacing': 2,
      '@stylistic/indent': [2, 2, {
        CallExpression: {arguments: 2},
        FunctionDeclaration: {body: 1, parameters: 2},
        FunctionExpression: {body: 1, parameters: 2},
        MemberExpression: 2,
        ObjectExpression: 1,
        SwitchCase: 1,
        ignoredNodes: ['ConditionalExpression'],
        // ESLint's own rule left the line after an `=` as it was; @stylistic's checks it
        // unless told not to.
        assignmentOperator: 'off',
      }],
      '@stylistic/key-spacing': 2,
      '@stylistic/keyword-spacing': 2,
      '@stylistic/linebreak-style': 2,
      'new-cap': 2,
      'no-array-constructor': 2,
      '@stylistic/no-mixed-spaces-and-tabs': 2,
      '@stylistic/no-multiple-empty-lines': [2, {max: 2}],
      'no-object-constructor': 2,
      '@stylistic/no-tabs': 2,
      '@stylistic/no-trailing-spaces': 2,
      '@stylistic/object-curly-spacing': 2,
      'one-var': [2, {var: 'never', let: 'never', const: 'never'}],
      '@stylistic/operator-linebreak': [2, 'after'],
      '@stylistic/padded-blocks': [2, 'never'],
      '@stylistic/quote-props': [2, 'consistent'],
      '@stylistic/quotes': [2, 'single', {allowTemplateLiterals: 'always'}],
      '@stylistic/semi': 2,
      '@stylistic/semi-spacing': 2,
      '@stylistic/space-before-blocks': 2,
      '@stylistic/space-before-function-paren': [2, {asyncArrow: 'always', anonymous: 'never', named: 'never'}],
      '@stylistic/spaced-comment': [2, 'always'],
      '@stylistic/switch-colon-spacing': 2,

      // ECMAScript 6
      '@stylistic/arrow-parens': [2, 'always'],
      'constructor-super': 2,
      '@stylistic/generator-star-spacing': [2, 'after'],
      'no-new-native-nonconstructor': 2,
      'no-this-before-super': 2,
      'no-var': 2,
      'prefer-const': [2, {destructuring: 'all'}],
      'prefer-rest-params': 2,
      'prefer-spread': 2,
      '@stylistic/rest-spread-spacing': 2,
      '@stylistic/yield-star-spacing': [2, 'after'],
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
