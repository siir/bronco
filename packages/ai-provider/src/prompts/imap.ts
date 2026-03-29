import type { PromptDefinition } from './types.js';

// ─── Phase 1: Receipt Confirmation ──────────────────────────────────────────

export const IMAP_SUMMARIZE_SYSTEM: PromptDefinition = {
  key: 'imap.summarize.system',
  name: 'Email Summarizer',
  description: 'Summarizes inbound support email content into bullet points for quick triage.',
  taskType: 'SUMMARIZE',
  role: 'SYSTEM',
  content: 'You are a support ticket summarizer. Output only the bullet-point summary, nothing else.',
  temperature: 0.3,
  maxTokens: null,
};

export const IMAP_CATEGORIZE_SYSTEM: PromptDefinition = {
  key: 'imap.categorize.system',
  name: 'Ticket Categorizer',
  description: 'Classifies a support ticket into one of the defined categories based on its content.',
  taskType: 'CATEGORIZE',
  role: 'SYSTEM',
  content: 'You classify support tickets. Respond with a single category name and nothing else.',
  temperature: 0,
  maxTokens: null,
};

export const IMAP_TRIAGE_SYSTEM: PromptDefinition = {
  key: 'imap.triage.system',
  name: 'Ticket Triager',
  description: 'Assesses ticket priority based on urgency indicators in the email content.',
  taskType: 'TRIAGE',
  role: 'SYSTEM',
  content: 'You triage support tickets by urgency. Respond with a single priority level and nothing else.',
  temperature: 0,
  maxTokens: null,
};

export const IMAP_DRAFT_RECEIPT_SYSTEM: PromptDefinition = {
  key: 'imap.draft-receipt.system',
  name: 'Receipt Email Drafter',
  description: 'Generates a professional acknowledgement email when a new support ticket is received.',
  taskType: 'DRAFT_EMAIL',
  role: 'SYSTEM',
  content:
    'You draft professional support emails. Output only the email body text, no subject line or headers. ' +
    'Always address the recipient by name and sign with the sender name provided.',
  temperature: 0.4,
  maxTokens: null,
};

export const IMAP_SUMMARIZE_TICKET_SYSTEM: PromptDefinition = {
  key: 'imap.summarize-ticket.system',
  name: 'Ticket Summary Generator',
  description: 'Creates a comprehensive summary paragraph of a ticket including its full event history.',
  taskType: 'SUMMARIZE_TICKET',
  role: 'SYSTEM',
  content: 'You summarize support tickets. Output only the summary paragraph, nothing else.',
  temperature: 0.3,
  maxTokens: null,
};

// ─── Phase 2: Deep Analysis ─────────────────────────────────────────────────

export const IMAP_EXTRACT_FACTS_SYSTEM: PromptDefinition = {
  key: 'imap.extract-facts.system',
  name: 'Fact Extractor',
  description: 'Extracts structured data (error messages, files, services, keywords) from email text as JSON.',
  taskType: 'EXTRACT_FACTS',
  role: 'SYSTEM',
  content: 'You extract structured data from emails. Respond with valid JSON only.',
  temperature: 0,
  maxTokens: null,
};

export const IMAP_DEEP_ANALYSIS_SYSTEM: PromptDefinition = {
  key: 'imap.deep-analysis.system',
  name: 'Deep Issue Analyzer',
  description:
    'Performs thorough analysis of a support issue using code context, database metrics, and email content.',
  taskType: 'DEEP_ANALYSIS',
  role: 'SYSTEM',
  content: 'You are a senior software engineer analyzing a support issue. Provide thorough, actionable analysis.',
  temperature: 0.2,
  maxTokens: 4000,
};

export const IMAP_DRAFT_ANALYSIS_EMAIL_SYSTEM: PromptDefinition = {
  key: 'imap.draft-analysis-email.system',
  name: 'Analysis Email Drafter',
  description: 'Drafts the email that communicates deep analysis findings back to the requester.',
  taskType: 'DRAFT_EMAIL',
  role: 'SYSTEM',
  content:
    'You draft professional support emails. Output only the email body text. ' +
    'Always address the recipient by name and sign with the sender name provided.',
  temperature: 0.4,
  maxTokens: null,
};

export const IMAP_SUGGEST_NEXT_STEPS_SYSTEM: PromptDefinition = {
  key: 'imap.suggest-next-steps.system',
  name: 'Next Steps Suggester',
  description:
    'Generates a JSON array of recommended automated actions based on the analysis ' +
    '(set_status, set_priority, trigger_code_fix, etc.).',
  taskType: 'SUGGEST_NEXT_STEPS',
  role: 'SYSTEM',
  content: 'You are a support operations assistant. Respond with a JSON array of action objects only. No other text.',
  temperature: 0.2,
  maxTokens: null,
};

// ─── All IMAP prompts ───────────────────────────────────────────────────────

export const IMAP_PROMPTS: PromptDefinition[] = [
  IMAP_SUMMARIZE_SYSTEM,
  IMAP_CATEGORIZE_SYSTEM,
  IMAP_TRIAGE_SYSTEM,
  IMAP_DRAFT_RECEIPT_SYSTEM,
  IMAP_SUMMARIZE_TICKET_SYSTEM,
  IMAP_EXTRACT_FACTS_SYSTEM,
  IMAP_DEEP_ANALYSIS_SYSTEM,
  IMAP_DRAFT_ANALYSIS_EMAIL_SYSTEM,
  IMAP_SUGGEST_NEXT_STEPS_SYSTEM,
];
