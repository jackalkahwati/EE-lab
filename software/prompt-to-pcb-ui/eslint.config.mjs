import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  globalIgnores([
    '.next/**',
    'node_modules/**',
    'public/runs/**',
    'public/data/**',
    'scripts/eda_runs/**',
    'scripts/flroute_runs/**',
  ]),
  {
    // This codebase intentionally consumes loose JSON hardware artifacts and
    // plain-JS enterprise modules. Keep lint focused on correctness rules while
    // those boundaries are incrementally typed.
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/static-components': 'off',
      'react/no-unescaped-entities': 'off',
    },
  },
])
