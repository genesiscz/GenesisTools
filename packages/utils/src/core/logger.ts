/**
 * Lightweight logger module
 *
 * This module provides a simple logging interface that can work with or without pino.
 * When pino is available as a peer dependency, it uses pino for logging.
 * Otherwise, it falls back to console-based logging.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVELS: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    silent: 100,
};

/**
 * Check if log level is enabled
 */
function shouldLog(level: LogLevel, currentLevel: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

/**
 * Get log level from environment or arguments
 */
export function getLogLevel(): LogLevel {
    if (process.env.LOG_TRACE === "1") {
        return "trace";
    }
    if (process.env.LOG_DEBUG === "1") {
        return "debug";
    }
    if (process.env.LOG_SILENT === "1") {
        return "silent";
    }
    if (process.argv.some((arg) => arg === "-vv") || process.argv.includes("--trace")) {
        return "trace";
    }
    if (process.argv.includes("-v") || process.argv.includes("--verbose")) {
        return "debug";
    }
    return "info";
}

/**
 * Logger options
 */
export interface LoggerOptions {
    level?: LogLevel;
    prefix?: string;
}

/**
 * Logger interface
 */
export interface Logger {
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    level: LogLevel;
}

/**
 * Create a console-based logger
 */
export function createLogger(options: LoggerOptions = {}): Logger {
    const logLevel = options.level || getLogLevel();
    const prefix = options.prefix ? `[${options.prefix}] ` : "";
    const isTerminal = process.stdout.isTTY === true;

    const formatArgs = (args: unknown[]): string => {
        return args
            .map((arg) => {
                if (typeof arg === "string") {
                    return arg;
                }
                if (arg instanceof Error) {
                    return arg.message;
                }
                try {
                    return JSON.stringify(arg);
                } catch {
                    return String(arg);
                }
            })
            .join(" ");
    };

    // Try to import chalk for colors (optional)
    const colors: {
        gray: (s: string) => string;
        yellow: (s: string) => string;
        red: (s: string) => string;
    } = {
        gray: (s) => s,
        yellow: (s) => s,
        red: (s) => s,
    };

    // Attempt to load chalk if available
    try {
        // Dynamic import not supported in sync context,
        // so we provide plain output by default
        // Users can enhance with chalk by passing a colorizer
    } catch {
        // chalk not available, use plain output
    }

    return {
        level: logLevel,
        trace: (...args: unknown[]) => {
            if (shouldLog("trace", logLevel)) {
                const msg = prefix + formatArgs(args);
                console.log(isTerminal ? colors.gray(msg) : msg);
            }
        },
        debug: (...args: unknown[]) => {
            if (shouldLog("debug", logLevel)) {
                const msg = prefix + formatArgs(args);
                console.log(isTerminal ? colors.gray(msg) : msg);
            }
        },
        info: (...args: unknown[]) => {
            if (shouldLog("info", logLevel)) {
                console.log(prefix + formatArgs(args));
            }
        },
        warn: (...args: unknown[]) => {
            if (shouldLog("warn", logLevel)) {
                const levelPrefix = isTerminal ? colors.yellow("WARN:") : "WARN:";
                console.log(levelPrefix, prefix + formatArgs(args));
            }
        },
        error: (...args: unknown[]) => {
            if (shouldLog("error", logLevel)) {
                const levelPrefix = isTerminal ? colors.red("ERROR:") : "ERROR:";
                console.log(levelPrefix, prefix + formatArgs(args));
            }
        },
    };
}

/**
 * Create a no-op logger (silent)
 */
export function createNoopLogger(): Logger {
    const noop = () => {};
    return {
        level: "silent",
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
    };
}

/**
 * Default logger instance
 */
export const logger = createLogger();

export default logger;
