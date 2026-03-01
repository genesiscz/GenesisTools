/**
 * @genesis-tools/utils
 *
 * Utility library for GenesisTools - storage, formatting, rate limiting, and more
 */

// Diff utilities
export {
    type DiffColorizer,
    type DiffLogger,
    type DiffOptions,
    DiffUtil,
    detectConflicts,
    showDiff,
} from "./core/diff";
// Formatting utilities
export {
    createProgressBar,
    debounce,
    deepMerge,
    estimateTokens,
    formatCost,
    formatDuration,
    formatFileSize,
    formatTokens,
    generateSessionId,
    generateTimestamp,
    getEnvVar,
    isObject,
    parseJSON,
    retry,
    sanitizeFilename,
    sanitizeOutput,
    throttle,
    truncateText,
    validateAPIKey,
    withTimeout,
} from "./core/formatting";
// Logger
export {
    createLogger,
    createNoopLogger,
    getLogLevel,
    type Logger,
    type LoggerOptions,
    type LogLevel,
    logger,
} from "./core/logger";
// Path utilities
export { normalizeFilePaths, resolvePathWithTilde, tildeifyPath } from "./core/path";
// Rate limiting
export {
    createRateLimitedCaller,
    isRateLimitError,
    type RateLimitError,
    type RateLimitLogger,
    type RetryOptions,
    withRetry,
} from "./core/rate-limit";
// Storage
export { fileExists, readFile, Storage, type StorageLogger, type TTLString, writeFile } from "./core/storage";
