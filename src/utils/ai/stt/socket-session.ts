import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { LiveSttSession, LiveTranscriptEvent, SttProviderId } from "./types";

const prof = profiler.scope("stt");
const log = logger.child({ component: "ai-stt" });

/** Queue-before-open cap: 30 s of 16 kHz s16le mono is about 960 KB. */
const MAX_QUEUED_BYTES = 1_000_000;
const MAX_RECONNECTS = 1;
const CLOSE_GRACE_MS = 1_500;

/**
 * What one cloud provider contributes. Everything else (queueing, the event iterator, abort,
 * reconnect, logging, profiling) is shared here so the providers stay small enough to compare
 * against their docs line by line.
 */
export interface SocketSpec {
    provider: SttProviderId;
    url: string;
    headers: Record<string, string>;
    /** Messages sent right after `open`, before any audio. */
    hello?: () => Array<string | Uint8Array>;
    /** Turn one PCM frame into the wire message(s). */
    frame: (pcm: Uint8Array) => Array<string | Uint8Array>;
    /** Tell the provider no more audio follows. */
    finish?: () => Array<string | Uint8Array>;
    /** Periodic message while idle; undefined when the provider needs none. */
    keepAlive?: { intervalMs: number; message: () => string };
    /** Map one inbound text frame to zero or more events. `null` = ignore. */
    parse: (raw: string, nowMs: number) => LiveTranscriptEvent[] | LiveTranscriptEvent | null;
    /** Do not send audio before this returns true for some inbound message (xAI `transcript.created`). */
    readyWhen?: (raw: string) => boolean;
}

class EventChannel {
    private readonly buffer: LiveTranscriptEvent[] = [];
    private waiter: ((value: IteratorResult<LiveTranscriptEvent>) => void) | null = null;
    private done = false;

    push(event: LiveTranscriptEvent): void {
        if (this.done) {
            return;
        }

        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve({ value: event, done: false });
            return;
        }

        this.buffer.push(event);
    }

    end(): void {
        this.done = true;
        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;
            resolve({ value: undefined as never, done: true });
        }
    }

    async *iterate(): AsyncGenerator<LiveTranscriptEvent> {
        while (true) {
            const next = this.buffer.shift();
            if (next) {
                yield next;
                continue;
            }

            if (this.done) {
                return;
            }

            const result = await new Promise<IteratorResult<LiveTranscriptEvent>>((resolve) => {
                this.waiter = resolve;
            });
            if (result.done) {
                return;
            }

            yield result.value;
        }
    }
}

