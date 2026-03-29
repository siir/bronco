import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join, relative, dirname, normalize, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { TaskType } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('issue-resolver:resolver');

export interface FileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content?: string;
}

export interface ResolveResult {
  changes: FileChange[];
  summary: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

// System prompt is resolved from the prompt registry (packages/ai-provider/src/prompts/resolver.ts)
// via promptKey 'resolver.resolve-issue.system' — no longer duplicated here.

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '.turbo', '.cache', '__pycache__', '.venv', 'vendor',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml', '.md', '.txt',
  '.css', '.scss', '.less', '.html', '.xml', '.svg',
  '.sql', '.prisma', '.graphql', '.env.example',
  '.sh', '.bash', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.swift', '.kt',
  '.dockerfile', '.conf', '.cfg', '.ini',
]);

/**
 * Recursively list all files in a directory, skipping ignored dirs.
 */
async function listFiles(dirPath: string, basePath: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(fullPath, basePath));
    } else {
      files.push(relative(basePath, fullPath));
    }
  }

  return files;
}

/**
 * Check if a file is likely a text file based on extension.
 */
function isTextFile(filePath: string): boolean {
  const lastDotIndex = filePath.lastIndexOf('.');
  const ext = lastDotIndex === -1 ? '' : filePath.slice(lastDotIndex);
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  // Files without extensions at root (Makefile, Dockerfile, etc.)
  return ['Makefile', 'Dockerfile', 'Caddyfile', 'Procfile', 'Gemfile', 'Rakefile'].includes(getBasename(filePath));
}

const LOW_VALUE_BASENAMES = /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|LICENSE|CHANGELOG([-.].+)?)$/i;

function getBasename(filePath: string): string {
  return filePath.split('/').pop() ?? '';
}
const LOW_VALUE_EXTENSIONS = /\.(map|d\.ts|min\.js|min\.css|lock)$/;

/**
 * Score a file path for relevance — lower score = higher priority.
 * Config and entry-point files surface first; tests and generated
 * artifacts sink to the bottom.
 */
function filePriorityScore(filePath: string): number {
  const basename = getBasename(filePath);
  const depth = filePath.split('/').length - 1;

  // Root config files — essential for project understanding
  if (depth === 0 && /^(package\.json|tsconfig.*\.json|\.env\.example)$/.test(basename)) return 0;

  // Prisma schema
  if (basename === 'schema.prisma') return 1;

  // Sub-package config files
  if (basename === 'package.json' || /^tsconfig.*\.json$/.test(basename)) return 2 + depth;

  // Index / entry files
  if (/^(index|main|app|server)\.(ts|js|tsx|jsx|mjs|cjs)$/.test(basename)) return 3 + depth;

  // Source files — prefer shallower
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(basename)) {
    // Test files deprioritized
    if (/\.(test|spec|e2e)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(basename) || filePath.includes('__tests__/')) return 20 + depth;
    return 5 + depth;
  }

  // SQL and migration files
  if (/\.sql$/.test(basename)) return 8 + depth;

  // Other config files
  if (/\.(json|yaml|yml|toml|ini|cfg|conf)$/.test(basename)) return 10 + depth;

  // Documentation
  if (/\.(md|txt)$/.test(basename)) return 15 + depth;

  // Everything else
  return 12 + depth;
}

/**
 * Read source files to provide context to Claude, prioritised by likely
 * relevance so the byte budget is spent on the most important files first.
 * Low-value generated/lock files are excluded entirely.
 */
async function gatherContext(
  repoPath: string,
  allFiles: string[],
  maxBytes: number = 200_000,
): Promise<string> {
  const textFiles = allFiles
    .filter(isTextFile)
    .filter(f => {
      return !LOW_VALUE_BASENAMES.test(getBasename(f)) && !LOW_VALUE_EXTENSIONS.test(f);
    })
    .sort((a, b) => filePriorityScore(a) - filePriorityScore(b));

  let totalBytes = 0;
  const parts: string[] = [];

  for (const file of textFiles) {
    if (totalBytes >= maxBytes) break;
    try {
      const content = await readFile(join(repoPath, file), 'utf-8');
      if (content.length > 50_000) continue; // Skip very large files
      parts.push(`--- ${file} ---\n${content}`);
      totalBytes += content.length;
    } catch {
      // Skip files that can't be read
    }
  }

  return parts.join('\n\n');
}

