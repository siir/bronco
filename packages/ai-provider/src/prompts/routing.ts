import type { PromptDefinition } from './types.js';

export const ROUTING_SUMMARIZE_ROUTE_SYSTEM: PromptDefinition = {
  key: 'routing.summarize-route.system',
  name: 'Route Summarizer',
  description: 'Generates a short summary of a ticket processing route, describing what it does and what kinds of tickets it is suited for.',
  taskType: 'SUMMARIZE_ROUTE',
  role: 'SYSTEM',
  content:
    'You summarize ticket processing routes. Given a route name, description, and its ordered list of processing steps, ' +
    'write a concise 2-3 sentence summary explaining what this route does and what kinds of support tickets it is best suited for. ' +
    'Focus on the overall purpose and the types of issues it handles. Output only the summary, nothing else.',
  temperature: 0.3,
  maxTokens: 500,
};

export const ROUTING_SELECT_ROUTE_SYSTEM: PromptDefinition = {
  key: 'routing.select-route.system',
  name: 'Route Selector',
  description: 'Selects the best ticket processing route based on ticket context and available route summaries.',
  taskType: 'SELECT_ROUTE',
  role: 'SYSTEM',
  content:
    'You are a ticket routing assistant. Given the context of a support ticket (subject, description, category, priority, triage summary) ' +
    'and a list of available processing routes with their summaries, select the single best route to handle this ticket. ' +
    'Consider the ticket category, the nature of the issue, and the route descriptions when making your selection. ' +
    'Respond with ONLY the route ID (UUID) of the best matching route. If none of the routes are a good fit, respond with "NONE".',
  temperature: 0,
  maxTokens: 100,
};

export const ROUTING_PROMPTS: PromptDefinition[] = [
  ROUTING_SUMMARIZE_ROUTE_SYSTEM,
  ROUTING_SELECT_ROUTE_SYSTEM,
];
