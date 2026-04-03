import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const BASE_COMMANDS = new Set([
  'grep', 'find', 'cat', 'head', 'tail', 'wc', 'ls', 'tree', 'file', 'diff', 'stat',
]);

const PIPE_COMMANDS = new Set([
  'grep', 'sed', 'awk', 'sort', 'uniq', 'head', 'tail', 'wc', 'cut', 'tr',
]);

const BLOCKED_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'chmod', 'git', 'curl', 'wget', 'bash', 'sh', 'exec', 'node', 'python', 'perl', 'ruby',
]);

interface ParsedSegment {
  command: string;
  args: string[];
}

export interface ParsedCommand {
  base: string;
  args: string[];
  pipes: ParsedSegment[];
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  parsed?: ParsedCommand;
}

function splitSegment(segment: string): ParsedSegment {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ' ' && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);

  return {
    command: tokens[0] ?? '',
    args: tokens.slice(1),
  };
}

function isInsideQuotes(raw: string, index: number): boolean {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < index; i++) {
    if (raw[i] === "'" && !inDouble) inSingle = !inSingle;
    else if (raw[i] === '"' && !inSingle) inDouble = !inDouble;
  }
  return inSingle || inDouble;
}

function checkRedirectSafety(raw: string): string | null {
  // Find > or >> outside quotes, ensure target starts with ./tmp/
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '>' && !isInsideQuotes(raw, i)) {
      // Skip >> (treat as single redirect)
      let pos = i + 1;
      if (pos < raw.length && raw[pos] === '>') pos++;
      // Skip whitespace
      while (pos < raw.length && raw[pos] === ' ') pos++;
      // Get the target path
      let target = '';
      while (pos < raw.length && raw[pos] !== ' ' && raw[pos] !== '|') {
        target += raw[pos];
        pos++;
      }
      target = target.replace(/^["']|["']$/g, '');
      if (!target.startsWith('./tmp/')) {
        return `Redirect target "${target}" is not allowed. Only redirects to ./tmp/ are permitted.`;
      }
    }
  }
  return null;
}

export function validateCommand(command: string): ValidationResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { valid: false, error: 'Empty command' };
  }

  // Block shell expansion: $( or backtick or $((
  if (trimmed.includes('$(') || trimmed.includes('`') || trimmed.includes('$((')) {
    return { valid: false, error: 'Shell expansion ($(...), backticks, $((...))) is not allowed' };
  }

  // Block chaining operators outside quotes
  for (let i = 0; i < trimmed.length; i++) {
    if (isInsideQuotes(trimmed, i)) continue;

    if (trimmed[i] === '&' && i + 1 < trimmed.length && trimmed[i + 1] === '&') {
      return { valid: false, error: 'Command chaining (&&) is not allowed' };
    }
    if (trimmed[i] === '|' && i + 1 < trimmed.length && trimmed[i + 1] === '|') {
      return { valid: false, error: 'Command chaining (||) is not allowed' };
    }
    if (trimmed[i] === ';') {
      return { valid: false, error: 'Command chaining (;) is not allowed' };
    }
  }

  // Block dangerous commands anywhere in the raw string (as whole words)
  for (const blocked of BLOCKED_COMMANDS) {
    const regex = new RegExp(`(?:^|[\\s|/])${blocked}(?:\\s|$|\\|)`, 'i');
    if (regex.test(trimmed)) {
      return { valid: false, error: `Command "${blocked}" is not allowed` };
    }
  }

  // Check redirect safety
  const redirectError = checkRedirectSafety(trimmed);
  if (redirectError) {
    return { valid: false, error: redirectError };
  }

  // Split on | (outside quotes) into pipe segments
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === '|' && !inSingle && !inDouble) {
      segments.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) segments.push(current.trim());

  if (segments.length === 0) {
    return { valid: false, error: 'Empty command' };
  }

  // Parse and validate base command
  const baseParsed = splitSegment(segments[0]);
  if (!BASE_COMMANDS.has(baseParsed.command)) {
    return {
      valid: false,
      error: `Command "${baseParsed.command}" is not in the allowlist. Allowed: ${[...BASE_COMMANDS].join(', ')}`,
    };
  }

  // Parse and validate pipe commands
  const pipes: ParsedSegment[] = [];
  for (let i = 1; i < segments.length; i++) {
    const parsed = splitSegment(segments[i]);
    if (!PIPE_COMMANDS.has(parsed.command)) {
      return {
        valid: false,
        error: `Pipe command "${parsed.command}" is not in the allowlist. Allowed pipe commands: ${[...PIPE_COMMANDS].join(', ')}`,
      };
    }
    pipes.push(parsed);
  }

  return {
    valid: true,
    parsed: {
      base: baseParsed.command,
      args: baseParsed.args,
      pipes,
    },
  };
}

const MAX_STDOUT = 50_000;

export async function executeCommand(
  command: string,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const validation = validateCommand(command);
  if (!validation.valid) {
    return { stdout: '', stderr: validation.error!, exitCode: 1 };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });

    let truncatedStdout = stdout;
    if (stdout.length > MAX_STDOUT) {
      truncatedStdout = stdout.slice(0, MAX_STDOUT) + '\n\n[Output truncated — exceeded 50,000 characters]';
    }

    return { stdout: truncatedStdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; code?: number };
    let stdout = error.stdout ?? '';
    if (stdout.length > MAX_STDOUT) {
      stdout = stdout.slice(0, MAX_STDOUT) + '\n\n[Output truncated — exceeded 50,000 characters]';
    }
    return {
      stdout,
      stderr: error.stderr ?? String(err),
      exitCode: error.code ?? 1,
    };
  }
}
