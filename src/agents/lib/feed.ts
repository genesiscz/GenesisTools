import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { readJsonlFile } from "@app/utils/log-session/jsonl-reader";
import { withFileLock } from "@app/utils/storage";
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
type NonMessageInput = Exclude<FeedEventInput, { type: "message" }>;
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
    return withFileLock(
        `${paths.feedPath}.lock`,
        async () => {
            ensureFeedFile(paths.feedPath);
            const existing = await readFeed(paths);
            const seq = nextSeqFromEvents(existing);
            const fullEvent = { ...event, seq, ts: new Date().toISOString() } as unknown as FeedEvent;
            appendLine(paths.feedPath, fullEvent);
            return fullEvent;
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
