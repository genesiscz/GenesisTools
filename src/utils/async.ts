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
}

/**
 * Retry an async operation with configurable backoff.
 */
export function retry<T>(
    operation: () => Promise<T>,
    options?: RetryOptions | number,
): Promise<T> {
    // Support legacy (maxAttempts, delay) positional call style
    const opts: RetryOptions = typeof options === "number"
        ? { maxAttempts: options }
        : (options ?? {});

    const {
        maxAttempts = 3,
        delay = 1000,
        backoff = "exponential",
        shouldRetry,
        onRetry,
    } = opts;

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

                onRetry?.(attempt, nextDelay);
                setTimeout(tryOperation, nextDelay);
            }
        };

        tryOperation();
    });
}

// ============= Debounce =============

/**
 * Create a debounced version of a function that delays invocation
 * until after `wait` milliseconds have elapsed since the last call.
 */
export function debounce<T extends (...args: any[]) => void>(
    func: T,
    wait: number,
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return (...args: Parameters<T>) => {
        if (timeout !== undefined) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

// ============= Throttle =============

/**
 * Create a throttled version of a function that only invokes
 * once per `limit` milliseconds.
 */
export function throttle<T extends (...args: any[]) => void>(
    func: T,
    limit: number,
): (...args: Parameters<T>) => void {
    let inThrottle = false;
    return (...args: Parameters<T>) => {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            setTimeout(() => (inThrottle = false), limit);
        }
    };
}

// ============= Timeout =============

/**
 * Race a promise against a timeout. Rejects with `timeoutError` (or a default error)
 * if the promise doesn't resolve within `timeoutMs`.
 */
export function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutError?: Error,
): Promise<T> {
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
