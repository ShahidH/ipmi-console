// Lint: TypeScript recommended rules everywhere; React hooks rules (incl. the
// React Compiler checks in eslint-plugin-react-hooks 7) for the renderer.
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'release/', 'coverage/', 'test-results/', 'artifacts/', 'refs/', 'tools/', 'captures/', 'private/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Protocol code walks binary structures with explicit casts; `any` stays a reviewed exception.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'tests/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    ...reactHooks.configs.flat.recommended,
  },
);
