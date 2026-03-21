/**
 * Shared async utilities for CLI tools.
 * Consolidates retry, debounce, throttle, and withTimeout.
 */

// ============= Retry =============

interface RetryOptions {
    /** Maximum number of attempts. Default: 3 */
    maxAttempts?: number;
    /** Initial delay between retries in ms. Default: 1000 */
    delay?: number;
    /** Backoff strategy. Default: "exponential" */
    backoff?: "exponential" | "linear" | "fixed";
    /** Optional predicate to decide whether to retry on a given error. Default: always retry */
    shouldRetry?: (error: unknown) => boolean;
    /** Optional callback invoked before each retry */
    onRetry?: (attempt: number, delay: number) => void;
    /**
     * Optional: compute custom delay for a given attempt and error.
     * Overrides `delay` + `backoff` when provided.
     * Useful for rate-limit-aware backoff.
     */
    getDelay?: (attempt: number, error: unknown) => number;
}

/**
 * Retry an async operation with configurable backoff.
 */
export function retry<T>(operation: () => Promise<T>, options?: RetryOptions | number): Promise<T> {
    // Support legacy (maxAttempts, delay) positional call style
    const opts: RetryOptions = typeof options === "number" ? { maxAttempts: options } : (options ?? {});

    const { maxAttempts = 3, delay = 1000, backoff = "exponential", shouldRetry, onRetry } = opts;

    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryOperation = async () => {
            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                attempt++;
                if (attempt >= maxAttempts || (shouldRetry && !shouldRetry(error))) {
                    reject(error);
                    return;
                }

                let nextDelay: number;

                if (opts.getDelay) {
                    nextDelay = opts.getDelay(attempt, error);
                } else {
                    switch (backoff) {
                        case "linear":
                            nextDelay = delay * attempt;
                            break;
                        case "fixed":
                            nextDelay = delay;
                            break;
                        default: // exponential
                            nextDelay = delay * 2 ** (attempt - 1);
                    }
                }

                onRetry?.(attempt, nextDelay);
                setTimeout(tryOperation, nextDelay);
            }
        };

        tryOperation();
    });
}

/**
 * Create a getDelay function that uses longer delays for rate-limit errors.
 * Detects 429, "rate", "RESOURCE_EXHAUSTED", and "quota" in error messages.
 */
export function rateLimitAwareDelay(opts?: {
    baseDelay?: number;
    rateLimitMinDelay?: number;
}): (attempt: number, error: unknown) => number {
    const baseDelay = opts?.baseDelay ?? 500;
    const rateLimitMinDelay = opts?.rateLimitMinDelay ?? 15_000;

    return (attempt: number, error: unknown): number => {
        const msg = error instanceof Error ? error.message : String(error);
        const isRateLimit =
            msg.includes("429") || msg.includes("rate") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota");

        const exponentialDelay = baseDelay * 2 ** (attempt - 1);

        if (isRateLimit) {
            return Math.max(exponentialDelay, rateLimitMinDelay);
        }

        return exponentialDelay;
    };
}

// ============= Debounce =============

/**
 * Create a debounced version of a function that delays invocation
 * until after `wait` milliseconds have elapsed since the last call.
 */
export function debounce<T extends (...args: never[]) => void>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return (...args: Parameters<T>) => {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
        timeout = setTimeout(() => func(...args), wait);
    };
}

// ============= Throttle =============

/**
 * Create a throttled version of a function that only invokes
 * once per `limit` milliseconds.
 */
export function throttle<T extends (...args: never[]) => void>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle = false;
    return (...args: Parameters<T>) => {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => {
                inThrottle = false;
            }, limit);
        }
    };
}

// ============= Timeout =============

/**
 * Race a promise against a timeout. Rejects with `timeoutError` (or a default error)
 * if the promise doesn't resolve within `timeoutMs`.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError?: Error): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(timeoutError || new Error(`Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
    });
}

// ============= Concurrent Map =============

interface ConcurrentMapOptions<T, R> {
    /** Items to process */
    items: T[];
    /** Async function to apply to each item */
    fn: (item: T) => Promise<R>;
    /** Max concurrent operations. Default: 5 */
    concurrency?: number;
    /** Called for each rejected item. If omitted, failures are silently skipped. */
    onError?: (item: T, error: unknown) => void;
}

/**
 * Map over items with bounded concurrency using Promise.allSettled.
 * Failed items are skipped (logged via onError) — a single failure doesn't abort the batch.
 */
export async function concurrentMap<T, R>({
    items,
    fn,
    concurrency = 5,
    onError,
}: ConcurrentMapOptions<T, R>): Promise<Map<T, R>> {
    if (concurrency < 1) {
        throw new Error(`concurrentMap: concurrency must be >= 1, got ${concurrency}`);
    }
    const result = new Map<T, R>();

    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const settled = await Promise.allSettled(batch.map(fn));

        settled.forEach((entry, index) => {
            if (entry.status === "fulfilled") {
                result.set(batch[index], entry.value);
            } else {
                onError?.(batch[index], entry.reason);
            }
        });
    }

    return result;
}
