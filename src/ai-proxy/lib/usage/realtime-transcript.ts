/**
 * Transcript writer for realtime WebSocket sessions.
 *
 * The chat path can serialize one exchange after the fact (`writeTranscript`),
 * but a realtime session is a minutes-long stream of events in both directions,
 * so this records as it goes and closes with a summary entry. The JSONL shape is
 * the same one `tools ai-proxy calls --show` already reads: entries sharing a
 * `callId`, each carrying `message.content` text blocks.
 *
 * Volume is the whole problem. A voice session is mostly `*.delta` frames and
 * base64 PCM; inlining them would write megabytes per minute and bury the parts
 * a human actually wants to read. So delta frames and binary frames are counted,
 * not stored, and any oversized string inside a kept event is replaced by a note
 * of how many characters were dropped.
 */
import {
    appendTranscriptLines,
    type TranscriptRef,
    transcriptFile,
    transcriptsEnabled,
} from "@app/ai-proxy/lib/usage/transcripts";
import type { RequestTags, TokenUsage } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/** Longest string kept inside a recorded event before it becomes a note. */
const MAX_FIELD_CHARS = 2_000;
/** Longest serialized event kept in one entry. */
const MAX_EVENT_CHARS = 8_000;
/** Entries buffered before hitting the disk. */
const FLUSH_EVERY = 20;
/**
 * Retained events per session. `FLUSH_EVERY` only bounds memory: without this a
 * session that stays open for hours (or a client that just keeps sending
 * non-delta frames) writes to disk forever. Past the ceiling events are counted
 * in the summary the same way high-volume deltas already are.
 */
export const MAX_RETAINED_EVENTS = 5_000;
/** Retained event bytes per session, for the same reason. */
const MAX_RETAINED_BYTES = 32 * 1_024 * 1_024;

export type RealtimeDirection = "client" | "upstream";

export interface RealtimeTranscriptOptions {
    ts: string;
    account: string;
    provider: string;
    proxyModel: string;
    upstreamModel: string;
    client: string;
    tags?: RequestTags;
}

export interface RealtimeTranscriptSummary {
    elapsedMs: number;
    closeCode: number;
    usage?: TokenUsage;
    clientFrames: number;
    clientBytes: number;
    upstreamFrames: number;
    upstreamBytes: number;
}

/** Events whose payload is a stream fragment: counted, never stored. */
function isHighVolumeEvent(type: string): boolean {
    return type.endsWith(".delta") || type === "input_audio_buffer.append";
}

/** Replace long strings (base64 audio, giant instructions) but keep the structure. */
function truncateStrings(value: unknown, depth = 0): unknown {
    if (typeof value === "string") {
        return value.length > MAX_FIELD_CHARS ? `<omitted ${value.length} chars>` : value;
    }

    if (value === null || typeof value !== "object" || depth >= 8) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => truncateStrings(item, depth + 1));
    }

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, truncateStrings(item, depth + 1)])
    );
}

function compactEvent(event: unknown): string {
    const json = SafeJSON.stringify(truncateStrings(event), { strict: true });

    return json.length > MAX_EVENT_CHARS ? `${json.slice(0, MAX_EVENT_CHARS)}…` : json;
}

export class RealtimeTranscript {
    private readonly file: string;
    private readonly day: string;
    private readonly sessionId: string;
    private readonly callId = crypto.randomUUID();
    private readonly options: RealtimeTranscriptOptions;
    private readonly enabled: boolean;
    private readonly skipped = new Map<string, number>();
    private pending: string[] = [];
    private parentUuid: string | null = null;
    private binaryFrames = { client: 0, upstream: 0 };
    private binaryBytes = { client: 0, upstream: 0 };
    private retainedEvents = 0;
    private retainedBytes = 0;
    private cappedEvents = 0;

    constructor(options: RealtimeTranscriptOptions) {
        this.options = options;
        this.enabled = transcriptsEnabled();
        this.day = options.ts.slice(0, 10);
        this.sessionId = options.tags?.session ?? "_untagged";
        this.file = transcriptFile(this.day, options.tags?.session);
    }

    recordFrame(direction: RealtimeDirection, payload: string | ArrayBuffer | Buffer): void {
        if (!this.enabled) {
            return;
        }

        if (typeof payload !== "string") {
            this.binaryFrames[direction] += 1;
            this.binaryBytes[direction] += payload.byteLength;
            return;
        }

        let event: { type?: string } | undefined;
        try {
            event = SafeJSON.parse(payload, { strict: true }) as { type?: string };
        } catch (err) {
            logger.debug({ err, direction }, "ai-proxy realtime transcript: non-JSON frame kept verbatim");
        }

        if (!event || typeof event !== "object") {
            this.push(direction, "text", payload.slice(0, MAX_EVENT_CHARS));
            return;
        }

        const type = typeof event.type === "string" ? event.type : "unknown";

        if (isHighVolumeEvent(type)) {
            this.skipped.set(type, (this.skipped.get(type) ?? 0) + 1);
            return;
        }

        this.push(direction, type, compactEvent(event));
    }

