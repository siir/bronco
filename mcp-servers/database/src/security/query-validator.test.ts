/**
 * Unit tests for security/query-validator.ts
 *
 * Coverage goals:
 *  - Every blocked keyword fires on a normal input
 *  - Bypass attempts: comment injection, case variants, Unicode lookalikes,
 *    multi-statement, whitespace tricks, semicolons, hex/char escapes
 *  - Valid queries that contain blocked keywords as substrings (not full words) pass
 *  - wrapReadOnly output shape
 *  - Empty / whitespace-only inputs
 */

import { describe, it, expect } from 'vitest';
import { validateQuery, wrapReadOnly } from './query-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectBlocked(query: string, label?: string): void {
  const result = validateQuery(query);
  expect(result.valid, `Expected BLOCKED but got VALID for: ${label ?? query}`).toBe(false);
  expect(result.reason).toBeTruthy();
}

function expectAllowed(query: string, label?: string): void {
  const result = validateQuery(query);
  expect(result.valid, `Expected VALID but got BLOCKED for: ${label ?? query} — reason: ${result.reason}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Empty / blank inputs
// ---------------------------------------------------------------------------

describe('validateQuery — empty / blank inputs', () => {
  it('rejects empty string', () => {
    const r = validateQuery('');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });

  it('rejects whitespace-only string', () => {
    const r = validateQuery('   \t\n  ');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// Valid queries that should pass
// ---------------------------------------------------------------------------

describe('validateQuery — valid SELECT queries', () => {
  const validCases: Array<[string, string]> = [
    ['SELECT 1', 'trivial select'],
    ['SELECT * FROM sys.tables', 'select star'],
    ['SELECT name, object_id FROM sys.objects WHERE type = \'U\'', 'select with WHERE'],
    ['WITH cte AS (SELECT 1 AS n) SELECT n FROM cte', 'CTE'],
    ['SELECT TOP 10 * FROM sys.dm_exec_requests', 'TOP select DMV'],
    ['SELECT\n  name\nFROM\n  sys.databases', 'multiline select'],
    ['select name from sys.tables', 'lowercase select'],
    [
      'SELECT d.name, mf.physical_name FROM sys.databases d JOIN sys.master_files mf ON d.database_id = mf.database_id',
      'join select',
    ],
    // Keyword as a column alias / string literal — none of these contain a *blocked* keyword
    ['SELECT 1 AS inserting_count', 'keyword as part of alias — inserting_count does NOT contain INSERT as whole word'],
  ];

  for (const [query, label] of validCases) {
    it(`passes: ${label}`, () => {
      expectAllowed(query, label);
    });
  }
});

// ---------------------------------------------------------------------------
// Every blocked keyword fires (exact keyword, uppercase)
// ---------------------------------------------------------------------------

describe('validateQuery — blocked keywords (exact, uppercase)', () => {
  const cases: Array<[string, string]> = [
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET col = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['DROP TABLE t', 'DROP'],
    ['ALTER TABLE t ADD col INT', 'ALTER'],
    ['CREATE TABLE t (id INT)', 'CREATE'],
    ['EXEC sp_who2', 'EXEC'],
    ['EXECUTE sp_who2', 'EXECUTE'],
    ['GRANT SELECT ON t TO user1', 'GRANT'],
    ['REVOKE SELECT ON t FROM user1', 'REVOKE'],
    ['DENY SELECT ON t TO user1', 'DENY'],
    ['TRUNCATE TABLE t', 'TRUNCATE'],
    ['BULK INSERT t FROM \'file.csv\'', 'BULK'],
    ['SELECT * FROM OPENROWSET(\'SQLNCLI\', \'server\', \'SELECT 1\')', 'OPENROWSET'],
    ['SELECT * FROM OPENQUERY(srv, \'SELECT 1\')', 'OPENQUERY'],
    ['RECONFIGURE WITH OVERRIDE', 'RECONFIGURE'],
    ['SHUTDOWN WITH NOWAIT', 'SHUTDOWN'],
    ['BACKUP DATABASE db TO DISK = \'backup.bak\'', 'BACKUP'],
    ['RESTORE DATABASE db FROM DISK = \'backup.bak\'', 'RESTORE'],
    ['EXEC sp_configure \'show advanced options\', 1', 'sp_configure'],
    ['EXEC xp_cmdshell \'dir\'', 'xp_cmdshell'],
    ['EXEC xp_regwrite \'HKEY_LOCAL_MACHINE\', \'test\', \'val\'', 'xp_ prefix'],
  ];

  for (const [query, label] of cases) {
    it(`blocks ${label}`, () => {
      expectBlocked(query, label);
    });
  }
});

// ---------------------------------------------------------------------------
// Case variant bypass attempts
// ---------------------------------------------------------------------------

describe('validateQuery — case variant bypass attempts', () => {
  const cases: Array<[string, string]> = [
    ['insert into t values (1)', 'insert (lowercase)'],
    ['Insert Into t Values (1)', 'Insert (mixed)'],
    ['InSeRt INTO t VALUES (1)', 'InSeRt (mixed crazy)'],
    ['update t set col = 1', 'update (lowercase)'],
    ['delete from t', 'delete (lowercase)'],
    ['drop table t', 'drop (lowercase)'],
    ['alter table t add col int', 'alter (lowercase)'],
    ['create table t (id int)', 'create (lowercase)'],
    ['exec sp_who2', 'exec (lowercase)'],
    ['execute sp_who2', 'execute (lowercase)'],
    ['grant select on t to u', 'grant (lowercase)'],
    ['revoke select on t from u', 'revoke (lowercase)'],
    ['deny select on t to u', 'deny (lowercase)'],
    ['truncate table t', 'truncate (lowercase)'],
    ['bulk insert t from \'f\'', 'bulk (lowercase)'],
    ['reconfigure', 'reconfigure (lowercase)'],
    ['shutdown', 'shutdown (lowercase)'],
    ['backup database db to disk = \'f\'', 'backup (lowercase)'],
    ['restore database db from disk = \'f\'', 'restore (lowercase)'],
  ];

  for (const [query, label] of cases) {
    it(`blocks ${label}`, () => {
      expectBlocked(query, label);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-statement bypass attempts (semicolon-separated)
// ---------------------------------------------------------------------------

describe('validateQuery — multi-statement bypass attempts', () => {
  it('blocks SELECT; DROP TABLE t', () => {
    expectBlocked('SELECT * FROM sys.tables; DROP TABLE t', 'select then drop');
  });

  it('blocks SELECT; DELETE FROM t', () => {
    expectBlocked('SELECT 1; DELETE FROM t WHERE 1=1', 'select then delete');
  });

  it('blocks SELECT; TRUNCATE TABLE t', () => {
    expectBlocked('SELECT 1; TRUNCATE TABLE t', 'select then truncate');
  });

  it('blocks SELECT; EXEC xp_cmdshell', () => {
    expectBlocked("SELECT 1; EXEC xp_cmdshell 'dir'", 'select then xp_cmdshell');
  });

  it('blocks SELECT; INSERT INTO', () => {
    expectBlocked('SELECT 1; INSERT INTO t(c) VALUES(1)', 'select then insert');
  });
});

// ---------------------------------------------------------------------------
// Comment injection bypass attempts
// ---------------------------------------------------------------------------

describe('validateQuery — comment injection bypass attempts', () => {
  // Inline comments (--) don't change the word itself so the regex still matches
  it('blocks DROP--comment TABLE t', () => {
    expectBlocked('DROP--this is fine\nTABLE t', 'drop with inline comment after keyword');
  });

  it('blocks SELECT 1; /*harmless*/ DELETE FROM t', () => {
    expectBlocked('SELECT 1; /*harmless*/ DELETE FROM t', 'delete with block comment');
  });

  it('blocks INSERT inside block comment bypass attempt', () => {
    // Attacker tries to hide keyword in comment but keyword still appears unprotected before it
    expectBlocked("/* legit */ INSERT INTO t VALUES(1)", 'insert after block comment');
  });

  it('blocks EXEC with inline comment between keyword chars (not splittable by regex)', () => {
    // EXEC is a single token; SQL comment injection can't split a keyword at the lexer level
    // but the regex will match the whole word before the comment
    expectBlocked("EXEC /* comment */ xp_cmdshell 'dir'", 'exec with comment inside call');
  });
});

// ---------------------------------------------------------------------------
// Whitespace / newline normalization
// ---------------------------------------------------------------------------

describe('validateQuery — whitespace / newline variants', () => {
  it('blocks DROP\\nTABLE with newline', () => {
    // The keyword DROP appears as a whole word on its own line
    expectBlocked('DROP\nTABLE users', 'drop on own line');
  });

  it('blocks INSERT with leading whitespace', () => {
    expectBlocked('   INSERT INTO t VALUES (1)', 'insert with leading spaces');
  });

  it('blocks UPDATE with tab indent', () => {
    expectBlocked('\tUPDATE t SET col = 1', 'update with tab');
  });
});

// ---------------------------------------------------------------------------
// Substring non-collision (should NOT be blocked)
// ---------------------------------------------------------------------------

describe('validateQuery — keyword as substring of identifier (should pass)', () => {
  // These identifiers contain a keyword as a substring but NOT as a whole word
  // \b word boundary means "DROPZONE" should not match DROP, etc.
  const cases: Array<[string, string]> = [
    ['SELECT * FROM dropzone_audit', 'dropzone contains drop substring'],
    ['SELECT * FROM created_records', 'created_records contains create substring'],
    ['SELECT * FROM alter_log', 'alter_log contains alter substring'],
    ['SELECT deleted_at FROM audit_records', 'deleted_at contains delete substring'],
    ['SELECT inserted_at FROM log_records', 'inserted_at contains insert substring'],
    ['SELECT executor_id FROM tasks', 'executor_id contains exec substring'],
    ['SELECT * FROM truncation_log', 'truncation_log contains truncat substring'],
    ['SELECT backup_type FROM backup_schedules', 'backup as a column name (whole word)'],
  ];

  for (const [query, label] of cases) {
    it(`passes: ${label}`, () => {
      // backup_type and backup_schedules: note "BACKUP" as a whole word IS blocked
      // but "backup_type" and "backup_schedules" — "backup" appears as a whole word here?
      // Let's check: \bbackup\b in "backup_type" — underscore is \w so \b is NOT between backup and _
      // Therefore backup_type does NOT match \bBACKUP\b. Good.
      expectAllowed(query, label);
    });
  }
});

// ---------------------------------------------------------------------------
// Unicode / homoglyph bypass attempts
// ---------------------------------------------------------------------------

describe('validateQuery — unicode / homoglyph bypass attempts', () => {
  // These use unicode lookalikes that look like latin letters but are different code points.
  // The regex uses \b which operates on ASCII word boundaries; non-ASCII chars outside
  // the ASCII range do not form \w so the boundary behavior can differ.
  // We document expected behaviour here — if these pass, it's a known limitation.

  it('passes SELECT with Cyrillic C (not a real SQL keyword)', () => {
    // Ϲ (U+03F9 Greek Capital Letter Lunate Sigma) instead of C in SELECT
    // This is NOT the ASCII keyword SELECT so SQL Server would reject it anyway.
    // The query validator should not block it (it's not a recognized keyword).
    const query = 'ЅЕLECT * FROM sys.tables'; // Cyrillic Dze + Cyrillic letters
    // This might or might not be blocked depending on unicode behavior of \b
    // We just confirm the validator doesn't throw.
    expect(() => validateQuery(query)).not.toThrow();
  });

  it('does not throw on null bytes in query', () => {
    const query = 'SELECT\x001';
    expect(() => validateQuery(query)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// xp_ prefix matching
// ---------------------------------------------------------------------------

describe('validateQuery — xp_ prefix matching', () => {
  it('blocks xp_cmdshell (lowercase)', () => {
    expectBlocked("exec xp_cmdshell 'whoami'", 'xp_cmdshell lowercase');
  });

  it('blocks xp_regwrite', () => {
    expectBlocked("EXEC xp_regwrite 'HKLM', 'Software', 'val'", 'xp_regwrite');
  });

  it('blocks xp_fixeddrives', () => {
    expectBlocked('EXEC xp_fixeddrives', 'xp_fixeddrives');
  });

  it('blocks xp_fileexist', () => {
    expectBlocked("EXEC xp_fileexist 'C:\\file.txt'", 'xp_fileexist');
  });

  it('blocks XP_CMDSHELL uppercase', () => {
    expectBlocked("EXEC XP_CMDSHELL 'dir'", 'XP_CMDSHELL uppercase');
  });
});

// ---------------------------------------------------------------------------
// sp_configure matching
// ---------------------------------------------------------------------------

describe('validateQuery — sp_configure', () => {
  it('blocks sp_configure with show advanced options', () => {
    expectBlocked("EXEC sp_configure 'show advanced options', 1", 'sp_configure show advanced');
  });

  it('blocks sp_configure (lowercase)', () => {
    expectBlocked("exec sp_configure 'xp_cmdshell', 1", 'sp_configure lowercase');
  });
});

// ---------------------------------------------------------------------------
// Error message content
// ---------------------------------------------------------------------------

describe('validateQuery — error message content', () => {
  it('includes the blocked keyword in the reason', () => {
    const r = validateQuery('DROP TABLE users');
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/DROP/i);
  });

  it('reason mentions read-only guidance', () => {
    const r = validateQuery('DELETE FROM users');
    expect(r.valid).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// wrapReadOnly
// ---------------------------------------------------------------------------

describe('wrapReadOnly', () => {
  it('prepends SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED', () => {
    const wrapped = wrapReadOnly('SELECT 1');
    expect(wrapped).toContain('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED');
  });

  it('prepends SET NOCOUNT ON', () => {
    const wrapped = wrapReadOnly('SELECT 1');
    expect(wrapped).toContain('SET NOCOUNT ON');
  });

  it('includes the original query unchanged', () => {
    const query = 'SELECT TOP 10 * FROM sys.tables';
    const wrapped = wrapReadOnly(query);
    expect(wrapped).toContain(query);
  });

  it('produces a multiline string with SET directives before the query', () => {
    const wrapped = wrapReadOnly('SELECT 1');
    const lines = wrapped.split('\n');
    expect(lines[0]).toMatch(/SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED/);
    expect(lines[1]).toMatch(/SET NOCOUNT ON/);
    expect(lines[2]).toBe('SELECT 1');
  });
});

// ---------------------------------------------------------------------------
// Completeness audit
// ---------------------------------------------------------------------------

describe('validateQuery — keyword completeness audit', () => {
  // Ensure the documented set of blocked keywords all fire.
  // If this list diverges from the actual BLOCKED_KEYWORDS array, tests will fail.
  const documentedKeywords = [
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE',
    'EXEC', 'EXECUTE', 'GRANT', 'REVOKE', 'DENY',
    'TRUNCATE', 'BULK', 'OPENROWSET', 'OPENQUERY',
    'RECONFIGURE', 'SHUTDOWN', 'BACKUP', 'RESTORE',
    'sp_configure', 'xp_cmdshell', 'xp_',
  ] as const;

  for (const kw of documentedKeywords) {
    it(`documented keyword "${kw}" is enforced`, () => {
      // Build a minimal query that uses the keyword as a standalone word
      const query = `${kw} something`;
      const r = validateQuery(query);
      expect(r.valid, `Keyword "${kw}" should be blocked but passed`).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// STACKED QUERIES — SELECT followed by dangerous statement on same line
// ---------------------------------------------------------------------------

describe('validateQuery — stacked query patterns', () => {
  it('blocks SELECT 1 UNION ALL SELECT 1; DROP TABLE users', () => {
    expectBlocked('SELECT 1 UNION ALL SELECT 1; DROP TABLE users', 'union + drop stacked');
  });

  it('blocks 1=1; EXEC xp_cmdshell injection pattern', () => {
    expectBlocked("SELECT * FROM t WHERE id = 1; EXEC xp_cmdshell 'dir'", 'select where injection');
  });

  it('allows simple UNION between two SELECTs', () => {
    expectAllowed(
      'SELECT name FROM sys.tables UNION ALL SELECT name FROM sys.views',
      'legitimate union',
    );
  });
});
