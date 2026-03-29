import type { PromptDefinition } from './types.js';

export const RELEASE_NOTES_GENERATE_SYSTEM: PromptDefinition = {
  key: 'release-notes.generate.system',
  name: 'Release Note Generator',
  description:
    'Generates a concise, user-friendly release note from a git commit message and list of changed files.',
  taskType: 'GENERATE_RELEASE_NOTE',
  role: 'SYSTEM',
  content:
    'You are a technical writer for Bronco, a database operations platform. ' +
    'Given a git commit message and list of changed files, write a concise 1-2 sentence release note in plain language from a user\'s perspective. ' +
    'No file paths, no jargon, no bullet points.',
  temperature: 0.3,
  maxTokens: 150,
};

export const RELEASE_NOTES_PROMPTS: PromptDefinition[] = [RELEASE_NOTES_GENERATE_SYSTEM];
