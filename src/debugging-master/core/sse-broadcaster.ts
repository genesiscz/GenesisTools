import { homedir } from "node:os";
import { join } from "node:path";
import { FileTailer } from "@app/debugging-master/core/file-tailer";
import type { LogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";

interface Subscriber {
    id: number;
    controller: ReadableStreamDefaultController<Uint8Array>;
    sessionName: string;
}

const HEARTBEAT_INTERVAL_MS = 25_000;
const SESSIONS_DIR = join(homedir(), ".genesis-tools", "debugging-master", "sessions");
const encoder = new TextEncoder();

/**
 * Live log pub/sub. Each session gets a single `FileTailer` watching its
 * JSONL file; new lines fan out to all SSE subscribers on that session.
 * Watching the file (not the in-process write path) means it works whether
 * ingest comes from this process or another — useful when the dashboard
 * runs on a different port from the ingest server.
 */
export class SSEBroadcaster {
    private subscribers = new Map<string, Set<Subscriber>>();
    private tailers = new Map<string, FileTailer>();
    private nextId = 1;
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    /**
     * Open a new SSE stream for the given session. The returned `ReadableStream`
     * should be handed to a `Response` with `Content-Type: text/event-stream`.
     */
    subscribe(sessionName: string): { stream: ReadableStream<Uint8Array>; unsubscribe: () => void } {
        const id = this.nextId++;
        let sub: Subscriber;

        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                sub = { id, controller, sessionName };
                let bucket = this.subscribers.get(sessionName);
                if (!bucket) {
                    bucket = new Set();
                    this.subscribers.set(sessionName, bucket);
                }
                bucket.add(sub);

                this.ensureTailer(sessionName);
                controller.enqueue(encoder.encode(`event: hello\ndata: {"sub":${id}}\n\n`));
                this.ensureHeartbeat();
            },
            cancel: () => {
                this.removeSubscriber(sub);
            },
        });

        const unsubscribe = (): void => {
            this.removeSubscriber(sub);
            try {
                sub.controller.close();
            } catch {
                // already closed
            }
        };

        return { stream, unsubscribe };
    }

    /**
     * Notify all subscribers on a session that its log file was cleared.
     * Frontend should reset its local entries / expanded / fresh state.
     */
    publishCleared(sessionName: string): void {
        const bucket = this.subscribers.get(sessionName);
        if (!bucket || bucket.size === 0) {
            return;
        }
        const frame = encoder.encode("event: cleared\ndata: {}\n\n");
        for (const sub of [...bucket]) {
            try {
                sub.controller.enqueue(frame);
            } catch {
                this.removeSubscriber(sub);
            }
        }
    }

    /** Number of active subscribers (across all sessions, or for a specific session). */
    subscriberCount(sessionName?: string): number {
        if (sessionName !== undefined) {
            return this.subscribers.get(sessionName)?.size ?? 0;
        }

        let total = 0;
        for (const bucket of this.subscribers.values()) {
            total += bucket.size;
        }
        return total;
    }

    /** Stop heartbeats, file watchers, and drop all state. Test helper. */
    reset(): void {
        for (const bucket of this.subscribers.values()) {
            for (const sub of bucket) {
                try {
                    sub.controller.close();
                } catch {
                    // already closed
                }
            }
        }
        this.subscribers.clear();
        for (const tailer of this.tailers.values()) {
            tailer.stop();
        }
        this.tailers.clear();
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    private ensureTailer(sessionName: string): void {
        if (this.tailers.has(sessionName)) {
            return;
        }
        const path = join(SESSIONS_DIR, `${sessionName}.jsonl`);
        const tailer = new FileTailer(path, {
            onEntry: (entry, index) => this.fanOut(sessionName, entry, index),
        });
        tailer.start();
        this.tailers.set(sessionName, tailer);
    }

    private fanOut(sessionName: string, entry: LogEntry, entryIndex: number): void {
        const bucket = this.subscribers.get(sessionName);
        if (!bucket || bucket.size === 0) {
            return;
        }

        const payload = SafeJSON.stringify({ ...entry, index: entryIndex });
        const frame = encoder.encode(`event: entry\ndata: ${payload}\n\n`);

        for (const sub of [...bucket]) {
            try {
                sub.controller.enqueue(frame);
            } catch {
                this.removeSubscriber(sub);
            }
        }
    }

    private removeSubscriber(sub: Subscriber): void {
        const bucket = this.subscribers.get(sub.sessionName);
        if (!bucket) {
            return;
        }

        bucket.delete(sub);
        if (bucket.size === 0) {
            this.subscribers.delete(sub.sessionName);
            const tailer = this.tailers.get(sub.sessionName);
            if (tailer) {
                tailer.stop();
                this.tailers.delete(sub.sessionName);
            }
        }
        if (this.subscribers.size === 0 && this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }
    }

    private ensureHeartbeat(): void {
        if (this.heartbeat) {
            return;
        }

        this.heartbeat = setInterval(() => {
            const ping = encoder.encode(`: ping\n\n`);
            for (const bucket of this.subscribers.values()) {
                for (const sub of [...bucket]) {
                    try {
                        sub.controller.enqueue(ping);
                    } catch {
                        this.removeSubscriber(sub);
                    }
                }
            }
        }, HEARTBEAT_INTERVAL_MS);
        this.heartbeat.unref?.();
    }
}

/** Process-wide broadcaster. */
export const sseBroadcaster = new SSEBroadcaster();
