import type { LogEntry } from "@app/debugging-master/types";
import { SafeJSON } from "@app/utils/json";
import type { LogSourceId } from "@app/utils/log-viewer/log-source";
import { createSourceTailer, sessionKey } from "@app/utils/log-viewer/tail-bridge";

interface Subscriber {
    id: number;
    controller: ReadableStreamDefaultController<Uint8Array>;
    key: string;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

/**
 * Live log pub/sub keyed by `source:session`. Each session gets a single
 * FileTailer watching its JSONL file; new lines fan out to SSE subscribers.
 */
export class SSEBroadcaster {
    private subscribers = new Map<string, Set<Subscriber>>();
    private tailers = new Map<string, ReturnType<typeof createSourceTailer>>();
    private nextId = 1;
    private heartbeat: ReturnType<typeof setInterval> | null = null;

    subscribe(
        source: LogSourceId,
        sessionName: string
    ): { stream: ReadableStream<Uint8Array>; unsubscribe: () => void } {
        const key = sessionKey(source, sessionName);
        const id = this.nextId++;
        let sub: Subscriber;

        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                sub = { id, controller, key };
                let bucket = this.subscribers.get(key);
                if (!bucket) {
                    bucket = new Set();
                    this.subscribers.set(key, bucket);
                }
                bucket.add(sub);

                this.ensureTailer(source, sessionName, key);
                controller.enqueue(encoder.encode(`event: hello\ndata: {"sub":${id},"source":"${source}"}\n\n`));
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

    publishCleared(source: LogSourceId, sessionName: string): void {
        const key = sessionKey(source, sessionName);
        const bucket = this.subscribers.get(key);
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

    subscriberCount(key?: string): number {
        if (key !== undefined) {
            return this.subscribers.get(key)?.size ?? 0;
        }

        let total = 0;
        for (const bucket of this.subscribers.values()) {
            total += bucket.size;
        }
        return total;
    }

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

    private ensureTailer(source: LogSourceId, sessionName: string, key: string): void {
        if (this.tailers.has(key)) {
            return;
        }

        const tailer = createSourceTailer(source, sessionName, (entry, index) => {
            this.fanOut(key, entry, index);
        });
        tailer.start();
        this.tailers.set(key, tailer);
    }

    private fanOut(key: string, entry: LogEntry, entryIndex: number): void {
        const bucket = this.subscribers.get(key);
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
        const bucket = this.subscribers.get(sub.key);
        if (!bucket) {
            return;
        }

        bucket.delete(sub);
        if (bucket.size === 0) {
            this.subscribers.delete(sub.key);
            const tailer = this.tailers.get(sub.key);
            if (tailer) {
                tailer.stop();
                this.tailers.delete(sub.key);
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

export const sseBroadcaster = new SSEBroadcaster();
