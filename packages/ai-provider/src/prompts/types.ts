/**
 * A hardcoded prompt definition.
 *
 * These live in version-controlled files and define the structural/functional
 * core of each AI interaction. The control panel can attach `PromptOverride`
 * records (app-wide or per-client) that prepend/append additional text.
 */
export interface PromptDefinition {
  /** Unique key, e.g. "imap.triage.system". Used as the FK for overrides. */
  key: string;
  /** Human-readable name shown in the control panel. */
  name: string;
  /** What this prompt does — shown in the control panel. */
  description: string;
  /** Which AI task type this prompt is used with. */
  taskType: string;
  /** Whether this is a system prompt or a user prompt template. */
  role: 'SYSTEM' | 'USER';
  /** The base prompt text. May contain {{keyword}} placeholders (user prompts only). */
  content: string;
  /** Default temperature (null = use service default). */
  temperature: number | null;
  /** Default max tokens (null = use service default). */
  maxTokens: number | null;
}
