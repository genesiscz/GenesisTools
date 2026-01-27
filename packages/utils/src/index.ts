/**
 * @genesis-tools/utils
 *
 * Utility library for GenesisTools - storage, formatting, rate limiting, and more
 */

// Storage
export { Storage, type TTLString, type StorageLogger } from './core/storage';
export { readFile, writeFile, fileExists } from './core/storage';

// Path utilities
export { tildeifyPath, resolvePathWithTilde, normalizeFilePaths } from './core/path';

// Formatting utilities
export {
    generateSessionId,
    estimateTokens,
    formatTokens,
    formatCost,
    formatDuration,
    formatFileSize,
    truncateText,
    sanitizeOutput,
    parseJSON,
    createProgressBar,
    validateAPIKey,
    sanitizeFilename,
    debounce,
    throttle,
    retry,
    withTimeout,
    isObject,
    deepMerge,
    getEnvVar,
    generateTimestamp,
} from './core/formatting';

// Diff utilities
export {
    DiffUtil,
    showDiff,
    detectConflicts,
    type DiffLogger,
    type DiffColorizer,
    type DiffOptions,
} from './core/diff';

// Rate limiting
export {
    isRateLimitError,
    withRetry,
    createRateLimitedCaller,
    type RateLimitError,
    type RateLimitLogger,
    type RetryOptions,
} from './core/rate-limit';

// Logger
export {
    createLogger,
    createNoopLogger,
    getLogLevel,
    logger,
    type Logger,
    type LoggerOptions,
    type LogLevel,
} from './core/logger';
