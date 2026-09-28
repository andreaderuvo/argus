// Correctness only, never style. The frontend is plain ES modules with no build step; this is
// what stands in for the compiler it does not have.
//
// The two rules that matter most while static/app.js is being split into modules:
//   no-undef          a name used in a module that neither declares nor imports it. In a single
//                     file every function sees every other; after a move, a missed import is a
//                     ReferenceError that only fires when that code path runs — a menu opened
//                     once a month. This finds it without running anything.
//   no-import-assign  `token = x` where `token` is imported. ES imports are read-only live
//                     bindings: the assignment throws, again only when it runs.
import globals from 'globals';

const correctness = {
  'no-undef': 'error',
  'no-import-assign': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-class-assign': 'error',
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-self-assign': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-obj-calls': 'error',
  'no-setter-return': 'error',
  'no-this-before-super': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'getter-return': 'error',
  'for-direction': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-binary-expression': 'error',
  'no-loss-of-precision': 'error',
  'no-sparse-arrays': 'error',
  'no-unexpected-multiline': 'error',
  'no-undef-init': 'off',
};

export default [
  { ignores: ['static/vendor/**', 'node_modules/**'] },
  {
    files: ['static/**/*.js'],
    ignores: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: correctness,
  },
  {
    files: ['static/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.serviceworker },
    },
    rules: correctness,
  },
];
