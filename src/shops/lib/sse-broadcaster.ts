import { logger } from "@app/logger";
import { startWakefulInterval, type WakefulInterval } from "@app/utils/async";
import { SafeJSON } from "@app/utils/json";

const HEARTBEAT_INTERVAL_MS = 15_000;
const encoder = new TextEncoder();
const log = logger.child({ component: "SseBroadcaster" });

interface Subscriber {
    id: number;
    controller: ReadableStreamDefaultController<Uint8Array>;
}

export class SseBroadcaster {
    private subscribers = new Set<Subscriber>();
    private nextId = 1;
    private heartbeat: WakefulInterval | null = null;

    subscribe(opts?: { initialEvents?: ReadonlyArray<{ event: string; data: unknown }> }): {
        stream: ReadableStream<Uint8Array>;
        unsubscribe: () => void;
    } {
        const id = this.nextId++;
        let sub!: Subscriber;
        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                sub = { id, controller };
                this.subscribers.add(sub);
                controller.enqueue(encoder.encode(`event: hello\ndata: {"sub":${id}}\n\n`));

                if (opts?.initialEvents) {
                    for (const ev of opts.initialEvents) {
                        const payload = SafeJSON.stringify(ev.data);
                        try {
                            controller.enqueue(encoder.encode(`event: ${ev.event}\ndata: ${payload}\n\n`));
                        } catch {
                            // controller closed mid-backfill; bail out, removeSubscriber handles cleanup
                            break;
                        }
                    }
                }
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

    publish(event: string, data: unknown): void {
        if (this.subscribers.size === 0) {
            return;
        }

        const payload = SafeJSON.stringify(data);
        const frame = encoder.encode(`event: ${event}\ndata: ${payload}\n\n`);
        for (const sub of [...this.subscribers]) {
            try {
                sub.controller.enqueue(frame);
            } catch (err) {
                log.debug({ subId: sub.id, error: err }, "subscriber controller closed; removing");
                this.removeSubscriber(sub);
            }
        }
    }

    subscriberCount(): number {
        return this.subscribers.size;
    }

    reset(): void {
        for (const sub of this.subscribers) {
            try {
                sub.controller.close();
            } catch {
                // already closed
            }
        }
        this.subscribers.clear();
        if (this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
        }
    }

    private removeSubscriber(sub: Subscriber): void {
        this.subscribers.delete(sub);
        if (this.subscribers.size === 0 && this.heartbeat) {
            this.heartbeat.stop();
            this.heartbeat = null;
        }
    }

    private ensureHeartbeat(): void {
        if (this.heartbeat) {
            return;
        }

        this.heartbeat = startWakefulInterval(
            HEARTBEAT_INTERVAL_MS,
            () => {
                const ping = encoder.encode(`: ping\n\n`);
                for (const sub of [...this.subscribers]) {
                    try {
                        sub.controller.enqueue(ping);
                    } catch {
                        this.removeSubscriber(sub);
                    }
                }
            },
            { leading: false }
        );
    }
}

export const sseBroadcaster = new SseBroadcaster();
