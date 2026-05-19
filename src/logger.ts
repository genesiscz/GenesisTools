import { homedir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { formatLocalDate } from "@app/utils/date";
import { SafeJSON } from "@app/utils/json";
import chalk from "chalk";
import pino from "pino";
import PinoPretty from "pino-pretty";

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
    if (process.env.LOG_TRACE === "1") {
        return "trace";
    }
    if (process.env.LOG_DEBUG === "1") {
        return "debug";
    }
    if (process.env.LOG_SILENT === "1") {
        return "silent";
    }
    if (args.trace) {
        return "trace";
    }
    if (args.verbose) {
        return "debug";
    }
    return "info";
};

// Check environment
const currentLevel = getLogLevel();

// Console threshold is a runtime-mutable module-level value; the pino root
// stays "trace" (file never starves) and a gated Writable (built in
// createLogger) drops sub-threshold records before pino-pretty. Mutating this
// via setConsoleLevel()/configureLogger() retroactively re-gates already
// created children — no rebuild, see spec §3.1.
function getConsoleLevel(): pino.LevelWithSilent {
    if (process.env.LOG_TRACE === "1") {
        return "trace";
    }

    if (process.env.LOG_DEBUG === "1") {
        return "debug";
    }

    if (process.env.LOG_SILENT === "1") {
        return "silent";
    }

    const env = process.env.LOG_CONSOLE_LEVEL as pino.LevelWithSilent | undefined;
    if (env && env in pino.levels.values) {
        return env;
    }

    return "info";
}

let consoleLevel: pino.LevelWithSilent = getConsoleLevel();
export function setConsoleLevel(l: pino.LevelWithSilent): void {
    consoleLevel = l;
}

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
    logToFile?: boolean;
    level?: LogLevel;
}

// Global config
let globalConfig: LoggerConfig = {
    includeTimestamp: false, // Default: no timestamps
    timestampFormat: "HH:MM:ss",
    sync: true, // Default: sync mode to ensure proper log ordering
};
let fileLogWarningShown = false;

/**
 * Create a pino logger with pretty printing
 */
