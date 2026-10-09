import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { parseJsonl } from "@genesiscz/utils/jsonl";
import { readJsonlFile } from "@genesiscz/utils/log-session/jsonl-reader";
import { withFileLock } from "@genesiscz/utils/storage";
import type { FeedEvent, MessageEvent, SessionPaths } from "./types";

const FEED_LOCK_TIMEOUT_MS = 10_000;
const MAX_MESSAGE_ID = 0xffff;

function ensureFeedFile(path: string): void {
    const dir = dirname(path);

    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(path)) {
        appendFileSync(path, "");
    }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type FeedEventInput = DistributiveOmit<FeedEvent, "seq" | "ts">;
export type NonMessageInput = Exclude<FeedEventInput, { type: "message" }>;
export type MessageEventInput = DistributiveOmit<MessageEvent, "seq" | "ts" | "message_id">;

export async function readFeed(paths: SessionPaths): Promise<FeedEvent[]> {
    if (!existsSync(paths.feedPath)) {
        return [];
    }

    const records = await readJsonlFile(paths.feedPath);
    return records as unknown as FeedEvent[];
}

export async function readFeedSince(paths: SessionPaths, sinceSeq: number): Promise<FeedEvent[]> {
    const all = await readFeed(paths);
    return all.filter((e) => e.seq > sinceSeq);
}

export class FeedLogCursor {
    private offset = 0;
    private partial = Buffer.alloc(0);
    private identity: string | null = null;
    private sinceSeq: number;

    constructor(
        private readonly options: {
            paths: SessionPaths;
            sinceSeq: number;
            onRead?: (sample: { bytes: number; records: number }) => void;
        }
    ) {
        this.sinceSeq = options.sinceSeq;
    }

    async readAppended(): Promise<FeedEvent[]> {
        const path = this.options.paths.feedPath;
        if (!existsSync(path)) {
            this.offset = 0;
            this.partial = Buffer.alloc(0);
            this.identity = null;
            return [];
        }

        const stat = statSync(path);
        const identity = `${stat.dev}:${stat.ino}`;
        if (this.identity !== identity || stat.size < this.offset) {
            this.offset = 0;
            this.partial = Buffer.alloc(0);
            this.identity = identity;
        }
        if (stat.size === this.offset) {
            return [];
        }

        const length = stat.size - this.offset;
        const chunk = Buffer.allocUnsafe(length);
        const fd = openSync(path, "r");
        let bytesRead = 0;
        try {
            while (bytesRead < length) {
                const read = readSync(fd, chunk, bytesRead, length - bytesRead, this.offset + bytesRead);
                if (read === 0) {
                    break;
                }
                bytesRead += read;
            }
        } finally {
            closeSync(fd);
        }

        this.offset += bytesRead;
        const combined = Buffer.concat([this.partial, chunk.subarray(0, bytesRead)]);
        const lastNewline = combined.lastIndexOf(0x0a);
        if (lastNewline < 0) {
            this.partial = combined;
            this.options.onRead?.({ bytes: bytesRead, records: 0 });
            return [];
        }

        const complete = combined.subarray(0, lastNewline).toString("utf8").trim();
        this.partial = Buffer.from(combined.subarray(lastNewline + 1));
        const events = complete ? parseJsonl<FeedEvent>(complete) : [];
        this.options.onRead?.({ bytes: bytesRead, records: events.length });
        const appended = events.filter((event) => event.seq > this.sinceSeq);
        this.sinceSeq = appended.reduce((highest, event) => Math.max(highest, event.seq), this.sinceSeq);
        return appended;
    }
}

function nextSeqFromEvents(events: FeedEvent[]): number {
    if (events.length === 0) {
        return 1;
    }

    const last = events[events.length - 1];
    return (last?.seq ?? 0) + 1;
}

function nextMessageIdFromEvents(events: FeedEvent[]): string {
    let lastMessageId = 0;

    for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];

        if (e && e.type === "message") {
            lastMessageId = Number.parseInt(e.message_id, 16);
            break;
        }
    }

    const next = lastMessageId + 1;

    if (next > MAX_MESSAGE_ID) {
        throw new MessageIdExhaustedError();
    }

    return next.toString(16).padStart(4, "0");
}

function appendLine(path: string, event: FeedEvent): void {
    appendFileSync(path, `${SafeJSON.stringify(event, { strict: true })}\n`);
}

export class MessageIdExhaustedError extends Error {
    constructor() {
        super(`message_id space exhausted (>= ${MAX_MESSAGE_ID.toString(16)})`);
        this.name = "MessageIdExhaustedError";
    }
}

