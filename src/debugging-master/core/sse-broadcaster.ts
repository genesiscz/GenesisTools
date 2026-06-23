import type { LogEntry } from "@app/debugging-master/types";
import { startWakefulInterval, type WakefulInterval } from "@app/utils/async";
import { SafeJSON } from "@app/utils/json";
import type { LogSourceId } from "@app/utils/log-viewer/log-source";
import { parseSessionKey } from "@app/utils/log-viewer/session-key";
import { createSourceTailer, sessionKey } from "@app/utils/log-viewer/tail-bridge";
import { resetTaskUiTailer, stopTaskUiTailer } from "@app/utils/log-viewer/task-ui-lines";

interface Subscriber {
    id: number;
    controller: ReadableStreamDefaultController<Uint8Array>;
    key: string;
}

interface MultiplexSubscriber {
    id: number;
    controller: ReadableStreamDefaultController<Uint8Array>;
    keys: Set<string>;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();

/**
 * Live log pub/sub keyed by `source:session`. Each session gets a single
 * FileTailer watching its JSONL file; new lines fan out to SSE subscribers.
 */
export class SSEBroadcaster {
    private subscribers = new Map<string, Set<Subscriber>>();
    private multiplexSubscribers = new Set<MultiplexSubscriber>();
    private tailers = new Map<string, ReturnType<typeof createSourceTailer>>();
    private nextId = 1;
    private heartbeat: WakefulInterval | null = null;

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

