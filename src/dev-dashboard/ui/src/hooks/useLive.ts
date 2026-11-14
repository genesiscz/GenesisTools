import { paths } from "@app/dev-dashboard/contract/endpoints";
import type { LiveChannel, LiveDataFrame, LiveFrame } from "@app/dev-dashboard/lib/live/types";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { usePageVisible } from "@/hooks/usePageVisible";

function portKey(p: PortInfo): string {
    return `${p.pid}:${p.port}:${p.proto}`;
}

function mergeClassify(prev: PortsResult | undefined, updates: PortInfo[]): PortsResult | undefined {
    if (!prev) {
        return prev;
    }

    const map = new Map(updates.map((p) => [portKey(p), p]));
    return {
        ...prev,
        ports: prev.ports.map((p) => map.get(portKey(p)) ?? p),
    };
}

/**
 * What an `ai-usage` poll actually changes. `["ai"]` would also match
 * `["ai", "spend", …]`, whose answer comes from a transcript scan a poll cannot
 * affect (sweep 2026-09-04, N1).
 */
export const AI_USAGE_KEYS: ReadonlyArray<readonly string[]> = [
    ["ai", "usage"],
    ["ai", "accounts"],
    ["ai", "daemon"],
];

/**
 * Identity-free description of a subscription. Every caller passes a fresh array
 * literal, so the array itself changes on every render; the effect must key off
 * this string instead or it tears the stream down and rebuilds it each time.
 */
export function liveChannelsKey(channels: readonly LiveChannel[]): string {
    return channels.slice().sort().join(",");
}

export function channelsFromKey(key: string): LiveChannel[] {
    return key.split(",").filter(Boolean) as LiveChannel[];
}

/**
 * One multiplexed EventSource to `/api/live` per page, shared by every `useLive` (`LiveConnectionManager`). Merges
 * frames into React Query.
 *
 * The stream is open only while the page is visible and at least one channel is asked for.
 * The server runs a channel's producer (the ports `lsof` scan and its HTTP classify probes,
 * the pulse sampler, the AI usage poller) for as long as anyone subscribes, so a background
 * tab used to keep them all running. On return the stream reopens and the next producer tick
 * brings fresh data (at once when this tab is the only subscriber, since that restarts it).
 */
export interface LiveConnectionDeps {
    qc: QueryClient;
    connIdRef: { current: string | null };
    setConnId: (id: string | null) => void;
    setLastError: (message: string | null) => void;
    /** A fake in tests; the browser global otherwise. */
    EventSourceCtor?: typeof EventSource;
    /** Every data frame, before the built-in cache writes: for a caller that folds a channel itself. */
    onFrame?: (frame: LiveDataFrame) => void;
    /** `true` when the stream dropped, `false` once it delivers again. */
    onStatus?: (down: boolean) => void;
    /** A connection opened (its hello arrived): a notice channel's consumer refetches what it covers. */
    onOpen?: () => void;
}

/** What a caller of `useLive` adds to the built-in cache writes. Read through a ref, so a fresh closure is fine. */
export interface LiveListeners {
    onFrame?: (frame: LiveDataFrame) => void;
    onStatus?: (down: boolean) => void;
    /**
     * Each time a connection opens, the first one included. Channels without a snapshot (qa, decisions, handoffs) are
     * notices, and a client that was away (a hidden tab, a dropped network) missed the ones sent meanwhile, so the
     * live contract asks it to refetch everything the channel covers here.
     */
    onOpen?: () => void;
}

/**
 * The effect body of `useLive`, pulled out so a test can drive it without rendering the hook: a
 * fake `EventSourceCtor` stands in for the browser global, and the return value is the same
 * cleanup React would call. `visible` and `channelsKey === ""` both mean no connection: the
 * caller gets `undefined` back instead of a cleanup, exactly like the effect returning early.
 */
export function openLiveConnection(
    channelsKey: string,
    visible: boolean,
    deps: LiveConnectionDeps
): (() => void) | undefined {
    if (!visible || channelsKey === "") {
        return undefined;
    }

    const { qc, connIdRef, setConnId, setLastError } = deps;
    const ESCtor = deps.EventSourceCtor ?? EventSource;
    const es = new ESCtor(paths.live(channelsFromKey(channelsKey)));

    es.onmessage = (ev) => {
        deps.onStatus?.(false);

        try {
            const frame = SafeJSON.parse(ev.data, { strict: true }) as LiveFrame;

            if (frame.channel === "system" && frame.type === "hello") {
                connIdRef.current = frame.payload.connId;
                setConnId(frame.payload.connId);
                setLastError(null);
                deps.onOpen?.();
                return;
            }

            if (frame.channel === "system" && frame.type === "error") {
                setLastError(frame.payload.message);
                return;
            }

            if (frame.channel === "system") {
                return;
            }

            deps.onFrame?.(frame);

            if (frame.channel === "ports" && frame.type === "snapshot") {
                qc.setQueryData(["ports"], frame.payload);
                return;
            }

            if (frame.channel === "ports" && frame.type === "classify") {
                qc.setQueryData<PortsResult>(["ports"], (prev) => mergeClassify(prev, frame.payload.ports));
                return;
            }

            if (frame.channel === "pulse" && frame.type === "snapshot") {
                qc.setQueryData(["pulse", "snap"], frame.payload);
                return;
            }

            if (frame.channel === "ai-usage" && frame.type === "snapshot") {
                // A poll refreshes rate-limit windows and poller health, and
                // says nothing about recorded spend. Invalidating all of `ai`
                // sent the spend queries out a second time every cycle, and
                // each of those is a transcript scan.
                for (const key of AI_USAGE_KEYS) {
                    void qc.invalidateQueries({ queryKey: key });
                }

                return;
            }
        } catch {
            // ignore malformed
        }
    };

    es.onerror = () => {
        setLastError("live stream disconnected");
        deps.onStatus?.(true);
    };

    return () => {
        es.close();
        connIdRef.current = null;
        setConnId(null);
    };
}

