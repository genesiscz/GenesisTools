import { SafeJSON } from "@genesiscz/utils/json";
import { isTraceId } from "@genesiscz/utils/trace";

/**
 * The hub server's wire format: one JSON object per line, both directions, over a unix socket.
 * The request names the same argv the CLI takes, so the client's fallback is the process.
 *
 *   → {"id":1,"op":"call","argv":["hub","agents","counts",…]}
 *   ← {"id":1,"ok":true,"stdout":"…","stderr":"","exit":0,"ms":12,"cpuMs":9}
 *   → {"id":2,"op":"subscribe","argv":["ai","sessions","tail","X","--live","--offset","10"]}
 *   ← {"id":2,"lines":["…"]}            (one message per burst)
 *   ← {"id":2,"end":true,"exit":0,"stderr":"","reason":"done"|"cancelled"|"restart"|"error"}
 *   → {"id":2,"op":"cancel"}
 *   → {"id":3,"op":"health"}
 *   ← {"id":3,"ok":true,"health":{…}}
 *   → {"id":4,"op":"drain"}   (finish calls, end subscriptions with reason "restart", exit)
 *   ← {"id":4,"ok":true}
 *   ← {"id":N,"ok":false,"code":"unsupported"|"bad-request"|"draining"}
 */
export type HubServerRequest =
    | { id: number; op: "call"; argv: string[]; timeoutMs?: number; traceId?: string }
    | { id: number; op: "subscribe"; argv: string[]; traceId?: string }
    | { id: number; op: "cancel" }
    | { id: number; op: "health" }
    | { id: number; op: "drain" };

export type EndReason = "done" | "cancelled" | "restart" | "error";

export interface CallResult {
    stdout: string;
    stderr: string;
    exit: number;
}

export interface HubServerHealth {
    pid: number;
    startedAt: string;
    codeStamp: number;
    rssBytes: number;
    footprintBytes: number;
    connections: number;
    subscriptions: number;
    calls: number;
    errors: number;
    doors: string[];
}

/** One line longer than this closes the connection that sent it (the protocol has no large requests). */
export const MAX_REQUEST_LINE = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequest(line: string): HubServerRequest | null {
    let value: unknown;
    try {
        // Strict wire JSON: the client is a program, not a person.
        value = SafeJSON.parse(line, { strict: true });
    } catch {
        return null;
    }

    if (!isRecord(value)) {
        return null;
    }

    const record = value;
    const id = record.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
        return null;
    }

    // The app's per-call id (utils/trace.ts); anything that is not a plain id is dropped, never logged.
    const traceId = isTraceId(record.traceId) ? record.traceId : undefined;
    const argv =
        Array.isArray(record.argv) && record.argv.every((part) => typeof part === "string") ? record.argv : null;
    switch (record.op) {
        case "call":
            if (!argv) {
                return null;
            }

            return {
                id,
                op: "call",
                argv,
                timeoutMs: typeof record.timeoutMs === "number" ? record.timeoutMs : undefined,
                traceId,
            };
        case "subscribe":
            return argv ? { id, op: "subscribe", argv, traceId } : null;
        case "cancel":
            return { id, op: "cancel" };
        case "health":
            return { id, op: "health" };
        case "drain":
            return { id, op: "drain" };
        default:
            return null;
    }
}

/** Splits a byte stream into lines; keeps the partial tail for the next chunk. */
export class LineBuffer {
    private partial = "";

    constructor(private readonly maxLine: number = MAX_REQUEST_LINE) {}

    /** The complete lines in this chunk, or null when a line (complete or partial) grew past the limit. */
    push(chunk: string): string[] | null {
        this.partial += chunk;
        const lines: string[] = [];
        let newline = this.partial.indexOf("\n");
        while (newline >= 0) {
            // A complete line is checked too: an oversized one that arrived with its newline closes the connection.
            if (newline > this.maxLine) {
                return null;
            }

            const line = this.partial.slice(0, newline).trim();
            if (line) {
                lines.push(line);
            }

            this.partial = this.partial.slice(newline + 1);
            newline = this.partial.indexOf("\n");
        }

        return this.partial.length > this.maxLine ? null : lines;
    }
}
