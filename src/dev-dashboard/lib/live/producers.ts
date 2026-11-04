import type { AgentBoardPhaseRow } from "@app/dev-dashboard/contract/agents";
import { createHandoffStream } from "@app/dev-dashboard/lib/handoff-sse";
import { createAiUsageProducer } from "@app/dev-dashboard/lib/live/ai-usage-producer";
import type { LiveHub } from "@app/dev-dashboard/lib/live/hub";
import type { LiveChannel, LiveDataFrame } from "@app/dev-dashboard/lib/live/types";
import { classifyListeningPorts, listListeningPorts } from "@app/dev-dashboard/lib/ports/scanner";
import type { PortInfo, PortsResult } from "@app/dev-dashboard/lib/ports/types";
import { clipQaEntry } from "@app/dev-dashboard/lib/qa-clip";
import { createPendingStream } from "@app/dev-dashboard/lib/qa-pending-sse";
import { enrichQaEntry } from "@app/dev-dashboard/lib/qa-render";
import { createQaStream } from "@app/dev-dashboard/lib/qa-sse";
import { getCachedPulse, markPulseClientSeen } from "@app/dev-dashboard/lib/system/poller";
import { diffPhases } from "@app/hub/lib/board/phases";
import { decisionFiles } from "@app/question/lib/decisions/paths";
import { listPendingForms } from "@app/question/lib/pending/ask";
import { FileTailer } from "@genesiscz/utils/fs/file-tailer";
import { logger } from "@genesiscz/utils/logger";

const PORTS_INTERVAL_MS = 10_000;
const PULSE_INTERVAL_MS = 5_000;
const CLASSIFY_CHUNK = 8;
/**
 * The fleet view with the stuck verdict is safe every 15 s or slower (`readFleetView`): it reads `ps`, the cmux tree,
 * the journal and each live transcript's tail.
 */
const AGENTS_INTERVAL_MS = 15_000;
/**
 * How many waiting forms one snapshot carries (here, `/api/qa/stream` and `/api/qa/pending`). The store default is 50,
 * which silently hid the OLDEST pending forms once more than that were waiting: the newest 50 win the ORDER BY.
 */
export const PENDING_SNAPSHOT_LIMIT = 500;

/**
 * The work behind one live channel. The runner starts it when the channel's first subscriber arrives and stops it when
 * the last one leaves, so nothing scans or tails while nobody watches.
 *
 * - `start()` may publish the first value to every subscriber (there is exactly one at that moment).
 * - `snapshot()` answers a connection that joins a producer already running: the channel's current value, sent to that
 *   connection only. A notice channel (qa, decisions, handoffs) has none; its client refetches what it covers on open.
 */
export interface LiveProducer {
    start(): void;
    stop(): void;
    snapshot?(): Promise<LiveDataFrame[]>;
}

export type LiveProducerFactory = (hub: LiveHub) => LiveProducer;

function portKey(p: PortInfo): string {
    return `${p.pid}:${p.port}:${p.proto}`;
}

/** `lsof` every 10 s, then HTTP classify probes in chunks of 8. The snapshot is the last scan with its classify merged. */
export function createPortsProducer(hub: LiveHub): LiveProducer {
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;
    let current: PortsResult | null = null;

    function merge(updates: PortInfo[]): void {
        if (!current) {
            return;
        }

        const byKey = new Map(updates.map((p) => [portKey(p), p]));
        current = { ...current, ports: current.ports.map((p) => byKey.get(portKey(p)) ?? p) };
    }

    async function tick(): Promise<void> {
        if (busy || hub.subscriberCount("ports") === 0) {
            return;
        }

        busy = true;
        try {
            const result = await listListeningPorts();
            current = result;
            hub.publish({ v: 1, channel: "ports", type: "snapshot", payload: result });

            const pending = result.ports.filter((p) => p.probeStatus === "pending");
            for (let i = 0; i < pending.length; i += CLASSIFY_CHUNK) {
                if (hub.subscriberCount("ports") === 0) {
                    break;
                }

                const updated = await classifyListeningPorts(pending.slice(i, i + CLASSIFY_CHUNK));
                if (updated.length > 0) {
                    merge(updated);
                    hub.publish({ v: 1, channel: "ports", type: "classify", payload: { ports: updated } });
                }
            }
        } catch (err) {
            logger.debug({ err }, "live/producers: ports tick failed");
        } finally {
            busy = false;
        }
    }

    return {
        start() {
            if (timer) {
                return;
            }

            void tick();
            timer = setInterval(() => void tick(), PORTS_INTERVAL_MS);
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            current = null;
        },
        async snapshot() {
            return current ? [{ v: 1, channel: "ports", type: "snapshot", payload: current }] : [];
        },
    };
}

