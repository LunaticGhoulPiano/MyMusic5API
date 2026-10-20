export const defaults = Object.freeze({
    baseUrl: "https://mms.pd.mapia.io/mms/",
    timeoutMs: 15_000,
    retries: 2,
    retryDelayMs: 250,
    maxRetryDelayMs: 30_000,
    concurrency: 4,
    pageSize: 20,
    maxPageSize: 100,
    maxPages: 1_000,
});