/**
 * Use AIRouter (resolves provider/model dynamically) to analyze the issue and generate file changes.
 */
export async function resolveIssue(opts: {
  ai: AIRouter;
  repoPath: string;
  issueTitle: string;
  issueDescription: string;
  issueCategory: string | null;
  clientId?: string;
}): Promise<ResolveResult> {
  const { ai, repoPath, issueTitle, issueDescription, issueCategory, clientId } = opts;

  logger.info({ issueTitle }, 'Starting issue analysis');

  // Gather repo context
  const allFiles = await listFiles(repoPath, repoPath);
  const fileTree = allFiles.join('\n');
  const sourceContext = await gatherContext(repoPath, allFiles);

  const prompt = `## Issue
**Title:** ${issueTitle}
**Category:** ${issueCategory ?? 'Not categorized'}
**Description:**
${issueDescription ?? 'No description provided.'}

## Repository Structure
\`\`\`
${fileTree}
\`\`\`

## Source Files
${sourceContext}

Analyze this issue and provide the exact file changes needed to resolve it.`;

  const response = await ai.generate({
    taskType: TaskType.RESOLVE_ISSUE,
    prompt,
    promptKey: 'resolver.resolve-issue.system',
    context: { clientId },
  });

  logger.info(
    { inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0, model: response.model },
    'AI response received',
  );

  // Parse and validate the JSON response
  const fileChangeSchema = z.object({
    path: z.string().min(1),
    action: z.enum(['create', 'modify', 'delete']),
    content: z.string().optional(),
  });

  const responseSchema = z.object({
    summary: z.string().default('Issue resolved'),
    changes: z.array(fileChangeSchema),
  });

  let parsed: z.infer<typeof responseSchema>;
  try {
    // Handle possible markdown fences around JSON
    const jsonStr = response.content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
    const raw = JSON.parse(jsonStr);
    parsed = responseSchema.parse(raw);
  } catch (err) {
    logger.error({ response: response.content.slice(0, 500) }, 'Failed to parse/validate AI response');
    throw new Error(`Failed to parse AI response: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    changes: parsed.changes,
    summary: parsed.summary ?? 'Issue resolved',
    model: response.model,
    usage: {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    },
  };
}

/**
 * Apply file changes to the local repo.
 */
export async function applyChanges(repoPath: string, changes: FileChange[]): Promise<void> {
  const resolvedRepo = resolve(repoPath);

  for (const change of changes) {
    // Guard against path traversal from AI-generated paths
    const normalized = normalize(change.path);
    if (normalized.startsWith('..') || normalized.startsWith('/')) {
      throw new Error(
        `Refusing to apply change with unsafe path "${change.path}". ` +
        'Paths must be relative and stay within the repository.',
      );
    }
    const fullPath = join(resolvedRepo, normalized);
    if (!fullPath.startsWith(resolvedRepo)) {
      throw new Error(`Path "${change.path}" resolves outside the repository`);
    }

    switch (change.action) {
      case 'create':
      case 'modify': {
        if (change.content === undefined) {
          throw new Error(`Missing content for ${change.action} on ${change.path}`);
        }
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, change.content, 'utf-8');
        logger.info({ path: change.path, action: change.action }, 'Applied change');
        break;
      }
      case 'delete': {
        if (existsSync(fullPath)) {
          await unlink(fullPath);
          logger.info({ path: change.path, action: 'delete' }, 'Deleted file');
        }
        break;
      }
      default: {
        const exhaustive: never = change.action;
        throw new Error(`Unknown file change action: "${exhaustive}"`);
      }
    }
  }
}