/**
 * Append a non-message event (registered/logged_in/logged_out/stale_lock_reaped).
 * Allocates seq + ts under the single feed lock — no separate counters file.
 */
export async function appendFeed(paths: SessionPaths, event: NonMessageInput): Promise<FeedEvent> {
    const appended = await appendFeedWhen(paths, () => event);

    if (!appended) {
        throw new Error("appendFeed: the event was dropped");
    }

    return appended;
}

/**
 * Append the event `build` returns for the feed as it is under the feed lock, or nothing when it returns null.
 * The decision and the write happen under one lock, so no other writer can change the feed in between.
 */
export async function appendFeedWhen(
    paths: SessionPaths,
    build: (existing: readonly FeedEvent[]) => NonMessageInput | null
): Promise<FeedEvent | null> {
    const [appended] = await appendFeedEvents(paths, (existing) => {
        const event = build(existing);
        return event ? [event] : [];
    });

    return appended ?? null;
}

/**
 * Append the events `build` returns for the feed as it is under the feed lock, in order and with consecutive
 * seqs. Nothing else is written between the read and the last of them.
 */
export async function appendFeedEvents(
    paths: SessionPaths,
    build: (existing: readonly FeedEvent[]) => NonMessageInput[]
): Promise<FeedEvent[]> {
    return withFileLock(
        `${paths.feedPath}.lock`,
        async () => {
            ensureFeedFile(paths.feedPath);
            const existing = await readFeed(paths);
            let seq = nextSeqFromEvents(existing);
            const appended: FeedEvent[] = [];

            for (const event of build(existing)) {
                const fullEvent = { ...event, seq, ts: new Date().toISOString() } as unknown as FeedEvent;
                appendLine(paths.feedPath, fullEvent);
                appended.push(fullEvent);
                seq += 1;
            }

            return appended;
        },
        FEED_LOCK_TIMEOUT_MS
    );
}

/**
 * Append a message event. Allocates seq + message_id + ts under one lock.
 * message_id stays a separate 0001-based counter (not seq) so first message is
 * always "0001" regardless of how many lifecycle events precede it.
 */
export async function appendMessage(paths: SessionPaths, event: MessageEventInput): Promise<MessageEvent> {
    return withFileLock(
        `${paths.feedPath}.lock`,
        async () => {
            ensureFeedFile(paths.feedPath);
            const existing = await readFeed(paths);
            const seq = nextSeqFromEvents(existing);
            const messageId = nextMessageIdFromEvents(existing);
            const fullEvent: MessageEvent = {
                ...event,
                seq,
                ts: new Date().toISOString(),
                message_id: messageId,
            };
            appendLine(paths.feedPath, fullEvent);
            return fullEvent;
        },
        FEED_LOCK_TIMEOUT_MS
    );
}

/**
 * Read the feed under the lock and pass it to `fn`, which may decide to append
 * one or more events synthesized from the current state. Used for atomic
 * registration where derive-state + conflict-check + allocate-id + write must
 * be a single critical section.
 */
export async function withFeedLock<T>(
    paths: SessionPaths,
    fn: (helpers: {
        events: FeedEvent[];
        appendNonMessage: (event: NonMessageInput) => FeedEvent;
        appendMessageEvent: (event: MessageEventInput) => MessageEvent;
    }) => Promise<T> | T
): Promise<T> {
    return withFileLock(
        `${paths.feedPath}.lock`,
        async () => {
            ensureFeedFile(paths.feedPath);
            const events = await readFeed(paths);
            const appended: FeedEvent[] = [];

            const appendNonMessage = (event: NonMessageInput): FeedEvent => {
                const seq = nextSeqFromEvents([...events, ...appended]);
                const full = { ...event, seq, ts: new Date().toISOString() } as unknown as FeedEvent;
                appended.push(full);
                appendLine(paths.feedPath, full);
                return full;
            };

            const appendMessageEvent = (event: MessageEventInput): MessageEvent => {
                const all = [...events, ...appended];
                const seq = nextSeqFromEvents(all);
                const messageId = nextMessageIdFromEvents(all);
                const full: MessageEvent = {
                    ...event,
                    seq,
                    ts: new Date().toISOString(),
                    message_id: messageId,
                };
                appended.push(full);
                appendLine(paths.feedPath, full);
                return full;
            };

            return fn({ events, appendNonMessage, appendMessageEvent });
        },
        FEED_LOCK_TIMEOUT_MS
    );
}