export function openSocketSession(options: {
    spec: SocketSpec;
    accountId: string;
    signal?: AbortSignal;
}): Promise<LiveSttSession> {
    const { spec } = options;
    const channel = new EventChannel();
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let socket: WebSocket | null = null;
    let ready = false;
    let closedByUs = false;
    let finished = false;
    let reconnects = 0;
    let audioBytes = 0;
    let eventCount = 0;
    let firstPartialStop: (() => void) | null = null;
    let sessionStop: (() => void) | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    const host = new URL(spec.url).host;

    const send = (message: string | Uint8Array): void => {
        // A fresh Uint8Array is backed by a plain ArrayBuffer, which is what the socket's
        // BufferSource parameter accepts; a subarray view over a shared buffer is not.
        socket?.send(typeof message === "string" ? message : new Uint8Array(message));
    };

    const flushPending = (): void => {
        for (const frame of pending) {
            for (const message of spec.frame(frame)) {
                send(message);
            }
        }

        pending.length = 0;
        pendingBytes = 0;
    };

    const stopKeepAlive = (): void => {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
    };

    const finishChannel = (): void => {
        stopKeepAlive();
        sessionStop?.();
        sessionStop = null;
        log.info({ provider: spec.provider, host, audioBytes, eventCount, reconnects }, "live STT session ended");
        channel.end();
    };

    const connect = (): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            const stopConnect = prof.start("connect");
            log.info(
                { provider: spec.provider, host, accountId: options.accountId, attempt: reconnects + 1 },
                "opening live STT socket"
            );
            // Bun accepts `{ headers }` at runtime; the bundled lib types only know the protocols
            // overload, so the repo's WebSocket clients (XAIClient.ts:43) pass the options as never.
            const ws = new WebSocket(spec.url, { headers: spec.headers } as never);
            socket = ws;
            ready = spec.readyWhen === undefined;
            let settled = false;

            ws.addEventListener("open", () => {
                stopConnect();
                settled = true;
                sessionStop ??= prof.start("session");
                for (const message of spec.hello?.() ?? []) {
                    send(message);
                }

                if (ready) {
                    flushPending();
                }

                if (spec.keepAlive) {
                    keepAliveTimer = setInterval(
                        () => send(spec.keepAlive?.message() ?? ""),
                        spec.keepAlive.intervalMs
                    );
                }

                resolve();
            });

            ws.addEventListener("message", (message) => {
                const raw = typeof message.data === "string" ? message.data : String(message.data);
                if (!ready && spec.readyWhen?.(raw)) {
                    ready = true;
                    log.debug({ provider: spec.provider }, "provider signalled ready; flushing queued audio");
                    flushPending();
                }

                let parsed: LiveTranscriptEvent[] | LiveTranscriptEvent | null;
                try {
                    parsed = spec.parse(raw, Date.now());
                } catch (error) {
                    log.debug({ error, provider: spec.provider, raw: raw.slice(0, 200) }, "unparseable STT frame");
                    return;
                }

                const events = parsed === null ? [] : Array.isArray(parsed) ? parsed : [parsed];
                for (const event of events) {
                    eventCount++;
                    if (event.kind === "partial" && firstPartialStop) {
                        firstPartialStop();
                        firstPartialStop = null;
                    }

                    if (event.kind === "error") {
                        log.warn({ provider: spec.provider, error: event.error }, "live STT provider error");
                    }

                    channel.push(event);
                }
            });

            ws.addEventListener("error", (event) => {
                log.warn({ provider: spec.provider, host, event: String(event) }, "live STT socket error");
                if (!settled) {
                    settled = true;
                    stopConnect();
                    reject(new Error(`${spec.provider} live STT socket failed to connect to ${host}`));
                }
            });

            ws.addEventListener("close", (event) => {
                stopKeepAlive();
                log.info(
                    { provider: spec.provider, code: event.code, reason: event.reason, closedByUs, finished },
                    "live STT socket closed"
                );
                if (!settled) {
                    settled = true;
                    stopConnect();
                    reject(new Error(`${spec.provider} live STT socket closed before open (${event.code})`));
                    return;
                }

                if (closedByUs || finished || options.signal?.aborted) {
                    finishChannel();
                    return;
                }

                if (reconnects < MAX_RECONNECTS && audioBytes > 0) {
                    reconnects++;
                    log.warn({ provider: spec.provider, reconnects }, "live STT socket dropped; reconnecting once");
                    connect().catch((error) => {
                        channel.push({
                            kind: "error",
                            text: "",
                            isFinal: false,
                            startedAtMs: Date.now(),
                            error: error instanceof Error ? error.message : String(error),
                        });
                        finishChannel();
                    });
                    return;
                }

                channel.push({
                    kind: "error",
                    text: "",
                    isFinal: false,
                    startedAtMs: Date.now(),
                    error: `socket closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`,
                });
                finishChannel();
            });
        });

    const close = async (): Promise<void> => {
        if (closedByUs) {
            return;
        }

        closedByUs = true;
        const ws = socket;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, "client done");
            await Promise.race([
                new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true })),
                Bun.sleep(CLOSE_GRACE_MS),
            ]);
        }

        finishChannel();
    };

    options.signal?.addEventListener("abort", () => {
        log.info({ provider: spec.provider }, "live STT session aborted by signal");
        void close();
    });

    firstPartialStop = prof.start("first-partial");

    return connect().then(() => ({
        provider: spec.provider,
        accountId: options.accountId,
        write(pcm: Uint8Array) {
            audioBytes += pcm.byteLength;
            if (ready && socket?.readyState === WebSocket.OPEN) {
                for (const message of spec.frame(pcm)) {
                    send(message);
                }

                return;
            }

            if (pendingBytes + pcm.byteLength > MAX_QUEUED_BYTES) {
                log.warn({ provider: spec.provider, pendingBytes }, "dropping queued audio: socket not ready");
                return;
            }

            pending.push(pcm);
            pendingBytes += pcm.byteLength;
        },
        end() {
            if (finished) {
                return;
            }

            finished = true;
            flushPending();
            for (const message of spec.finish?.() ?? []) {
                send(message);
            }
        },
        events: () => channel.iterate(),
        close,
    }));
}
