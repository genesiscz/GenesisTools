import chalk from "chalk";
import path from "path";
import pino from "pino";
import PinoPretty from "pino-pretty";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line args for log level (simple check without minimist)
const args = {
    verbose: process.argv.includes("-v") || process.argv.includes("--verbose"),
    trace: process.argv.some((arg) => arg === "-vv") || process.argv.includes("--trace"),
};

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "silent";

const LOG_LEVELS: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    silent: 100,
};

const getLogLevel = (): LogLevel => {
    if (process.env.LOG_TRACE === "1") return "trace";
    if (process.env.LOG_DEBUG === "1") return "debug";
    if (process.env.LOG_SILENT === "1") return "silent";
    if (args.trace) return "trace";
    if (args.verbose) return "debug";
    return "info";
};

// Check environment
const currentLevel = getLogLevel();
const prefixPid = process.env.LOG_PID === "1" || process.env.DEBUG === "1";
const isTerminal = process.stdout.isTTY === true;

export interface LoggerOptions {
    level?: LogLevel;
    logToFile?: boolean;
    includeTimestamp?: boolean;
    prefixPid?: boolean;
    timestampFormat?: string | false;
    sync?: boolean;
    /** Hide level prefix for info/debug/trace, only show for warn/error */
    minimalLevels?: boolean;
}

export interface LoggerConfig {
    includeTimestamp?: boolean;
    timestampFormat?: string;
    sync?: boolean;
}

// Global config
let globalConfig: LoggerConfig = {
    includeTimestamp: false, // Default: no timestamps
    timestampFormat: "HH:MM:ss",
    sync: true, // Default: sync mode to ensure proper log ordering
};

/**
 * Create a pino logger with pretty printing
 */
export const createLogger = (options: LoggerOptions = {}): pino.Logger => {
    const {
        level: logLevel = currentLevel,
        logToFile = false,
        includeTimestamp = globalConfig.includeTimestamp ?? false,
        prefixPid: showPid = prefixPid,
        timestampFormat = includeTimestamp ? globalConfig.timestampFormat ?? "HH:MM:ss" : false,
        sync = globalConfig.sync ?? false,
        minimalLevels = false,
    } = options;

    const streams: pino.StreamEntry[] = [];
    const streamLevel = logLevel as pino.Level;

    // File stream (if enabled)
    if (logToFile) {
        const date = new Date().toISOString().split("T")[0];
        const logFilePath = path.join(__dirname, "..", "logs", `${date}.log`);
        streams.push({
            level: streamLevel,
            stream: pino.destination({ dest: logFilePath, sync: true }),
        });
    }

    // Console stream
    if (process.stdout && typeof process.stdout.write === "function") {
        const prettyOptions: PinoPretty.PrettyOptions = {
            sync,
            colorize: isTerminal,
            translateTime: timestampFormat,
            ignore: showPid ? "hostname" : "pid,hostname",
        };

        // For minimal levels: hide level for info/debug/trace, show for warn/error
        if (minimalLevels) {
            prettyOptions.customPrettifiers = {
                level: (logLevelValue: unknown) => {
                    const lvl = String(logLevelValue).toLowerCase();
                    // pino sends level as number (30=info, 40=warn, 50=error) or label
                    if (lvl === "warn" || lvl === "40") {
                        return isTerminal ? chalk.yellow("WARN:") : "WARN:";
                    }
                    if (lvl === "error" || lvl === "50") {
                        return isTerminal ? chalk.red("ERROR:") : "ERROR:";
                    }
                    return ""; // Hide for trace/debug/info
                },
            };
        }

        streams.push({
            level: streamLevel,
            stream: PinoPretty(prettyOptions),
        });
    }

    const baseConfig: pino.LoggerOptions = {
        level: logLevel,
        timestamp: includeTimestamp ? pino.stdTimeFunctions.isoTime : false,
        ...(showPid && { base: { pid: process.pid } }),
    };

    const logger = pino(baseConfig, pino.multistream(streams));

    // In sync mode on TTY, wrap methods to flush after each log
    if (sync && isTerminal) {
        const wrap = (method: pino.LogFn): pino.LogFn => {
            const bound = method.bind(logger);
            return ((...args: Parameters<pino.LogFn>) => {
                bound(...args);
                logger.flush();
            }) as pino.LogFn;
        };

        logger.info = wrap(logger.info);
        logger.warn = wrap(logger.warn);
        logger.error = wrap(logger.error);
        logger.debug = wrap(logger.debug);
        logger.trace = wrap(logger.trace);
    }

    return logger;
};

/**
 * Simple raw console logger interface - no pino overhead
 * Clean output: no timestamps, no levels for info, colored WARN/ERROR for those
 */
export interface RawConsoleLogger {
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    level: LogLevel;
    flush: () => void;
}

/**
 * Create a raw console logger - bypasses pino entirely for minimal overhead
 * - trace/debug: gray text
 * - info: plain text
 * - warn: yellow "WARN:" prefix
 * - error: red "ERROR:" prefix
 */
export const createConsoleLoggerRaw = (logLevel: LogLevel = currentLevel): RawConsoleLogger => {
    const shouldLog = (level: LogLevel) => LOG_LEVELS[level] >= LOG_LEVELS[logLevel];

    const formatArgs = (args: unknown[]): string => {
        return args
            .map((arg) => {
                if (typeof arg === "string") return arg;
                if (arg instanceof Error) return arg.message;
                try {
                    return JSON.stringify(arg);
                } catch {
                    return String(arg);
                }
            })
            .join(" ");
    };

    return {
        level: logLevel,
        trace: (...args: unknown[]) => {
            if (shouldLog("trace")) {
                const msg = formatArgs(args);
                console.log(isTerminal ? chalk.gray(msg) : msg);
            }
        },
        debug: (...args: unknown[]) => {
            if (shouldLog("debug")) {
                const msg = formatArgs(args);
                console.log(isTerminal ? chalk.gray(msg) : msg);
            }
        },
        info: (...args: unknown[]) => {
            if (shouldLog("info")) {
                console.log(formatArgs(args));
            }
        },
        warn: (...args: unknown[]) => {
            if (shouldLog("warn")) {
                const prefix = isTerminal ? chalk.yellow("WARN:") : "WARN:";
                console.log(prefix, formatArgs(args));
            }
        },
        error: (...args: unknown[]) => {
            if (shouldLog("error")) {
                const prefix = isTerminal ? chalk.red("ERROR:") : "ERROR:";
                console.log(prefix, formatArgs(args));
            }
        },
        flush: () => {}, // No-op for raw logger
    };
};

// Default logger instances - both use minimalLevels (no level prefix for info/debug/trace)
let logger = createLogger({ logToFile: false, minimalLevels: true });
let consoleLog = createLogger({ logToFile: false, minimalLevels: true });

/**
 * Configure logger behavior and recreate logger instances
 */
export const configureLogger = (config: LoggerConfig): void => {
    globalConfig = { ...globalConfig, ...config };
    logger = createLogger({ logToFile: false, minimalLevels: true });
    consoleLog = createLogger({ logToFile: false, minimalLevels: true });
};

export { consoleLog };
export default logger;
