import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

const RESTRICTED_PATTERN = {
  group: ['@anthropic-ai/sdk', '@anthropic-ai/sdk/*'],
  message:
    'Import Anthropic SDK only from packages/ai-provider/src/. ' +
    'Use the AIRouter abstraction via createAIRouter() for all AI calls — ' +
    'this ensures every call writes an ai_usage_logs row for cost tracking. ' +
    'See CLAUDE.md "AI Task Types and Routing" section.',
};

export default [
  // Default: no direct Anthropic SDK imports anywhere
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      'no-restricted-imports': ['error', { patterns: [RESTRICTED_PATTERN] }],
    },
  },
  // Whitelist: the provider implementation IS the centralized path
  {
    files: ['packages/ai-provider/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  // Ignore build output, node_modules, test fixtures
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.claude/**', '**/*.test.ts', '**/*.spec.ts'],
  },
];
