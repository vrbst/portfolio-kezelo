import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // `const { raw: _raw, ...rest } = x` — dropping a field via rest is intended.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
      // The UTC day of a local-midnight instant is the day before in Budapest —
      // the cause of several one-day-off bugs. Use src/lib/day.ts instead.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name=/^(slice|substring|substr)$/][arguments.1.value=10][callee.object.callee.property.name='toISOString'], CallExpression[callee.property.name='split'][callee.object.callee.property.name='toISOString']",
          message:
            'toISOString() a UTC napot adja (Budapesten helyi éjfélnél az előző napot). Használd a src/lib/day.ts segédfüggvényeit: toLocalDay / todayLocal / addDaysIso / utcDay.',
        },
      ],
    },
  },
])