/** The pulse sampler's cached sample every 5 s; reading it also keeps the sampler awake. */
export function createPulseProducer(hub: LiveHub): LiveProducer {
    let timer: ReturnType<typeof setInterval> | null = null;

    function frames(): LiveDataFrame[] {
        markPulseClientSeen();
        const snap = getCachedPulse();
        return snap ? [{ v: 1, channel: "pulse", type: "snapshot", payload: snap }] : [];
    }

    function tick(): void {
        if (hub.subscriberCount("pulse") === 0) {
            return;
        }

        for (const frame of frames()) {
            hub.publish(frame);
        }
    }

    return {
        start() {
            if (timer) {
                return;
            }

            tick();
            timer = setInterval(tick, PULSE_INTERVAL_MS);
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        },
        async snapshot() {
            return frames();
        },
    };
}

/** Each new Q→A log line, enriched like `/api/qa/log` rows. A notice: the client keeps the persisted log. */
export function createQaProducer(hub: LiveHub): LiveProducer {
    let stream: ReturnType<typeof createQaStream> | null = null;

    return {
        start() {
            if (stream) {
                return;
            }

            try {
                stream = createQaStream((entry) => {
                    hub.publish({ v: 1, channel: "qa", type: "entry", payload: enrichQaEntry(clipQaEntry(entry)) });
                });
            } catch (err) {
                logger.debug({ err }, "live/producers: qa stream failed to start");
            }
        },
        stop() {
            stream?.close();
            stream = null;
        },
    };
}

interface DecisionEventLine {
    ev?: unknown;
    id?: unknown;
    ids?: unknown;
    ts?: unknown;
    state?: unknown;
}

/** Each line of the decision event log. A notice: the client refetches the waiting set it covers. */
export function createDecisionsProducer(hub: LiveHub, events = () => decisionFiles().events): LiveProducer {
    let tailer: FileTailer<DecisionEventLine> | null = null;

    return {
        start() {
            if (tailer) {
                return;
            }

            const path = events();
            // `create: false`: watching must not make the log; the tailer waits for the first decision to write it.
            tailer = new FileTailer<DecisionEventLine>(
                path,
                {
                    onLine: (line) => {
                        if (typeof line.ev !== "string") {
                            return;
                        }

                        hub.publish({
                            v: 1,
                            channel: "decisions",
                            type: "event",
                            payload: {
                                ev: line.ev,
                                ...(typeof line.id === "string" ? { id: line.id } : {}),
                                ...(Array.isArray(line.ids)
                                    ? { ids: line.ids.filter((id): id is string => typeof id === "string") }
                                    : {}),
                                ts: typeof line.ts === "string" ? line.ts : new Date().toISOString(),
                                ...(typeof line.state === "string" ? { state: line.state } : {}),
                            },
                        });
                    },
                },
                { create: false }
            );
            tailer.start();
            logger.debug({ path }, "live/producers: tailing the decision events");
        },
        stop() {
            tailer?.stop();
            tailer = null;
        },
    };
}

/**
 * The pending ask forms: the open set as a snapshot, then every lifecycle event. The tailer attaches before the set is
 * read, for the reason `/api/qa/stream` gives: an event between the two would otherwise be in neither.
 */
export function createPendingProducer(
    hub: LiveHub,
    listForms: () => ReturnType<typeof listPendingForms> = () => listPendingForms(undefined, PENDING_SNAPSHOT_LIMIT)
): LiveProducer {
    let stream: ReturnType<typeof createPendingStream> | null = null;

    function frames(): LiveDataFrame[] {
        return [{ v: 1, channel: "pending", type: "snapshot", payload: { forms: listForms() } }];
    }

    return {
        start() {
            if (stream) {
                return;
            }

            try {
                stream = createPendingStream((event) => {
                    hub.publish({
                        v: 1,
                        channel: "pending",
                        type: "event",
                        payload: { id: event.id, ev: event.ev, ts: event.ts, form: event.form },
                    });
                });

                for (const frame of frames()) {
                    hub.publish(frame);
                }
            } catch (err) {
                logger.debug({ err }, "live/producers: pending stream failed to start");
            }
        },
        stop() {
            stream?.close();
            stream = null;
        },
        async snapshot() {
            return frames();
        },
    };
}

