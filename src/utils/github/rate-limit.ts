// Rate limit handling with exponential backoff

import { logger } from "@app/logger";
import { verboseLog } from "@app/utils/github/utils";

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

interface RateLimitError {
    status: number;
    headers?: {
        "x-ratelimit-remaining"?: string;
        "x-ratelimit-reset"?: string;
        "retry-after"?: string;
    };
}

/**
 * Check if error is a rate limit / secondary-rate-limit error.
 *
 * GitHub uses 403 for BOTH rate limits and permission denials
 * ("Resource not accessible by personal access token"). Only treat 403 as
 * rate-limit when headers/message say so — otherwise callers retry forever
 * on permanent auth failures.
 */
export function isRateLimitError(error: unknown): error is RateLimitError {
    if (!error || typeof error !== "object") {
        return false;
    }
    const err = error as Record<string, unknown>;
    const status = err.status;

    if (status === 429) {
        return true;
    }

    if (status !== 403) {
        return false;
    }

    const headers = (err.headers ?? (err as { response?: { headers?: Record<string, string> } }).response?.headers) as
        | Record<string, string>
        | undefined;
    const remaining = headers?.["x-ratelimit-remaining"] ?? headers?.["X-RateLimit-Remaining"];
    if (remaining === "0") {
        return true;
    }

    const message = String(
        (err as { message?: string }).message ??
            (err as { response?: { data?: { message?: string } } }).response?.data?.message ??
            ""
    ).toLowerCase();

    if (message.includes("rate limit") || message.includes("secondary rate") || message.includes("abuse detection")) {
        return true;
    }

    // retry-after with 403 often means secondary rate limit
    if (headers?.["retry-after"] || headers?.["Retry-After"]) {
        return true;
    }

    return false;
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
 * Execute function with retry on rate limit
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    options: {
        onRetry?: (attempt: number, delay: number) => void;
        maxRetries?: number;
        label?: string;
    } = {}
): Promise<T> {
    const maxRetries = options.maxRetries ?? MAX_RETRIES;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            if (attempt === 0 && options.label) {
                verboseLog(`API Request: ${options.label}`);
            }
            const result = await fn();
            if (options.label) {
                verboseLog(`API Response: ${options.label} OK`);
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

    return async <T>(fn: () => Promise<T>): Promise<T> => {
        const now = Date.now();
        const timeSinceLastCall = now - lastCallTime;

        if (timeSinceLastCall < minDelayMs) {
            await sleep(minDelayMs - timeSinceLastCall);
        }

        lastCallTime = Date.now();
        return withRetry(fn);
    };
}
