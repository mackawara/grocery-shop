// Tunables for syncing products to the Meta (Facebook) catalog via items_batch.

// Meta's items_batch accepts up to 5,000 items per call; kept conservative to
// bound payload size and the blast radius of a single failed chunk. Bump if needed.
export const CATALOG_BATCH_LIMIT = 100;

// Transient-error (429 / 5xx) retry policy with exponential backoff.
export const CATALOG_SYNC_MAX_RETRIES = 3;
export const CATALOG_SYNC_RETRY_BASE_MS = 500;
