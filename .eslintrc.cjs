module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    project: ['./tsconfig.json'],
    tsconfigRootDir: __dirname,
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'warn',
    'no-console': ['error', { allow: ['warn', 'error'] }],
    // Type-aware rules are enabled selectively. The full
    // `recommended-requiring-type-checking` preset is too noisy against
    // the existing codebase and `no-unnecessary-type-assertion` triggers
    // a stack overflow on execa's heavy generic types.
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
  },
  ignorePatterns: ['dist/', 'node_modules/', '*.cjs', 'tests/', 'scripts/', 'vitest.config.ts'],
};
