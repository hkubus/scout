/**
 * Shared OpenRouter transport helpers: which provider failures are worth
 * retrying (transient upstream 5xx / rate limits / timeouts) and how long to
 * wait between attempts. 520 is OpenRouter's catch-all for an upstream
 * provider failure with no usable detail — almost always transient.
 */

const RETRYABLE_PROVIDER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 520, 524, 529]);

/** Maximum attempts per request (initial try + retries). */
export const PROVIDER_MAX_ATTEMPTS = 3;

export function isRetryableProviderStatus(status: number): boolean {
  return RETRYABLE_PROVIDER_STATUSES.has(status);
}

export function providerBackoffMs(attempt: number): number {
  return Math.min(2000, 500 * 2 ** attempt);
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** Network-level fetch failures and timeouts are transient by definition. */
export function isTransientFetchError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'TimeoutError' || error.name === 'AbortError';
  }
  return false;
}
