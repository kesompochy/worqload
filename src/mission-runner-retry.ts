export { phaseLog } from "./spawn-executor";

export const MAX_TASK_RETRIES = 2;
export const RETRY_BASE_MS = 1000;

export function canRetry(
  context: Record<string, unknown>,
  maxRetries: number = MAX_TASK_RETRIES,
): boolean {
  const retryCount = (context.retryCount as number) || 0;
  return retryCount < maxRetries;
}

export interface RetryUpdate {
  retryCount: number;
  retryAfter: string;
}

export function computeRetryUpdate(
  context: Record<string, unknown>,
  baseMs: number = RETRY_BASE_MS,
): RetryUpdate {
  const retryCount = ((context.retryCount as number) || 0) + 1;
  const prevCount = retryCount - 1;
  const retryAfter = new Date(Date.now() + baseMs * Math.pow(2, prevCount)).toISOString();
  return { retryCount, retryAfter };
}