export const createLogger = (options: LoggerOptions = {}): pino.Logger => {
    const {
        logToFile = false,
        includeTimestamp = globalConfig.includeTimestamp ?? false,
        prefixPid: showPid = prefixPid,
        timestampFormat = includeTimestamp ? (globalConfig.timestampFormat ?? "HH:MM:ss") : false,
        sync = globalConfig.sync ?? false,
        minimalLevels = false,
    } = options;

    const streams: pino.StreamEntry[] = [];

    // File stream (if enabled) — ALWAYS debug+, independent of the console
    // gate, so the file never starves no matter how high the console threshold.
    if (logToFile) {
        const date = formatLocalDate(new Date());
        const logDir = path.join(homedir(), ".genesis-tools", "logs");
        const logFilePath = path.join(logDir, `${date}.log`);

        try {
            streams.push({
                level: "debug" as pino.Level,
                stream: pino.destination({ dest: logFilePath, sync: true, mkdir: true }),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (!fileLogWarningShown && process.stderr && typeof process.stderr.write === "function") {
                fileLogWarningShown = true;
                process.stderr.write(`[logger] Failed to open log file ${logFilePath}: ${message}\n`);
            }
        }
    }

    // Console stream → STDERR (stdout is reserved for machine results via
    // out.result). A gated Writable drops records below the *mutable*
    // module-level consoleLevel before pino-pretty, so setConsoleLevel() /
    // configureLogger() retroactively re-gate already-created children — the
    // root pino stays "trace" so the file sink never starves (spec §3.1).
    // `destination` is the process.stderr STREAM, not fd 2: same fd in prod,
    // but pino-pretty pipes through it so test stderr shims still intercept.
    if (process.stderr && typeof process.stderr.write === "function") {
        const prettyOptions: PinoPretty.PrettyOptions = {
            destination: process.stderr,
            sync: true,
            colorize: process.stderr.isTTY === true,
            translateTime: timestampFormat,
            ignore: showPid ? "hostname" : "pid,hostname",
        };

        // minimalLevels: hide level for info/debug/trace, colored WARN:/ERROR:.
        if (minimalLevels) {
            prettyOptions.customPrettifiers = {
                level: (logLevelValue: unknown) => {
                    const lvl = String(logLevelValue).toLowerCase();
                    // pino sends level as number (40=warn, 50=error) or label
                    if (lvl === "warn" || lvl === "40") {
                        return isTerminal ? chalk.yellow("WARN:") : "WARN:";
                    }

                    if (lvl === "error" || lvl === "50") {
                        return isTerminal ? chalk.red("ERROR:") : "ERROR:";
                    }

                    return ""; // hide for trace/debug/info
                },
            };
        }

        const pretty = PinoPretty(prettyOptions);
        const gated = new Writable({
            write(chunk, _enc, cb) {
                try {
                    const lvl = (SafeJSON.parse(chunk.toString()) as { level: number }).level;
                    if (lvl >= pino.levels.values[consoleLevel]) {
                        pretty.write(chunk);
                    }
                } catch {
                    // Fail-open: an unparseable record still reaches the user.
                    // We cannot logger.* here — that recurses into this sink.
                    pretty.write(chunk);
                }

                cb();
            },
        });
        streams.push({ level: "trace" as pino.Level, stream: gated });
    }

    const baseConfig: pino.LoggerOptions = {
        level: "trace",
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
                if (typeof arg === "string") {
                    return arg;
                }
                if (arg instanceof Error) {
                    return arg.message;
                }
                try {
                    return SafeJSON.stringify(arg);
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

export type Logger = pino.Logger;

let _pino: pino.Logger | null = null;
function get(): pino.Logger {
    if (_pino === null) {
        _pino = createLogger({ logToFile: true, minimalLevels: true });
    }

    return _pino;
}

// Hand-coded stable facade. NOT a Proxy (pino .level/.bindings getter+setter
// and method count make Proxy traps fragile — see spec §3.1).
interface ScopedLogger {
    log: pino.Logger; // child; .out/.tee added in Phase 2
}

export interface LoggerFacade {
    trace: pino.LogFn;
    debug: pino.LogFn;
    info: pino.LogFn;
    warn: pino.LogFn;
    error: pino.LogFn;
    fatal: pino.LogFn;
    child(bindings: pino.Bindings, options?: pino.ChildLoggerOptions): pino.Logger;
    get level(): string;
    set level(v: string);
    flush(): void;
    scoped(component: string, opts?: { level?: string; bindings?: Record<string, unknown> }): ScopedLogger;
}

export const logger: LoggerFacade = {
    trace: (...a: Parameters<pino.LogFn>) => get().trace(...a),
    debug: (...a: Parameters<pino.LogFn>) => get().debug(...a),
    info: (...a: Parameters<pino.LogFn>) => get().info(...a),
    warn: (...a: Parameters<pino.LogFn>) => get().warn(...a),
    error: (...a: Parameters<pino.LogFn>) => get().error(...a),
    fatal: (...a: Parameters<pino.LogFn>) => get().fatal(...a),
    child: (b: pino.Bindings, o?: pino.ChildLoggerOptions) => get().child(b, o),
    get level() {
        return get().level;
    },
    set level(v: string) {
        get().level = v;
    },
    flush: () => get().flush(),
    scoped(component, opts) {
        const child = get().child(
            { component, ...(opts?.bindings ?? {}) },
            opts?.level ? { level: opts.level } : undefined
        );

        return { log: child };
    },
};

/**
 * Bridging stubs: the facade replaced the old mutable `let logger`/`let
 * consoleLog`, but configureLogger (2 ext callers) and getLogger (3 ext
 * callers — ApiClient, WebViewPool) must keep compiling through Phase 1.
 * Task 4 rewrites configureLogger to drive the console gate; here it only
 * records globalConfig (no rebuild — the facade singleton never rebuilds).
 */
export const configureLogger = (config: LoggerConfig): void => {
    globalConfig = { ...globalConfig, ...config };
};

/** Returns the underlying pino (now the lazy singleton). */
export function getLogger(): pino.Logger {
    return get();
}

export const consoleLog = logger; // transitional alias (Phase 4 migrates importers)
export default logger; // transitional default (removed in Task 22)
