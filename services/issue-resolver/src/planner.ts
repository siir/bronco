import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { TaskType } from '@bronco/shared-types';
import type { ResolutionPlan, PlanActionCategory } from '@bronco/shared-types';
import type { AIRouter } from '@bronco/ai-provider';
import { createLogger } from '@bronco/shared-utils';

const logger = createLogger('issue-resolver:planner');

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

function isTextFile(filePath: string): boolean {
  const lastDotIndex = filePath.lastIndexOf('.');
  const ext = lastDotIndex === -1 ? '' : filePath.slice(lastDotIndex);
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  const basename = filePath.split('/').pop() ?? '';
  return ['Makefile', 'Dockerfile', 'Caddyfile', 'Procfile', 'Gemfile', 'Rakefile'].includes(basename);
}

const LOW_VALUE_BASENAMES = /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|LICENSE|CHANGELOG([-.].+)?)$/i;
const LOW_VALUE_EXTENSIONS = /\.(map|d\.ts|min\.js|min\.css|lock)$/;

async function gatherPlanContext(
  repoPath: string,
  allFiles: string[],
  maxBytes: number = 150_000,
): Promise<string> {
  const textFiles = allFiles
    .filter(isTextFile)
    .filter(f => {
      const basename = f.split('/').pop() ?? '';
      return !LOW_VALUE_BASENAMES.test(basename) && !LOW_VALUE_EXTENSIONS.test(f);
    });

  let totalBytes = 0;
  const parts: string[] = [];

  for (const file of textFiles) {
    if (totalBytes >= maxBytes) break;
    try {
      const content = await readFile(join(repoPath, file), 'utf-8');
      if (content.length > 50_000) continue;
      parts.push(`--- ${file} ---\n${content}`);
      totalBytes += content.length;
    } catch {
      // Skip files that can't be read
    }
  }

  return parts.join('\n\n');
}

// ─── Zod schemas for parsing AI response ───

const planActionSchema = z.object({
  description: z.string(),
  category: z.enum(['WILL_DO', 'CAN_DO_IF_ALLOWED', 'CANNOT_DO']),
  files: z.array(z.string()).optional(),
  manualSteps: z.string().optional(),
  requirement: z.string().optional(),
});

const planResponseSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  actions: z.array(planActionSchema),
  assumptions: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  estimatedFiles: z.number().int().default(0),
});

function parsePlanResponse(content: string): ResolutionPlan {
  const jsonStr = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
  const raw = JSON.parse(jsonStr);
  const parsed = planResponseSchema.parse(raw);
  return {
    summary: parsed.summary,
    approach: parsed.approach,
    actions: parsed.actions.map(a => ({
      description: a.description,
      category: a.category as PlanActionCategory,
      files: a.files,
      manualSteps: a.manualSteps,
      requirement: a.requirement,
    })),
    assumptions: parsed.assumptions,
    openQuestions: parsed.openQuestions,
    estimatedFiles: parsed.estimatedFiles,
  };
}

export interface GeneratePlanOpts {
  ai: AIRouter;
  repoPath: string;
  issueTitle: string;
  issueDescription: string;
  issueCategory: string | null;
  clientId?: string;
}

export interface PlanResult {
  plan: ResolutionPlan;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function generatePlan(opts: GeneratePlanOpts): Promise<PlanResult> {
  const { ai, repoPath, issueTitle, issueDescription, issueCategory, clientId } = opts;

  logger.info({ issueTitle }, 'Generating resolution plan');

  const allFiles = await listFiles(repoPath, repoPath);
  const fileTree = allFiles.join('\n');
  const sourceContext = await gatherPlanContext(repoPath, allFiles);

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

Analyze this issue and generate a resolution plan. Do NOT generate code — describe the approach and list specific actions needed.`;

  const response = await ai.generate({
    taskType: TaskType.GENERATE_RESOLUTION_PLAN,
    prompt,
    promptKey: 'resolver.generate-plan.system',
    context: { clientId },
  });

  logger.info(
    { inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0, model: response.model },
    'Plan generation AI response received',
  );

  let plan: ResolutionPlan;
  try {
    plan = parsePlanResponse(response.content);
  } catch (err) {
    logger.error({ response: response.content.slice(0, 500) }, 'Failed to parse plan AI response');
    throw new Error(`Failed to parse plan response: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    plan,
    model: response.model,
    usage: {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    },
  };
}

export interface RegeneratePlanOpts extends GeneratePlanOpts {
  previousPlan: ResolutionPlan;
  feedback: string;
}

export async function regeneratePlan(opts: RegeneratePlanOpts): Promise<PlanResult> {
  const { ai, repoPath, issueTitle, issueDescription, issueCategory, clientId, previousPlan, feedback } = opts;

  logger.info({ issueTitle, feedback: feedback.slice(0, 200) }, 'Regenerating resolution plan with feedback');

  const allFiles = await listFiles(repoPath, repoPath);
  const fileTree = allFiles.join('\n');
  const sourceContext = await gatherPlanContext(repoPath, allFiles);

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

## Previous Plan
\`\`\`json
${JSON.stringify(previousPlan, null, 2)}
\`\`\`

## Operator Feedback
${feedback}

The operator has rejected the previous plan with the feedback above. Generate an updated resolution plan that addresses the feedback. Do NOT generate code — describe the approach and list specific actions needed.`;

  const response = await ai.generate({
    taskType: TaskType.GENERATE_RESOLUTION_PLAN,
    prompt,
    promptKey: 'resolver.generate-plan.system',
    context: { clientId },
  });

  logger.info(
    { inputTokens: response.usage?.inputTokens ?? 0, outputTokens: response.usage?.outputTokens ?? 0, model: response.model },
    'Plan regeneration AI response received',
  );

  let plan: ResolutionPlan;
  try {
    plan = parsePlanResponse(response.content);
  } catch (err) {
    logger.error({ response: response.content.slice(0, 500) }, 'Failed to parse regenerated plan AI response');
    throw new Error(`Failed to parse regenerated plan response: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    plan,
    model: response.model,
    usage: {
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    },
  };
}
