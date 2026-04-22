/**
 * Returns true for transient API/network errors that are safe to retry.
 * Classifies Anthropic SDK HTTP 5xx errors, network-level codes, and
 * message-substring fallbacks for SDKs that don't expose structured status.
 * Recursively traverses err.cause up to MAX_CAUSE_DEPTH levels to handle
 * SDK error wrappers, without risking pathological recursion on cyclic causes.
 */
const MAX_CAUSE_DEPTH = 5;

export function isTransientApiError(err: unknown): boolean {
  return isTransientApiErrorInternal(err, 0);
}

function isTransientApiErrorInternal(err: unknown, depth: number): boolean {
  if (!err || typeof err !== 'object') return false;
  if (depth > MAX_CAUSE_DEPTH) return false;
  const e = err as { status?: number; statusCode?: number; code?: string; message?: string; cause?: unknown };

  // Anthropic SDK errors expose HTTP status on .status; generic HTTP on .statusCode.
  const status = typeof e.status === 'number' ? e.status
    : typeof e.statusCode === 'number' ? e.statusCode
    : undefined;
  if (status !== undefined) {
    return status >= 500 && status < 600;
  }

  // Network-level transient codes.
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return true;
  }

  // Traverse the cause chain with depth guard.
  if (e.cause && typeof e.cause === 'object') {
    return isTransientApiErrorInternal(e.cause, depth + 1);
  }

  // Message-substring fallback for SDKs that stringify errors without structured status.
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return /\b(5\d{2}|timeout|econnreset|etimedout)\b/.test(message);
}
