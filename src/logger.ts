import minimist from "minimist";
import path from "path";
import pino from "pino";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = minimist(process.argv.slice(2));

export const createLogger = (level: pino.LevelWithSilent, logToFile: boolean) => {
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
                sync: false, // Async writing is generally better for performance
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
                    translateTime: "SYS:standard",
                    ignore: "pid,hostname", // Ignore these fields for cleaner console output
                },
            }),
            level,
        });
    }

    // Create pino logger with multiple streams
    const logger = pino(
        {
            level,
            timestamp: pino.stdTimeFunctions.isoTime,
        },
        pino.multistream(streams)
    );
    return logger;
};

 // Default level
 let level: pino.LevelWithSilent = "info";

 if (args.vv) {
     level = "trace";
 } else if (args.v) {
     level = "debug";
 }

export const createDefaultLoggerFromCommandLineArgs = () => {
    const logger = createLogger(level, true);
    return logger;
};

const logger = createDefaultLoggerFromCommandLineArgs();
const consoleLog = createLogger(level, false);

export { consoleLog };
export default logger;
