import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier';

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: { js },
    extends: ['js/recommended'],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-unused-vars': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'all'],
      'no-var': 'error',
      'object-shorthand': 'error',
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'always'],
      'comma-dangle': ['error', 'always-multiline'],
      'arrow-body-style': ['error', 'as-needed'],
      'no-implicit-coercion': 'error',
      'no-multi-spaces': 'error',
      'no-trailing-spaces': 'error',
      'no-unneeded-ternary': 'error',
      'consistent-return': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='estimatedDocumentCount']",
          message: 'estimatedDocumentCount is not tenant-aware; use countDocuments instead.',
        },
        {
          selector:
            "Property:matches([key.name='$lookup'], [key.value='$lookup'], [key.name='$graphLookup'], [key.value='$graphLookup'], [key.name='$unionWith'], [key.value='$unionWith'])",
          message:
            'Aggregation joins ($lookup/$graphLookup/$unionWith) bypass tenant scoping on the joined collection. The sub-pipeline MUST include a { $match: { tenantId } } stage. If verified, disable this line with an explanation: // eslint-disable-next-line no-restricted-syntax.',
        },
        {
          selector:
            "Property:matches([key.name='$merge'], [key.value='$merge'], [key.name='$out'], [key.value='$out'])",
          message:
            '$merge/$out write aggregation results into a collection without tenant scoping. Confirm the destination and tenant fields, then disable this line with an explanation: // eslint-disable-next-line no-restricted-syntax.',
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': 'allow-with-description',
        },
      ],
    },
  },
  tseslint.configs.recommended,
  eslintConfigPrettier,
  // eslint-config-prettier disables max-len. Re-enable it last so Prettier auto-folds
  // what it can (printWidth 100) and max-len still flags lines it cannot fold
  // (e.g. long string literals) for manual attention.
  {
    rules: {
      'max-len': [
        'warn',
        {
          code: 100,
          ignoreUrls: true,
          // Prettier cannot fold these, so don't flag them — everything that
          // remains flagged is code Prettier will auto-fold into compliance.
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: true,
        },
      ],
    },
  },
]);
