import fs from 'fs';
import path from 'path';
import {
  Logger,
  pino,
  TransportMultiOptions,
  TransportPipelineOptions,
  TransportSingleOptions,
} from 'pino';

// const tmpDir = os.tmpdir();
const tmpDir = __dirname;
const logDir = path.resolve(tmpDir, 'interactive-mcp-logs');
const logFile = path.join(logDir, 'dev.log');

// const isDev = process.env.NODE_ENV === 'development';
const isDev = true;
const isDevelopment = true;

// Ensure log directory exists
if (isDev && !fs.existsSync(logDir)) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error) {
    console.error('Failed to create log directory:', error); // Use console here as logger isn't initialized yet
    // Consider fallback behavior or exiting if logging is critical
  }
}

// const isDevelopment = process.env.NODE_ENV === 'development';

const loggerOptions: pino.LoggerOptions = {
  level: isDev ? 'trace' : 'silent', // Default level
};

if (isDevelopment) {
  let devTransportConfig:
    | TransportSingleOptions
    | TransportMultiOptions
    | TransportPipelineOptions;
  try {
    // Attempt to open the file in append mode to check writability before setting up transport
    const fd = fs.openSync(logFile, 'a');
    fs.closeSync(fd);
    devTransportConfig = {
      targets: [
        {
          target: 'pino-pretty', // Log to console with pretty printing
          options: {
            colorize: true,
            sync: false, // Use async logging
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname',
          },
          level: 'trace', // Log all levels to the console in dev
        },
        {
          target: 'pino/file', // Log to file
          options: { destination: logFile, mkdir: true }, // Specify file path and ensure directory exists
          level: 'trace', // Log all levels to the file in dev
        },
      ],
    };
  } catch (error) {
    console.error(
      `Failed to setup file transport for ${logFile}. Falling back to console-only logging. Error:`,
      error,
    );
    // Fallback transport to console only using pino-pretty if file access fails
    devTransportConfig = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        sync: false,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
      },
      level: 'trace',
    };
  }
  // Add transport to logger options only in development
  loggerOptions.transport = devTransportConfig;
}

const logger: Logger = pino(loggerOptions);

export default logger;
