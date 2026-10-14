/**
 * MAX — retry with exponential backoff (zero dependencies).
 *
 *   await retryWithBackoff((attempt) => doThing(), {
 *     retries: 3,                       // extra attempts after the first
 *     baseMs: 500, factor: 2, maxMs: 4000,
 *     shouldRetry: (err, attempt) => err.retryable === true,
 *     onRetry: (err, attempt, waitMs) => log(...),
 *   });
 *
 * The final error is re-thrown with `err.attempts` set.
 */
export async function retryWithBackoff(fn, {
  retries = 3,
  baseMs = 500,
  factor = 2,
  maxMs = 4000,
  shouldRetry = () => true,
  onRetry,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt <= retries && shouldRetry(err, attempt);
      if (!canRetry) {
        if (err && typeof err === "object") err.attempts = attempt;
        throw err;
      }
      const wait = Math.min(maxMs, Math.round(baseMs * factor ** (attempt - 1)));
      try { onRetry?.(err, attempt, wait); } catch {}
      await sleep(wait);
    }
  }
}

/** HTTP statuses worth retrying for GitHub/GitLab writes. */
export const isRetryableStatus = (status) => status === 409 || status === 422 || status === 429 || status >= 500;
