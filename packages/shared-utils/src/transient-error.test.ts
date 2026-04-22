import { describe, it, expect } from 'vitest';
import { isTransientApiError } from './transient-error.js';

describe('isTransientApiError', () => {
  it('returns true for Anthropic-style { status: 500 }', () => {
    expect(isTransientApiError({ status: 500, message: 'Internal server error' })).toBe(true);
  });

  it('returns true for { status: 502 }', () => {
    expect(isTransientApiError({ status: 502 })).toBe(true);
  });

  it('returns true for { status: 503 }', () => {
    expect(isTransientApiError({ status: 503 })).toBe(true);
  });

  it('returns false for { status: 400 } (bad request — non-retryable)', () => {
    expect(isTransientApiError({ status: 400 })).toBe(false);
  });

  it('returns false for { status: 429 } (rate limit — handled separately)', () => {
    expect(isTransientApiError({ status: 429 })).toBe(false);
  });

  it('returns true for { code: "ECONNRESET" }', () => {
    expect(isTransientApiError({ code: 'ECONNRESET' })).toBe(true);
  });

  it('returns true for { code: "ETIMEDOUT" }', () => {
    expect(isTransientApiError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('returns true for { code: "ECONNREFUSED" }', () => {
    expect(isTransientApiError({ code: 'ECONNREFUSED' })).toBe(true);
  });

  it('returns false for a plain new Error("request failed")', () => {
    expect(isTransientApiError(new Error('request failed'))).toBe(false);
  });

  it('returns true for a plain Error with "500" in message', () => {
    expect(isTransientApiError(new Error('received 500 from upstream'))).toBe(true);
  });

  it('returns true for nested cause with status 500', () => {
    const outer = { message: 'wrapped', cause: { status: 500 } };
    expect(isTransientApiError(outer)).toBe(true);
  });

  it('returns false for nested cause with status 400', () => {
    const outer = { message: 'wrapped', cause: { status: 400 } };
    expect(isTransientApiError(outer)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isTransientApiError(null)).toBe(false);
  });

  it('returns false for a plain string', () => {
    expect(isTransientApiError('error')).toBe(false);
  });
});
