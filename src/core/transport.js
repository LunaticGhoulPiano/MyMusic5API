import { setTimeout as sleep } from "node:timers/promises";
import { assertActive, cancelled, MyMusic5Error, upstream } from "./errors.js";

function retryAfterSeconds(value) {
    if (value === null) return undefined;
    if (/^\d+$/.test(value)) return Number(value);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

export function createTransport(options) {
    const request = options.fetch ?? globalThis.fetch;
    return async function requestJson(path, { body, signal, allowNotFound = false } = {}) {
        for (let attempt = 0; attempt <= options.retries; attempt++) {
            assertActive(signal);
            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
            timer.unref?.();
            const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
            let failure;
            let retryable = false;
            try {
                const response = await request(new URL(path, options.baseUrl), {
                    method: body === undefined ? "GET" : "POST",
                    headers: {
                        Accept: "application/json",
                        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                    signal: requestSignal,
                    redirect: "error",
                });
                if (!response.ok) {
                    const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
                    await response.body?.cancel();
                    if (allowNotFound && response.status === 404) {
                        throw new MyMusic5Error("SHEET_NOT_FOUND", "The public sheet was not found.", { status: 404 });
                    }
                    retryable = response.status === 429 || response.status >= 500;
                    failure = new MyMusic5Error(
                        response.status === 429 ? "UPSTREAM_RATE_LIMITED" : "UPSTREAM_HTTP_ERROR",
                        `MyMusic5 returned HTTP ${response.status}.`,
                        { status: response.status === 429 ? 503 : 502, retryAfter },
                    );
                }
                else {
                    try {
                        const data = await response.json();
                        assertActive(signal);
                        return data;
                    }
                    catch (error) {
                        if (signal?.aborted || timeout.signal.aborted) throw error;
                        throw upstream("MyMusic5 returned invalid JSON.");
                    }
                }
            }
            catch (error) {
                if (signal?.aborted) throw cancelled();
                if (error instanceof MyMusic5Error) throw error;
                retryable = true;
                failure = timeout.signal.aborted
                    ? new MyMusic5Error("UPSTREAM_TIMEOUT", "MyMusic5 did not respond in time.", { status: 504 })
                    : new MyMusic5Error("UPSTREAM_UNAVAILABLE", "Unable to reach MyMusic5.");
            }
            finally {
                clearTimeout(timer);
            }
            const delay = failure.retryAfter === undefined
                ? Math.min(options.retryDelayMs * 2 ** attempt, options.maxRetryDelayMs)
                : failure.retryAfter * 1_000;
            if (!retryable || attempt === options.retries || delay > options.maxRetryDelayMs) throw failure;
            try {
                await sleep(delay, undefined, { signal });
            }
            catch {
                throw cancelled();
            }
        }
    };
}
