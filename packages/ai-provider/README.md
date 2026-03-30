# @bronco/ai-provider

AI routing abstraction layer that dispatches requests to either a local Ollama instance or the Claude API based on task type.

## How It Works

The `AIRouter` classifies each request by its `TaskType` and sends it to the appropriate backend. Defaults can be overridden per task type and per client via the `AiModelConfig` DB table. Resolution order: CLIENT-scoped override → APP_WIDE override → hardcoded default.

| Backend | Task Types (defaults) | Use Case |
|---------|-----------|----------|
| **Ollama** (local) | `TRIAGE`, `CATEGORIZE`, `SUMMARIZE`, `DRAFT_EMAIL`, `EXTRACT_FACTS`, `SUMMARIZE_TICKET`, `SUGGEST_NEXT_STEPS`, `CLASSIFY_INTENT`, `SUMMARIZE_LOGS`, `GENERATE_TITLE`, `CLASSIFY_EMAIL`, `ANALYZE_WORK_ITEM`, `DRAFT_COMMENT`, `GENERATE_DEVOPS_PLAN`, `GENERATE_RELEASE_NOTE`, `SUMMARIZE_ROUTE`, `SELECT_ROUTE` | Fast, cost-free tasks that run on the Mac Mini |
| **Claude** (API) | `ANALYZE_QUERY`, `GENERATE_SQL`, `REVIEW_CODE`, `DEEP_ANALYSIS`, `BUG_ANALYSIS`, `ARCHITECTURE_REVIEW`, `SCHEMA_REVIEW`, `FEATURE_ANALYSIS`, `RESOLVE_ISSUE`, `GENERATE_RESOLUTION_PLAN`, `CHANGE_CODEBASE_SMALL`, `CHANGE_CODEBASE_LARGE`, `ANALYZE_TICKET_CLOSURE`, `CUSTOM_AI_QUERY` | Heavy reasoning tasks requiring Claude's capabilities |

## Exports

### `AIRouter`

The primary entry point. Instantiate with config, then call `generate()` with any `AIRequest`.

```typescript
import { AIRouter } from '@bronco/ai-provider';

const router = new AIRouter({
  ollamaBaseUrl: 'http://macmini:11434',
  ollamaModel: 'llama3.1:8b',       // optional, this is the default
  claudeApiKey: 'sk-ant-...',
  claudeModel: 'claude-sonnet-4-5-20250929', // optional, this is the default
});

const result = await router.generate({
  taskType: 'TRIAGE',
  prompt: 'Classify this support email...',
  systemPrompt: 'You are a DBA ticket triage assistant.',
  temperature: 0.3,
});

console.log(result.provider);   // 'LOCAL'
console.log(result.content);    // The model's response
console.log(result.durationMs); // Elapsed time in ms
```

### `OllamaClient`

Direct client for the Ollama REST API (`/api/generate` endpoint). Used internally by `AIRouter` but available for standalone use.

```typescript
import { OllamaClient } from '@bronco/ai-provider';

const ollama = new OllamaClient('http://macmini:11434', 'llama3.1:8b');
const result = await ollama.generate({
  taskType: 'SUMMARIZE',
  prompt: 'Summarize this email thread...',
});
```

### `ClaudeClient`

Direct client wrapping the `@anthropic-ai/sdk`. Used internally by `AIRouter` but available for standalone use.

```typescript
import { ClaudeClient } from '@bronco/ai-provider';

const claude = new ClaudeClient('sk-ant-...', 'claude-sonnet-4-5-20250929');
const result = await claude.generate({
  taskType: 'ANALYZE_QUERY',
  prompt: 'Analyze this execution plan XML...',
  maxTokens: 8192,
});
```

### `PromptResolver`

Resolves system prompts from a registry, applying per-client prepend/append overrides and keyword-based routing at generation time.

### `ModelConfigResolver`

DB-backed model config resolver. Resolves the provider/model for a task type with CLIENT → APP_WIDE → default layering and caching.

### `ProviderConfigResolver`

Resolves AI provider configurations from the DB, selecting the best available provider for a given capability level.

### `createAIRouter(db, options)`

Factory function that creates an AIRouter with all resolvers pre-configured from the database.

### Types

```typescript
import type { AIProviderClient, AIRouterConfig } from '@bronco/ai-provider';
```

- **`AIProviderClient`** — Interface implemented by both `OllamaClient` and `ClaudeClient`. Has a single `generate(request: AIRequest): Promise<AIResponse>` method.
- **`AIRouterConfig`** — Configuration object for `AIRouter` (`ollamaBaseUrl`, `ollamaModel?`, `claudeApiKey`, `claudeModel?`).
- **`AIRequest`** / **`AIResponse`** — Re-exported from `@bronco/shared-types`.

## Request / Response Shape

### `AIRequest`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `taskType` | `TaskType` | Yes | Determines which backend handles the request |
| `prompt` | `string` | Yes | The user/system prompt content |
| `context` | `Record<string, unknown>` | No | Additional context data |
| `systemPrompt` | `string` | No | System prompt prepended to the request |
| `maxTokens` | `number` | No | Max response tokens (default: 4096 for Claude) |
| `temperature` | `number` | No | Sampling temperature |

### `AIResponse`

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `'LOCAL' \| 'CLAUDE' \| 'OPENAI' \| 'GROK' \| 'GOOGLE'` | Which backend handled the request |
| `content` | `string` | The generated text |
| `model` | `string` | Actual model name used |
| `usage` | `{ inputTokens, outputTokens }` | Token usage (when available) |
| `durationMs` | `number` | Wall-clock time for the request |

## Source Layout

```
src/
├── index.ts                    # Barrel exports
├── types.ts                    # AIProviderClient interface, AIRouterConfig, re-exports
├── router.ts                   # AIRouter — task-based dispatch logic
├── ollama.ts                   # OllamaClient — local LLM via Ollama REST API
├── claude.ts                   # ClaudeClient — Anthropic Claude API via SDK
├── factory.ts                  # createAIRouter() factory function
├── model-config-resolver.ts    # DB-backed per-task model config resolver
├── provider-config-resolver.ts # DB-backed AI provider config resolver
├── prompt-resolver.ts          # Prompt registry with override/keyword support
├── client-memory-resolver.ts   # Per-client memory context resolver (cached, 5-min TTL)
├── task-capabilities.ts        # Task → capability level mapping
└── prompts/                    # Registered system prompt templates
    ├── index.ts                # Barrel export + ALL_PROMPTS registry
    ├── types.ts                # Prompt registration types
    ├── imap.ts                 # Email triage, categorize, summarize prompts
    ├── devops.ts               # DevOps workflow prompts
    ├── resolver.ts             # Issue resolution + plan generation prompts
    ├── logs.ts                 # Log summarization prompts
    ├── routing.ts              # Ticket routing prompts
    ├── release-notes.ts        # Release note generation prompts
    └── system-analysis.ts      # System closure analysis prompts
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | Claude API client |
| `@bronco/shared-types` | Shared enums and interfaces |
| `@bronco/db` | Prisma client for DB-backed config resolution |
| `@bronco/shared-utils` | Logger, config, crypto utilities |

## Adding a New Provider

1. Create a new class implementing `AIProviderClient` in `src/`.
2. Add it to the `AIRouter` constructor.
3. Update the routing logic in `getProvider()` to dispatch appropriate task types.
4. Export the new class from `src/index.ts`.
