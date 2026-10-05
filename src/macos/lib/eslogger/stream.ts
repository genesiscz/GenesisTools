import { type EventFilter, matchesAll } from "./filter";
import { type FormatOptions, formatEvent } from "./format";
import { type EsMessage, eventNameOf, parseEsloggerLine } from "./message";

export interface EventStreamOptions {
    filters: readonly EventFilter[];
    /** Keep only these events. A live eslogger already sends only what it was asked for; a replayed file does not. */
    events?: ReadonlySet<string>;
    format?: FormatOptions;
    /** One formatted line per event that passed the event set and every filter. */
    onEvent: (line: string, message: EsMessage) => void;
    /** The raw JSON of every parsed event in the event set, before the filters (`--debug`). */
    onRaw?: (message: EsMessage) => void;
    /** A line that is not a JSON object. `count` is the running total, so a caller can report only the first few. */
    onParseError?: (error: string, line: string, count: number) => void;
}

export interface EventStreamStats {
    lines: number;
    events: number;
    shown: number;
    parseErrors: number;
}

/**
 * eslogger JSON Lines in, formatted lines out. Takes chunks as they arrive from a pipe, so a line split
 * across two reads (or a multi-byte character split across two chunks) is joined before parsing.
 */
export class EventStream {
    readonly stats: EventStreamStats = { lines: 0, events: 0, shown: 0, parseErrors: 0 };
    private buffer = "";
    private readonly decoder = new TextDecoder();

    constructor(private readonly options: EventStreamOptions) {}

    write(chunk: Uint8Array | string): void {
        this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";

        for (const line of lines) {
            this.handle(line);
        }
    }

    /** Flush a last line that had no newline. */
    end(): void {
        this.buffer += this.decoder.decode();

        if (this.buffer.length > 0) {
            this.handle(this.buffer);
            this.buffer = "";
        }
    }

    private handle(rawLine: string): void {
        const line = rawLine.trim();

        if (line.length === 0) {
            return;
        }

        this.stats.lines++;
        const parsed = parseEsloggerLine(line);

        if (!parsed.ok) {
            this.stats.parseErrors++;
            this.options.onParseError?.(parsed.error, line, this.stats.parseErrors);
            return;
        }

        const message = parsed.message;

        if (this.options.events && !this.options.events.has(eventNameOf(message))) {
            return;
        }

        this.stats.events++;
        this.options.onRaw?.(message);

        if (!matchesAll(this.options.filters, message)) {
            return;
        }

        this.stats.shown++;
        this.options.onEvent(formatEvent(message, this.options.format), message);
    }
}
