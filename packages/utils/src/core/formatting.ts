import { randomBytes } from "node:crypto";

// ============================================
// Session & Token Management
// ============================================

/**
 * Generate a unique session ID with timestamp and random hex
 */
export function generateSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").split("Z")[0];
    const random = randomBytes(3).toString("hex");
    return `${timestamp}_${random}`;
}

/**
 * Estimate token count from text (rough ~4 chars per token)
 */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/**
 * Format token count with K/M suffixes
 */
export function formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
        return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}K`;
    }
    return tokens.toString();
}

/**
 * Format cost as currency
 */
export function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) {
        return `${ms}ms`;
    }

    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

/**
 * Format file size in human-readable format
 */
export function formatFileSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
}

// ============================================
// Text Processing
// ============================================

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number = 100): string {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.substring(0, maxLength - 3)}...`;
}

/**
 * Sanitize output by removing ANSI codes and control characters
 */
export function sanitizeOutput(text: string, removeANSI: boolean = false): string {
    let sanitized = text;

    if (removeANSI) {
        // Remove ANSI escape codes
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes use control chars
        sanitized = sanitized.replace(/\x1b\[[0-9;]*m/g, "");
    }

    // Remove other potentially problematic characters
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars
    sanitized = sanitized.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");

    return sanitized;
}

/**
 * Safe JSON parsing with fallback
 */
export function parseJSON<T>(text: string, fallback?: T): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        if (fallback !== undefined) {
            return fallback;
        }
        return null;
    }
}

// ============================================
// UI/Progress
// ============================================

/**
 * Create an ASCII progress bar
 */
export function createProgressBar(current: number, total: number, width: number = 40): string {
    const percentage = Math.min(1, Math.max(0, current / total));
    const filled = Math.round(width * percentage);
    const empty = width - filled;

    const filledBar = "█".repeat(filled);
    const emptyBar = "░".repeat(empty);
    const percentageText = `${Math.round(percentage * 100)}%`;

    return `[${filledBar}${emptyBar}] ${percentageText}`;
}

// ============================================
// Validation
// ============================================

/**
 * Basic API key validation by provider
 */
export function validateAPIKey(key: string, provider: string): boolean {
    const minLengths: Record<string, number> = {
        openai: 20,
        anthropic: 20,
        google: 20,
        groq: 20,
        openrouter: 20,
        xai: 20,
        jinaai: 20,
    };

    const minLength = minLengths[provider] || 20;

    if (key.length < minLength) {
        return false;
    }

    // Check for common patterns that indicate invalid keys
    const invalidPatterns = [/^your_api_key_here$/i, /^sk-test-/i, /^placeholder$/i, /^xxx+/i];

    if (invalidPatterns.some((pattern) => pattern.test(key))) {
        return false;
    }

    return true;
}

/**
 * Sanitize filename by removing invalid characters
 */
export function sanitizeFilename(filename: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching invalid filename chars
    return filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

// ============================================
// Functional Utilities
// ============================================

/**
 * Debounce function calls
 */
export function debounce<T extends (...args: unknown[]) => void>(
    func: T,
    wait: number
): (...args: Parameters<T>) => void {
    let timeout: ReturnType<typeof setTimeout>;

    return (...args: Parameters<T>) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

/**
 * Throttle function calls
 */
export function throttle<T extends (...args: unknown[]) => void>(
    func: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle: boolean;

    return (...args: Parameters<T>) => {
        if (!inThrottle) {
            func(...args);
            inThrottle = true;
            // biome-ignore lint/suspicious/noAssignInExpressions: standard throttle pattern
            setTimeout(() => (inThrottle = false), limit);
        }
    };
}

/**
 * Retry with exponential backoff
 */
export function retry<T>(operation: () => Promise<T>, maxAttempts: number = 3, delay: number = 1000): Promise<T> {
    return new Promise((resolve, reject) => {
        let attempt = 0;

        const tryOperation = async () => {
            try {
                const result = await operation();
                resolve(result);
            } catch (error) {
                attempt++;
                if (attempt >= maxAttempts) {
                    reject(error);
                } else {
                    setTimeout(tryOperation, delay * 2 ** (attempt - 1));
                }
            }
        };

        tryOperation();
    });
}

/**
 * Add timeout to a promise
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError?: Error): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
            reject(timeoutError || new Error(`Operation timed out after ${timeoutMs}ms`));
        }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
}

// ============================================
// Object Utilities
// ============================================

/**
 * Type guard for objects
 */
export function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Deep merge two objects
 */
export function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
    const result = { ...target };

    for (const key in source) {
        if (source[key] && isObject(source[key]) && isObject(result[key])) {
            result[key] = deepMerge(
                result[key] as Record<string, unknown>,
                source[key] as Record<string, unknown>
            ) as T[Extract<keyof T, string>];
        } else if (source[key] !== undefined) {
            result[key] = source[key] as T[Extract<keyof T, string>];
        }
    }

    return result;
}

// ============================================
// Environment
// ============================================

/**
 * Safe environment variable access
 */
export function getEnvVar(name: string, required: boolean = false): string | undefined {
    const value = process.env[name];

    if (required && !value) {
        throw new Error(`Required environment variable ${name} is not set`);
    }

    return value;
}

/**
 * Generate a safe timestamp for filenames
 */
export function generateTimestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}
