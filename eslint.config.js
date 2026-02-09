import globals from 'globals';
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**'],
  },
  js.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
];
