const BLOCKED_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE',
  'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY',
  'TRUNCATE', 'BULK', 'OPENROWSET', 'OPENQUERY',
  'RECONFIGURE', 'SHUTDOWN', 'BACKUP', 'RESTORE',
  'sp_configure', 'xp_cmdshell', 'xp_',
];

const BLOCKED_PATTERN = new RegExp(
  `\\b(${BLOCKED_KEYWORDS.join('|')})\\b`,
  'i',
);

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateQuery(query: string): ValidationResult {
  const trimmed = query.trim();

  if (!trimmed) {
    return { valid: false, reason: 'Empty query' };
  }

  const match = BLOCKED_PATTERN.exec(trimmed);
  if (match) {
    return {
      valid: false,
      reason: `Blocked keyword detected: ${match[1]}. Only SELECT/WITH (read-only) queries are allowed.`,
    };
  }

  return { valid: true };
}

export function wrapReadOnly(query: string): string {
  return [
    'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;',
    'SET NOCOUNT ON;',
    query,
  ].join('\n');
}
