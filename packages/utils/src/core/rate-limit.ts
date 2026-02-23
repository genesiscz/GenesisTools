// Rate limit handling with exponential backoff

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

/**
 * Optional logger interface for rate limiting
 */
export interface RateLimitLogger {
    warn: (msg: string) => void;
    error: (msg: string) => void;
}

const noopLogger: RateLimitLogger = {
    warn: () => {},
    error: () => {},
};

/**
 * Rate limit error structure
 */
export interface RateLimitError {
    status: number;
    headers?: {
        "x-ratelimit-remaining"?: string;
        "x-ratelimit-reset"?: string;
        "retry-after"?: string;
    };
}

/**
 * Check if error is a rate limit error
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
    if (!error || typeof error !== "object") {
        return false;
    }
    const err = error as Record<string, unknown>;
    return err.status === 403 || err.status === 429;
}

/**
 * Get delay from rate limit error headers
 */
function getDelayFromHeaders(error: RateLimitError): number | null {
    if (!error.headers) {
        return null;
    }

    // Check retry-after header (seconds)
    if (error.headers["retry-after"]) {
        return parseInt(error.headers["retry-after"], 10) * 1000;
    }

    // Check rate limit reset time
    if (error.headers["x-ratelimit-reset"]) {
        const resetTime = parseInt(error.headers["x-ratelimit-reset"], 10) * 1000;
        const now = Date.now();
        const delay = resetTime - now;
        if (delay > 0) {
            return Math.min(delay, 60000); // Cap at 60 seconds
        }
    }

    return null;
}

/**
 * Sleep for given milliseconds
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Options for withRetry function
 */
export interface RetryOptions {
    onRetry?: (attempt: number, delay: number) => void;
    maxRetries?: number;
    label?: string;
    logger?: RateLimitLogger;
    onRequest?: (label: string) => void;
    onResponse?: (label: string) => void;
}

/**
 * Execute function with retry on rate limit
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    const logger = options.logger ?? noopLogger;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt === 0 && options.label && options.onRequest) {
                options.onRequest(options.label);
            }
            const result = await fn();
            if (options.label && options.onResponse) {
                options.onResponse(options.label);
            }
            return result;
        } catch (error) {
            lastError = error;

            if (!isRateLimitError(error)) {
                throw error;
            }

            if (attempt === maxRetries) {
                logger.error(`Rate limit: Max retries (${maxRetries}) exceeded`);
                throw error;
            }

            // Calculate delay
            const headerDelay = getDelayFromHeaders(error);
            const exponentialDelay = INITIAL_DELAY_MS * 2 ** attempt;
            const delay = headerDelay ?? exponentialDelay;

            logger.warn(
                `Rate limited. Retrying in ${Math.round(delay / 1000)}s... (attempt ${attempt + 1}/${maxRetries})`
            );

            if (options.onRetry) {
                options.onRetry(attempt + 1, delay);
            }

            await sleep(delay);
        }
    }

    throw lastError;
}

/**
 * Create a rate-limited API caller
 */
export function createRateLimitedCaller(minDelayMs: number = 100) {
    let lastCallTime = 0;

    return async <T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> => {
        const now = Date.now();
        const timeSinceLastCall = now - lastCallTime;

        if (timeSinceLastCall < minDelayMs) {
            await sleep(minDelayMs - timeSinceLastCall);
        }

        lastCallTime = Date.now();
        return withRetry(fn, options);
    };
}
