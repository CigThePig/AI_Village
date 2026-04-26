import js from '@eslint/js';
import globals from 'globals';

const aivGlobals = {
  AIV_TERRAIN: 'readonly',
  AIV_CONFIG: 'readonly',
  AIV_NOISE: 'readonly',
  AIV_APP: 'writable',
  AIV_SCOPE: 'readonly',
  AIV_STORAGE: 'writable',
  AIV_WORLDGEN_READY: 'writable',
  __AIV_BOOT__: 'writable',
  __AIV_BOOT_FAILED__: 'writable',
  __AIV_DEBUGKIT_READY__: 'writable',
  __AIV_WORLDGEN_RESOLVE__: 'writable',
  __AIV_WORLDGEN_REJECT__: 'writable',
  DebugKit: 'writable',
  LIGHTING: 'writable',
  reportFatal: 'readonly'
};

export default [
  {
    ignores: ['dist/**', 'node_modules/**']
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...aivGlobals
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-prototype-builtins': 'off',
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-inner-declarations': 'off',
      'no-cond-assign': ['error', 'except-parens'],
      'no-control-regex': 'off',
      'no-useless-escape': 'warn'
    }
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...aivGlobals
      }
    }
  }
];
