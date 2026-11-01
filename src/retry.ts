import type { BackoffOptions, RetryContext, RetryOptions } from "./types.js";
import { assertAttempts, assertBackoff, assertFunction } from "./validate.js";

export interface RetryPolicy extends BackoffOptions {
  attempts: number;
  shouldRetry: (error: unknown, context: RetryContext) => boolean;
}

const retryUncertain = (_error: unknown, { uncertain }: RetryContext) => uncertain;

const NO_RETRY: RetryPolicy = { attempts: 1, shouldRetry: () => false };

export function resolveRetryPolicy(option: boolean | RetryOptions | undefined): RetryPolicy {
  if (!option) return NO_RETRY;
  const { attempts = 3, shouldRetry = retryUncertain, ...backoff } = option === true ? {} : option;
  assertAttempts(attempts);
  assertFunction("retry.shouldRetry", shouldRetry);
  assertBackoff(backoff);
  return { ...backoff, attempts, shouldRetry };
}

/** Delay to wait after the given 1-based attempt failed. */
export function backoffDelay(options: BackoffOptions, attempt: number): number {
  const { delay = 1000, maxDelay = 30_000, factor = 2, jitter = true } = options;
  const base = Math.min(maxDelay, delay * factor ** (attempt - 1));
  return jitter ? base / 2 + Math.random() * (base / 2) : base;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