    /** Close the session out with a summary entry and return its ref. */
    finish(summary: RealtimeTranscriptSummary): TranscriptRef | undefined {
        if (!this.enabled) {
            return undefined;
        }

        const uuid = crypto.randomUUID();
        this.pending.push(
            SafeJSON.stringify(
                {
                    parentUuid: this.parentUuid,
                    sessionId: this.sessionId,
                    uuid,
                    timestamp: new Date(new Date(this.options.ts).getTime() + summary.elapsedMs).toISOString(),
                    type: "assistant",
                    callId: this.callId,
                    tags: this.options.tags ?? {},
                    elapsedMs: summary.elapsedMs,
                    status: 101,
                    stream: true,
                    account: this.options.account,
                    provider: this.options.provider,
                    path: "/v1/realtime",
                    realtime: {
                        closeCode: summary.closeCode,
                        clientFrames: summary.clientFrames,
                        clientBytes: summary.clientBytes,
                        upstreamFrames: summary.upstreamFrames,
                        upstreamBytes: summary.upstreamBytes,
                        binaryFrames: { ...this.binaryFrames },
                        binaryBytes: { ...this.binaryBytes },
                        skippedEvents: Object.fromEntries(this.skipped),
                        retainedEvents: this.retainedEvents,
                        cappedEvents: this.cappedEvents,
                    },
                    message: {
                        role: "assistant",
                        model: this.options.upstreamModel,
                        proxyModel: this.options.proxyModel,
                        content: [{ type: "text", text: this.summaryText(summary) }],
                        usage: summary.usage,
                    },
                },
                { strict: true }
            )
        );

        this.flush();

        return { file: this.file, uuid };
    }

    private summaryText(summary: RealtimeTranscriptSummary): string {
        const skipped = [...this.skipped.entries()].map(([type, count]) => `${type} x${count}`).join(", ");

        return [
            `realtime session closed (code ${summary.closeCode}) after ${Math.round(summary.elapsedMs / 1000)}s`,
            `client ${summary.clientFrames} frames / ${summary.clientBytes} bytes · upstream ${summary.upstreamFrames} frames / ${summary.upstreamBytes} bytes`,
            `binary frames not stored: client ${this.binaryFrames.client} (${this.binaryBytes.client} bytes), upstream ${this.binaryFrames.upstream} (${this.binaryBytes.upstream} bytes)`,
            skipped ? `stream fragments counted only: ${skipped}` : "no stream fragments",
            this.cappedEvents > 0
                ? `retention ceiling reached after ${this.retainedEvents} events: ${this.cappedEvents} later events counted only`
                : `${this.retainedEvents} events retained`,
        ].join("\n");
    }

    private push(direction: RealtimeDirection, type: string, body: string): void {
        if (this.retainedEvents >= MAX_RETAINED_EVENTS || this.retainedBytes >= MAX_RETAINED_BYTES) {
            this.cappedEvents += 1;

            if (this.cappedEvents === 1) {
                logger.warn(
                    { file: this.file, retainedEvents: this.retainedEvents, retainedBytes: this.retainedBytes },
                    "ai-proxy realtime transcript: session hit its retention ceiling, later events are counted only"
                );
            }

            return;
        }

        const uuid = crypto.randomUUID();
        const line = SafeJSON.stringify(
            {
                parentUuid: this.parentUuid,
                sessionId: this.sessionId,
                uuid,
                timestamp: new Date().toISOString(),
                type: direction === "client" ? "user" : "assistant",
                callId: this.callId,
                direction,
                eventType: type,
                message: {
                    role: direction === "client" ? "user" : "assistant",
                    content: [{ type: "text", text: `[${direction}] ${type}\n${body}` }],
                },
            },
            { strict: true }
        );

        this.pending.push(line);
        this.parentUuid = uuid;
        this.retainedEvents += 1;
        this.retainedBytes += line.length;

        if (this.pending.length >= FLUSH_EVERY) {
            this.flush();
        }
    }

    private flush(): void {
        if (this.pending.length === 0) {
            return;
        }

        const lines = this.pending;
        this.pending = [];
        appendTranscriptLines(this.file, this.day, lines);
    }
}
