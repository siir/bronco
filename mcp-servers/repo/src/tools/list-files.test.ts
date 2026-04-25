/**
 * Unit tests for list-files tool helpers.
 *
 * Tests the sanitizeDirectory helper and the find command construction.
 * Path-traversal rejection is the primary security concern.
 */

import { describe, expect, it } from 'vitest';
import { validateCommand } from '../command-validator.js';

// ---------------------------------------------------------------------------
// Mirror of sanitizeDirectory from list-files.ts (must match production logic)
// ---------------------------------------------------------------------------

function sanitizeDirectory(dir: string): string | null {
  if (!dir) return '.';
  if (dir.startsWith('/')) return null;
  const normalized = dir.replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  return normalized.replace(/^\.\//, '') || '.';
}

// ---------------------------------------------------------------------------
// Helper to build the find command as list-files.ts does
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildListCommand(dir: string, pattern: string, cap: number): string {
  const safeDir = sanitizeDirectory(dir) ?? '.';
  const safePattern =
    pattern && /^[A-Za-z0-9._*?\[\]/-]+$/.test(pattern) ? pattern : '*';
  const baseFind = `find ${shellQuote(safeDir)} -type f -name ${shellQuote(safePattern)}`;
  return `${baseFind} | head -n ${cap}`;
}

// ---------------------------------------------------------------------------
// sanitizeDirectory tests
// ---------------------------------------------------------------------------

describe('list-files: sanitizeDirectory', () => {
  it('returns "." for empty string', () => {
    expect(sanitizeDirectory('')).toBe('.');
  });

  it('returns "." for "."', () => {
    expect(sanitizeDirectory('.')).toBe('.');
  });

  it('strips leading ./', () => {
    expect(sanitizeDirectory('./src')).toBe('src');
  });

  it('accepts a valid relative directory', () => {
    expect(sanitizeDirectory('src/features')).toBe('src/features');
  });

  it('rejects absolute path', () => {
    expect(sanitizeDirectory('/etc')).toBeNull();
  });

  it('rejects .. traversal', () => {
    expect(sanitizeDirectory('../parent')).toBeNull();
  });

  it('rejects embedded .. in the middle', () => {
    expect(sanitizeDirectory('src/../../etc')).toBeNull();
  });

  it('rejects Windows backslash traversal', () => {
    expect(sanitizeDirectory('src\\..\\..\\etc')).toBeNull();
  });

  it('handles "." directory correctly (normalised to ".")', () => {
    const result = sanitizeDirectory('.');
    expect(result).toBe('.');
  });
});

// ---------------------------------------------------------------------------
// Pattern sanitization
// ---------------------------------------------------------------------------

describe('list-files: pattern sanitization', () => {
  it('accepts valid glob patterns', () => {
    const cmd = buildListCommand('.', '*.ts', 100);
    expect(cmd).toContain("*.ts");
    const result = validateCommand(cmd);
    expect(result.valid).toBe(true);
  });

  it('falls back to "*" for patterns with shell special chars', () => {
    const cmd = buildListCommand('.', '*.ts;rm -rf /', 100);
    // The pattern with ; should fall back to *
    expect(cmd).not.toContain('rm');
    const result = validateCommand(cmd);
    expect(result.valid).toBe(true);
  });

  it('falls back to "*" for empty pattern', () => {
    const cmd = buildListCommand('.', '', 100);
    // build uses * as fallback
    expect(cmd).toContain("'*'");
  });

  it('accepts patterns with brackets (glob)', () => {
    const cmd = buildListCommand('.', '[Ii]ndex.ts', 100);
    const result = validateCommand(cmd);
    expect(result.valid).toBe(true);
  });

  it('accepts patterns with hyphens', () => {
    const cmd = buildListCommand('.', 'my-component.*', 100);
    const result = validateCommand(cmd);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Find command construction with path traversal
// ---------------------------------------------------------------------------

describe('list-files: find command traversal safety', () => {
  it('rejects absolute directory in find command', () => {
    expect(sanitizeDirectory('/etc')).toBeNull();
    // When safeDir is null, the tool returns an error early before executing
  });

  it('rejects parent traversal in directory', () => {
    expect(sanitizeDirectory('../secret')).toBeNull();
  });

  it('produces a valid find | head pipeline', () => {
    const cmd = buildListCommand('src', '*.ts', 50);
    const result = validateCommand(cmd);
    expect(result.valid).toBe(true);
    expect(result.parsed?.base).toBe('find');
    expect(result.parsed?.pipes).toHaveLength(1);
    expect(result.parsed?.pipes[0].command).toBe('head');
  });

  it('produces a valid find | wc -l pipeline for counting', () => {
    const safeDir = sanitizeDirectory('src') ?? '.';
    const baseFind = `find ${shellQuote(safeDir)} -type f -name ${shellQuote('*.ts')}`;
    const countCmd = `${baseFind} | wc -l`;
    const result = validateCommand(countCmd);
    expect(result.valid).toBe(true);
    expect(result.parsed?.pipes[0].command).toBe('wc');
  });

  it('blocks -delete flag in find command', () => {
    const cmd = `find . -type f -name '*.ts' -delete`;
    const result = validateCommand(cmd);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('-delete');
  });

  it('blocks -exec flag in find command', () => {
    const cmd = `find . -type f -name '*.ts' -exec rm {} \\;`;
    const result = validateCommand(cmd);
    expect(result.valid).toBe(false);
  });
});
