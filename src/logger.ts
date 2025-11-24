import minimist from "minimist";
import path from "path";
import pino from "pino";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = minimist(process.argv.slice(2), {
    alias: {
        v: "verbose",
        vv: "trace",
    },
    default: {
        verbose: false,
        trace: false,
    },
});

const getLogLevel = (): pino.LevelWithSilent | null => {
    if (process.env.LOG_TRACE === "1") return "trace";
    if (process.env.LOG_DEBUG === "1") return "debug";
    if (process.env.LOG_SILENT === "1") return "silent";
    if (args.vv) {
        return "trace";
    } else if (args.v) {
        return "debug";
    }

    return "info";
};

export interface LoggerOptions {
    level: pino.LevelWithSilent;
    logToFile?: boolean;
    includeTimestamp?: boolean;
    prefixPid?: boolean;
}

export const createLogger = (options: LoggerOptions) => {
    const { level, logToFile = false, includeTimestamp = true, prefixPid = false } = options;
    // Get current date for log file name
    const getCurrentDate = () => {
        const now = new Date();
        return now.toISOString().split("T")[0]; // YYYY-MM-DD format
    };

    // Determine if running in a terminal (attached to a TTY)
    const isTerminal = process.stdout.isTTY;

    // Create streams array based on whether it's a terminal or not
    const streams = [];

    // Create log file path
    const logFilePath = path.join(__dirname, "..", "logs", `${getCurrentDate()}.log`);

    if (logToFile) {
        // Always add the file output stream
        streams.push({
            stream: pino.destination({
                dest: logFilePath,
                sync: true, // Async writing is generally better for performance
            }),
            level,
        });
    }

    // Add console output stream ONLY if attached to a terminal
    if (isTerminal) {
        streams.push({
            stream: pino.transport({
                target: "pino-pretty",
                options: {
                    colorize: true,
                    translateTime: includeTimestamp ? "SYS:standard" : false,
                    ignore: prefixPid ? "hostname" : "pid,hostname", // Show PID if prefixPid is true
                },
            }),
            level,
        });
    }

    // Create base logger config
    const baseConfig: pino.LoggerOptions = {
        level,
        timestamp: includeTimestamp ? pino.stdTimeFunctions.isoTime : false,
    };

    // Add PID to base config if prefixPid is true
    if (prefixPid) {
        baseConfig.base = {
            pid: process.pid,
        };
    }

    // Create pino logger with multiple streams
    const logger = pino(baseConfig, pino.multistream(streams));
    return logger;
};

// Default level
let level: pino.LevelWithSilent = getLogLevel() ?? "info";

export const createDefaultLoggerFromCommandLineArgs = (prefixPid: boolean = false) => {
    const logger = createLogger({
        level,
        logToFile: true,
        includeTimestamp: true,
        prefixPid,
    });
    return logger;
};

// Check if PID prefixing is requested via environment variable
const prefixPid = process.env.LOG_PID === "1" || process.env.DEBUG === "1";

const logger = createDefaultLoggerFromCommandLineArgs(prefixPid);
const consoleLog = createLogger({
    level,
    logToFile: false,
    includeTimestamp: true,
    prefixPid,
});

// Ensure all logs are flushed before the process exits
process.on("beforeExit", () => {
    logger.flush();
});

export { consoleLog };
export default logger;
