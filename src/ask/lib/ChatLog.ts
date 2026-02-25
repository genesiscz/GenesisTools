import type { LogEntry, LogLevel } from "./types";

const LOG_LEVELS: Record<LogLevel, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    silent: 100,
};

export class ChatLog {
    private entries: LogEntry[] = [];
    private cursor = 0;
    private readonly threshold: number;

    constructor(logLevel: LogLevel = "info") {
        this.threshold = LOG_LEVELS[logLevel];
    }

    capture(level: LogLevel, message: string, source?: string): void {
        if (LOG_LEVELS[level] < this.threshold) {
            return;
        }

        this.entries.push({
            level,
            message,
            timestamp: new Date(),
            source,
        });
    }

    getUnseen(options?: { level?: LogLevel }): LogEntry[] {
        const minLevel = options?.level ? LOG_LEVELS[options.level] : 0;
        const unseen = this.entries.slice(this.cursor);
        this.cursor = this.entries.length;

        if (minLevel > 0) {
            return unseen.filter((e) => LOG_LEVELS[e.level] >= minLevel);
        }

        return unseen;
    }

    getAll(options?: { level?: LogLevel; since?: Date }): LogEntry[] {
        let result = this.entries;

        if (options?.level) {
            const minLevel = LOG_LEVELS[options.level];
            result = result.filter((e) => LOG_LEVELS[e.level] >= minLevel);
        }

        if (options?.since) {
            result = result.filter((e) => e.timestamp >= options.since!);
        }

        return result;
    }

    clear(): void {
        this.entries = [];
        this.cursor = 0;
    }

    createLogger(source: string): CapturedLogger {
        return {
            trace: (msg: string) => this.capture("trace", msg, source),
            debug: (msg: string) => this.capture("debug", msg, source),
            info: (msg: string) => this.capture("info", msg, source),
            warn: (msg: string) => this.capture("warn", msg, source),
            error: (msg: string) => this.capture("error", msg, source),
        };
    }
}

export interface CapturedLogger {
    trace: (msg: string) => void;
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
}
