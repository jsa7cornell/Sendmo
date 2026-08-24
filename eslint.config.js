import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // .claude/ holds agent worktrees (full repo copies — linting them multiplies
  // every finding), _archive/ holds embedded repos with .next build output.
  globalIgnores(['dist', '.claude/', '_archive/', 'playwright-report/', 'test-results/', 'coverage/']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The codebase deliberately names intentionally-unused bindings with a
      // leading underscore (mock params like `_table`, kept-for-signature args
      // like `_expectedBalance`); tell the rule about the convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // shadcn/ui generated components canonically export their cva variant
    // objects (buttonVariants, badgeVariants) alongside the component; that's
    // the library's documented import surface, not our code to restructure.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
