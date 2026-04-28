import { describe, it, expect } from 'vitest';
import { stripNulBytes } from './scrub.js';

describe('stripNulBytes', () => {
  it('returns unchanged when no NUL bytes are present', () => {
    expect(stripNulBytes('hello world')).toBe('hello world');
  });

  it('returns the same reference (no allocation) when no NUL bytes are present', () => {
    const input = 'hello world';
    expect(stripNulBytes(input)).toBe(input);
  });

  it('strips a single NUL byte', () => {
    expect(stripNulBytes('hello\x00world')).toBe('helloworld');
  });

  it('strips multiple NUL bytes', () => {
    expect(stripNulBytes('\x00a\x00b\x00c\x00')).toBe('abc');
  });

  it('returns null pass-through', () => {
    expect(stripNulBytes(null)).toBeNull();
  });

  it('returns undefined pass-through', () => {
    expect(stripNulBytes(undefined)).toBeUndefined();
  });

  it('returns empty string for empty string', () => {
    expect(stripNulBytes('')).toBe('');
  });

  it('preserves Unicode characters that are not NUL', () => {
    expect(stripNulBytes('café\x00résumé')).toBe('caférésumé');
  });

  it('handles all-NUL input', () => {
    expect(stripNulBytes('\x00\x00\x00')).toBe('');
  });

  it('handles a NUL embedded in a long realistic string (UTF-16 LE artifact)', () => {
    // Simulate the failure mode: a 1-char-per-2-bytes UTF-16 LE source string
    // surviving a naive UTF-8 read — every other byte is 0x00.
    const input = 's\x00e\x00l\x00e\x00c\x00t\x00 \x00*\x00';
    expect(stripNulBytes(input)).toBe('select *');
  });
});
