// ESLint 9 flat config. The repo already carried eslint, typescript-eslint and
// eslint-config-prettier as devDependencies and an `eslint .` script, but no
// config file — so `npm run lint` failed for everyone and nothing here had ever
// been linted.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The QuickBooks and Intuit SDKs are untyped in places, so `any` at those
      // boundaries is deliberate rather than a lapse.
      '@typescript-eslint/no-explicit-any': 'off',
      // Warn, not error: ~20 inherited tool files declare a documentation-only
      // `type ToolParams = z.infer<typeof toolSchema>` that nothing consumes.
      // Erroring would make the gate red on untouched upstream code and gain
      // nothing; as a warning the signal stays visible for new code.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['tests/**'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
  prettier
);
