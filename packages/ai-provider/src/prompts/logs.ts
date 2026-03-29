import type { PromptDefinition } from './types.js';

const ATTENTION_INSTRUCTIONS =
  'Also assess whether this summary requires operator attention. ' +
  'Classify the attention level as one of: NONE (routine, nothing noteworthy), ' +
  'LOW (minor oddities worth noting but not urgent), ' +
  'MEDIUM (errors, failures, or anomalies that should be investigated), ' +
  'HIGH (critical failures, repeated errors, data loss, or service outages requiring immediate action). ' +
  'Respond with ONLY a JSON object — no markdown fences, no extra text: ' +
  '{"summary": "<your narrative>", "attentionLevel": "<NONE|LOW|MEDIUM|HIGH>"}';

export const LOG_SUMMARIZE_TICKET_SYSTEM: PromptDefinition = {
  key: 'logs.summarize-ticket.system',
  name: 'Ticket Log Summarizer',
  description:
    'Summarizes application logs for a specific ticket into a narrative of what services handled it, ' +
    'what succeeded, what failed, and key decision points.',
  taskType: 'SUMMARIZE_LOGS',
  role: 'SYSTEM',
  content:
    'You summarize application logs for a support ticket. ' +
    'Describe the journey the ticket took through the system: which services handled it, ' +
    'what processing steps occurred, what succeeded, what failed, and any notable events. ' +
    'Write a concise narrative (3-8 sentences) that a human operator can scan quickly. ' +
    ATTENTION_INSTRUCTIONS,
  temperature: 0.3,
  maxTokens: null,
};

export const LOG_SUMMARIZE_ORPHAN_SYSTEM: PromptDefinition = {
  key: 'logs.summarize-orphan.system',
  name: 'Orphan Log Summarizer',
  description:
    'Summarizes logs from ticket-processing services that were never linked to a ticket — ' +
    'likely a failed or abandoned ticket creation attempt.',
  taskType: 'SUMMARIZE_LOGS',
  role: 'SYSTEM',
  content:
    'You summarize application logs from ticket-processing services (email processor, ticket analyzer, etc.) ' +
    'that were never associated with a ticket. These likely represent a failed or abandoned ticket creation attempt. ' +
    'Describe what happened: what triggered the processing, how far it got, what error or issue prevented ' +
    'the ticket from being created, and any actionable details. ' +
    'Write a concise narrative (2-6 sentences) that a human operator can scan quickly. ' +
    ATTENTION_INSTRUCTIONS,
  temperature: 0.3,
  maxTokens: null,
};

export const LOG_SUMMARIZE_SERVICE_SYSTEM: PromptDefinition = {
  key: 'logs.summarize-service.system',
  name: 'Service Log Summarizer',
  description:
    'Summarizes background service activity logs (health checks, polling, startup, API requests) ' +
    'grouped by 30-minute time window.',
  taskType: 'SUMMARIZE_LOGS',
  role: 'SYSTEM',
  content:
    'You summarize background service activity logs from a time window. These are infrastructure and ' +
    'operational logs — service startups, health checks, polling cycles, API requests, and similar activity. ' +
    'Describe what services were active, what operations ran, any errors or warnings, and anything noteworthy. ' +
    'Write a concise narrative (2-6 sentences) that a human operator can scan quickly. ' +
    ATTENTION_INSTRUCTIONS,
  temperature: 0.3,
  maxTokens: null,
};

export const LOG_SUMMARIZE_UNCATEGORIZED_SYSTEM: PromptDefinition = {
  key: 'logs.summarize-uncategorized.system',
  name: 'Uncategorized Log Summarizer',
  description:
    'Summarizes logs that did not fit into ticket, orphan, or service categories.',
  taskType: 'SUMMARIZE_LOGS',
  role: 'SYSTEM',
  content:
    'You summarize application logs that were not categorized as ticket-related, orphaned ticket attempts, ' +
    'or background service activity. Describe what happened: which services produced these logs, ' +
    'what operations ran, any errors or anomalies, and anything noteworthy. ' +
    'Write a concise narrative (2-6 sentences) that a human operator can scan quickly. ' +
    ATTENTION_INSTRUCTIONS,
  temperature: 0.3,
  maxTokens: null,
};

export const LOG_PROMPTS: PromptDefinition[] = [
  LOG_SUMMARIZE_TICKET_SYSTEM,
  LOG_SUMMARIZE_ORPHAN_SYSTEM,
  LOG_SUMMARIZE_SERVICE_SYSTEM,
  LOG_SUMMARIZE_UNCATEGORIZED_SYSTEM,
];
