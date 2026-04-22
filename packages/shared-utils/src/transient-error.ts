/**
 * Returns true for transient API/network errors that are safe to retry.
 * Classifies Anthropic SDK HTTP 5xx errors, network-level codes, and
 * message-substring fallbacks for SDKs that don't expose structured status.
 */
export function isTransientApiError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
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

  // Fallback: look at cause chain one level deep.
  if (e.cause && typeof e.cause === 'object') {
    return isTransientApiError(e.cause);
  }

  // Message-substring fallback for SDKs that stringify errors without structured status.
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return /\b(50[0-9]|timeout|econnreset|etimedout)\b/.test(message);
}
