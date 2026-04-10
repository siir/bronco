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
      reason: `Blocked keyword detected: ${match[1]}. The MCP database server only permits read-only SELECT and WITH (CTE) queries. Stored procedure calls (EXEC/EXECUTE), DML, DDL, permissions, backup/restore, and sp_configure/xp_* are blocked by the safety filter. Use a SELECT against the corresponding DMV, Extended Events ring buffer, or installed SELECT-able view instead. Do not retry this query unchanged.`,
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
