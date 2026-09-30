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
        {
          // A transaction's date is the ISO instant of a local time (treasury:
          // local midnight = the UTC day before), so slicing it is off by one.
          selector:
            "CallExpression[callee.property.name=/^(slice|substring)$/][arguments.0.value=0]:matches([arguments.1.value=7], [arguments.1.value=10])[callee.object.property.name='date']",
          message:
            'A tranzakció dátuma helyi időpont ISO-alakja; a levágott eleje a UTC nap (kincstári tételeknél az előző nap). Használd: txDay(x.date) (src/lib/day.ts), hónaphoz txDay(x.date).slice(0, 7).',
        },
      ],
    },
  },
])