/** One `useLive` call as the shared stream sees it. */
export interface LiveConsumer {
    channels: readonly LiveChannel[];
    /** Read at each frame, so the caller's latest closures run. */
    listeners: () => LiveListeners;
    setConnId: (id: string | null) => void;
    setLastError: (message: string | null) => void;
}

export interface LiveConnectionManagerDeps {
    qc: QueryClient;
    /** A fake in tests; the browser global otherwise. */
    EventSourceCtor?: typeof EventSource;
    /** Runs the reconcile after the registrations of one render; a microtask by default, a manual queue in tests. */
    schedule?: (run: () => void) => void;
}

/**
 * The one `/api/live` stream of a page. Every `useLive` registers its channels and listeners here; the stream carries
 * the union of their channels, and each data frame goes to the consumers that asked for its channel. A change of the
 * union reopens the stream with the new set, once per batch: the hooks of one render all register before it opens.
 * A consumer that joins a stream which already carries its channels gets no replay of their snapshots: it reads them
 * from the query cache the stream fills, or from its own fetch.
 */
export class LiveConnectionManager {
    private readonly consumers = new Set<LiveConsumer>();
    private readonly connIdRef: { current: string | null } = { current: null };
    private open: { key: string; close: () => void } | undefined;
    private scheduled = false;
    /** The open stream's last error and whether it is down, replayed to a consumer that joins it. */
    private lastError: string | null = null;
    private down = false;

    constructor(private readonly deps: LiveConnectionManagerDeps) {}

    /**
     * Adds a consumer; the returned function removes it. The stream follows on the next reconcile. A consumer that
     * joins an open stream gets its connection id, its last error and, when it is down, the down status at once.
     */
    register(consumer: LiveConsumer): () => void {
        this.consumers.add(consumer);
        this.notify(consumer, () => {
            consumer.setConnId(this.connIdRef.current);
            consumer.setLastError(this.lastError);

            if (this.down) {
                consumer.listeners().onStatus?.(true);
            }
        });
        this.schedule();

        return () => {
            this.consumers.delete(consumer);
            consumer.setConnId(null);
            this.schedule();
        };
    }

    private schedule(): void {
        if (this.scheduled) {
            return;
        }

        this.scheduled = true;
        (this.deps.schedule ?? queueMicrotask)(() => {
            this.scheduled = false;
            this.reconcile();
        });
    }

    private reconcile(): void {
        const key = liveChannelsKey([...new Set([...this.consumers].flatMap((consumer) => consumer.channels))]);

        if (key === (this.open?.key ?? "")) {
            return;
        }

        this.open?.close();
        this.open = undefined;
        this.lastError = null;
        this.down = false;
        const close = openLiveConnection(key, true, {
            qc: this.deps.qc,
            connIdRef: this.connIdRef,
            EventSourceCtor: this.deps.EventSourceCtor,
            setConnId: (id) => this.each((consumer) => consumer.setConnId(id)),
            setLastError: (message) => {
                this.lastError = message;
                this.each((consumer) => consumer.setLastError(message));
            },
            onFrame: (frame) =>
                this.each((consumer) => {
                    if (consumer.channels.includes(frame.channel)) {
                        consumer.listeners().onFrame?.(frame);
                    }
                }),
            onStatus: (down) => {
                this.down = down;
                this.each((consumer) => consumer.listeners().onStatus?.(down));
            },
            onOpen: () => this.each((consumer) => consumer.listeners().onOpen?.()),
        });

        if (close) {
            this.open = { key, close };
        }
    }

    /** Runs `run` for every consumer; one that throws is reported and the others, and the cache writes, still run. */
    private each(run: (consumer: LiveConsumer) => void): void {
        for (const consumer of [...this.consumers]) {
            this.notify(consumer, () => run(consumer));
        }
    }

    private notify(consumer: LiveConsumer, run: () => void): void {
        try {
            run();
        } catch (error) {
            console.error("[live] a consumer callback failed; the other consumers still get the frame", {
                channels: consumer.channels,
                error,
            });
        }
    }
}

/** One manager per query client, so the whole app (one client) shares one stream. */
const managers = new WeakMap<QueryClient, LiveConnectionManager>();

export function liveConnectionFor(qc: QueryClient): LiveConnectionManager {
    let manager = managers.get(qc);

    if (!manager) {
        manager = new LiveConnectionManager({ qc });
        managers.set(qc, manager);
    }

    return manager;
}

export function useLive(
    channels: LiveChannel[],
    listeners: LiveListeners = {}
): {
    connId: string | null;
    lastError: string | null;
} {
    const qc = useQueryClient();
    const [connId, setConnId] = useState<string | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);
    const channelsKey = liveChannelsKey(channels);
    const visible = usePageVisible();
    const listenersRef = useRef(listeners);
    listenersRef.current = listeners;

    useEffect(() => {
        if (!visible || channelsKey === "") {
            return undefined;
        }

        return liveConnectionFor(qc).register({
            channels: channelsFromKey(channelsKey),
            listeners: () => listenersRef.current,
            setConnId,
            setLastError,
        });
        // `channels` is deliberately absent: the array identity changes every
        // render, and depending on it reopened the stream about eight times a
        // second. `channelsKey` carries the same information and is stable.
    }, [channelsKey, qc, visible]);

    return { connId, lastError };
}