    subscribeActive(targets: ReadonlyArray<{ source: LogSourceId; sessionName: string }>): {
        stream: ReadableStream<Uint8Array>;
        unsubscribe: () => void;
    } {
        const keys = new Set(targets.map((t) => sessionKey(t.source, t.sessionName)));
        const id = this.nextId++;
        let sub: MultiplexSubscriber;

        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                sub = { id, controller, keys };
                this.multiplexSubscribers.add(sub);

                for (const target of targets) {
                    const key = sessionKey(target.source, target.sessionName);
                    this.ensureTailer(target.source, target.sessionName, key);
                }

                const hello = SafeJSON.stringify({
                    sub: id,
                    scope: "active",
                    sessions: targets.map((t) => ({ source: t.source, session: t.sessionName })),
                });
                controller.enqueue(encoder.encode(`event: hello\ndata: ${hello}\n\n`));
                this.ensureHeartbeat();
            },
            cancel: () => {
                this.removeMultiplexSubscriber(sub);
            },
        });

        const unsubscribe = (): void => {
            this.removeMultiplexSubscriber(sub);
            try {
                sub.controller.close();
            } catch {
                // already closed
            }
        };

        return { stream, unsubscribe };
    }

    publishRemoved(source: LogSourceId, sessionName: string): void {
        const key = sessionKey(source, sessionName);
        const payload = SafeJSON.stringify({ source, session: sessionName });
        const frame = encoder.encode(`event: removed\ndata: ${payload}\n\n`);

        this.broadcastFrame(key, frame);

        const tailer = this.tailers.get(key);
        if (tailer) {
            tailer.stop();
            this.tailers.delete(key);
        }

        const parsed = parseSessionKey(key);
        if (parsed?.source === "task") {
            stopTaskUiTailer(key);
        }

        this.subscribers.delete(key);

        // Drop the key from each multiplex sub, and reap any whose key set
        // is now empty — otherwise they linger forever, the 15s heartbeat
        // keeps pinging them, and `subscribers.size === 0` will never let
        // the heartbeat shut down even when no live consumer remains.
        for (const sub of [...this.multiplexSubscribers]) {
            sub.keys.delete(key);
            if (sub.keys.size === 0) {
                this.removeMultiplexSubscriber(sub);
                try {
                    sub.controller.close();
                } catch {
                    // already closed
                }
            }
        }
    }

    publishCleared(source: LogSourceId, sessionName: string): void {
        const key = sessionKey(source, sessionName);
        this.tailers.get(key)?.resetAfterClear();

        const payload = SafeJSON.stringify({ source, session: sessionName });
        const frame = encoder.encode(`event: cleared\ndata: ${payload}\n\n`);

        this.broadcastFrame(key, frame);
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
        for (const sub of this.multiplexSubscribers) {
            try {
                sub.controller.close();
            } catch {
                // already closed
            }
        }
        this.multiplexSubscribers.clear();
        for (const tailer of this.tailers.values()) {
            tailer.stop();
        }
        this.tailers.clear();
        if (this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
        }
    }

    private ensureTailer(source: LogSourceId, sessionName: string, key: string): void {
        if (this.tailers.has(key)) {
            return;
        }

        const tailer = createSourceTailer(
            source,
            sessionName,
            (entry, index) => {
                this.fanOut(key, entry, index);
            },
            () => {
                if (source === "task") {
                    resetTaskUiTailer(key, sessionName);
                }

                this.publishCleared(source, sessionName);
            }
        );
        tailer.start();
        this.tailers.set(key, tailer);
    }

    private fanOut(key: string, entry: LogEntry, entryIndex: number): void {
        const bucket = this.subscribers.get(key);

        if (bucket && bucket.size > 0) {
            const payload = SafeJSON.stringify({ ...entry, index: entryIndex });
            const frame = encoder.encode(`event: entry\ndata: ${payload}\n\n`);

            this.broadcastFrame(key, frame);
        }

        this.fanOutMultiplex(key, entry, entryIndex);
    }

    private broadcastFrame(key: string, frame: Uint8Array): void {
        const bucket = this.subscribers.get(key);

        if (bucket) {
            for (const sub of [...bucket]) {
                try {
                    sub.controller.enqueue(frame);
                } catch {
                    this.removeSubscriber(sub);
                }
            }
        }

        for (const sub of [...this.multiplexSubscribers]) {
            if (!sub.keys.has(key)) {
                continue;
            }

            try {
                sub.controller.enqueue(frame);
            } catch {
                this.removeMultiplexSubscriber(sub);
            }
        }
    }

    private fanOutMultiplex(key: string, entry: LogEntry, entryIndex: number): void {
        if (this.multiplexSubscribers.size === 0) {
            return;
        }

        const parsed = parseSessionKey(key);
        if (!parsed) {
            return;
        }

        const payload = SafeJSON.stringify({
            source: parsed.source,
            session: parsed.name,
            ...entry,
            index: entryIndex,
        });
        const frame = encoder.encode(`event: entry\ndata: ${payload}\n\n`);

        for (const sub of [...this.multiplexSubscribers]) {
            if (!sub.keys.has(key)) {
                continue;
            }

            try {
                sub.controller.enqueue(frame);
            } catch {
                this.removeMultiplexSubscriber(sub);
            }
        }
    }

    private removeMultiplexSubscriber(sub: MultiplexSubscriber): void {
        const keys = [...sub.keys];
        this.multiplexSubscribers.delete(sub);

        for (const key of keys) {
            this.stopTailerIfUnreferenced(key);
        }

        if (this.subscribers.size === 0 && this.multiplexSubscribers.size === 0 && this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
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
            this.stopTailerIfUnreferenced(sub.key);
        }

        if (this.subscribers.size === 0 && this.multiplexSubscribers.size === 0 && this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
        }
    }

    private stopTailerIfUnreferenced(key: string): void {
        const bucket = this.subscribers.get(key);
        if (bucket && bucket.size > 0) {
            return;
        }

        if (this.isKeyReferencedByMultiplex(key)) {
            return;
        }

        const tailer = this.tailers.get(key);
        if (tailer) {
            tailer.stop();
            this.tailers.delete(key);
        }

        const parsed = parseSessionKey(key);
        if (parsed?.source === "task") {
            stopTaskUiTailer(key);
        }
    }

    private isKeyReferencedByMultiplex(key: string): boolean {
        for (const sub of this.multiplexSubscribers) {
            if (sub.keys.has(key)) {
                return true;
            }
        }

        return false;
    }

    private ensureHeartbeat(): void {
        if (this.heartbeat) {
            return;
        }

        this.heartbeat = startWakefulInterval(
            HEARTBEAT_INTERVAL_MS,
            () => {
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

                for (const sub of [...this.multiplexSubscribers]) {
                    try {
                        sub.controller.enqueue(ping);
                    } catch {
                        this.removeMultiplexSubscriber(sub);
                    }
                }
            },
            { leading: false }
        );
    }
}

export const sseBroadcaster = new SSEBroadcaster();
