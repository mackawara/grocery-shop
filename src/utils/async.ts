/** Resolve after `ms` milliseconds. Handy for backoff/retry delays. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