/** Each handoff event, by id. A notice: the client fetches the handoff it names. */
export function createHandoffsProducer(hub: LiveHub): LiveProducer {
    let stream: { close(): void } | null = null;

    return {
        start() {
            if (stream) {
                return;
            }

            stream = createHandoffStream((event) => {
                hub.publish({
                    v: 1,
                    channel: "handoffs",
                    type: "event",
                    payload: { id: event.id, ev: event.ev, ts: event.ts },
                });
            });
        },
        stop() {
            stream?.close();
            stream = null;
        },
    };
}

async function readAgentPhasesNow(): Promise<AgentBoardPhaseRow[]> {
    const { readAgentPhases } = await import("@app/hub/lib/board/index");
    return readAgentPhases();
}

/**
 * The live agent sessions every 15 s: the whole set as a snapshot on the first read and whenever a session starts or
 * ends, else one `phase` frame per session whose phase, stalled flag, pid or stuck verdict changed. A joining
 * connection gets the last read; before the first read lands it gets nothing and its client refetches the board.
 */
export function createAgentsProducer(
    hub: LiveHub,
    read: () => Promise<AgentBoardPhaseRow[]> = readAgentPhasesNow
): LiveProducer & { refresh(): Promise<void> } {
    let timer: ReturnType<typeof setInterval> | null = null;
    let busy = false;
    let current: AgentBoardPhaseRow[] | null = null;

    async function tick(): Promise<void> {
        if (busy || hub.subscriberCount("agents") === 0) {
            return;
        }

        busy = true;
        try {
            const next = await read();
            const before = current;
            current = next;
            const diff = before ? diffPhases(before, next) : null;

            if (!diff || diff.membershipChanged) {
                hub.publish({ v: 1, channel: "agents", type: "snapshot", payload: { sessions: next } });
                return;
            }

            for (const row of diff.changed) {
                hub.publish({ v: 1, channel: "agents", type: "phase", payload: row });
            }
        } catch (err) {
            logger.debug({ err }, "live/producers: agents tick failed");
        } finally {
            busy = false;
        }
    }

    return {
        start() {
            if (timer) {
                return;
            }

            void tick();
            timer = setInterval(() => void tick(), AGENTS_INTERVAL_MS);
        },
        stop() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }

            current = null;
        },
        async snapshot() {
            return current ? [{ v: 1, channel: "agents", type: "snapshot", payload: { sessions: current } }] : [];
        },
        /** One read now, as the timer would run it (tests drive the producer with it). */
        refresh: tick,
    };
}

/**
 * One row per channel. `satisfies Record<LiveChannel, …>` makes a new channel in the contract's `LiveChannelFrames`
 * fail to compile until its row exists here.
 */
export const LIVE_PRODUCERS = {
    ports: createPortsProducer,
    pulse: createPulseProducer,
    "ai-usage": createAiUsageProducer,
    qa: createQaProducer,
    decisions: (hub) => createDecisionsProducer(hub),
    pending: (hub) => createPendingProducer(hub),
    handoffs: createHandoffsProducer,
    agents: (hub) => createAgentsProducer(hub),
} satisfies Record<LiveChannel, LiveProducerFactory>;

export type LiveProducerTable = Record<LiveChannel, LiveProducerFactory>;

export function isLiveChannel(s: string): s is LiveChannel {
    return Object.hasOwn(LIVE_PRODUCERS, s);
}

/**
 * Runs the table against the hub's demand: a producer starts on its channel's first subscriber, answers each later
 * subscriber with its snapshot, and stops on the last unsubscribe. A producer is built once and reused across runs.
 */
export function startLiveProducers(hub: LiveHub, table: LiveProducerTable = LIVE_PRODUCERS): { stop: () => void } {
    const producers = new Map<LiveChannel, LiveProducer>();

    function producerOf(channel: LiveChannel): LiveProducer {
        let producer = producers.get(channel);
        if (!producer) {
            producer = table[channel](hub);
            producers.set(channel, producer);
        }

        return producer;
    }

    async function sendSnapshot(producer: LiveProducer, channel: LiveChannel, connId: string): Promise<void> {
        try {
            for (const frame of (await producer.snapshot?.()) ?? []) {
                hub.publishTo(connId, frame);
            }
        } catch (err) {
            logger.debug({ err, channel }, "live/producers: snapshot failed");
        }
    }

    const unsubDemand = hub.onDemandChange((channel, delta, connId) => {
        const producer = producerOf(channel);
        const count = hub.subscriberCount(channel);

        if (delta === 1) {
            if (count === 1) {
                producer.start();
                return;
            }

            void sendSnapshot(producer, channel, connId);
            return;
        }

        if (count === 0) {
            producer.stop();
        }
    });

    return {
        stop: () => {
            unsubDemand();
            for (const producer of producers.values()) {
                producer.stop();
            }
        },
    };
}
