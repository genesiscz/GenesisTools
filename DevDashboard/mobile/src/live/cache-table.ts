import type { AgentsBoardDto, LiveChannel, LiveFrameOf, PortInfo, PortsRes } from "@dd/contract";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { agentsKeys, BOARD_INTERVAL_MS, withPhase, withPhases } from "@/features/agents/queries";
import { answerQueueKeys, QUEUE_INTERVAL_MS } from "@/features/answer-queue/queries";
import { claudeUsageKeys, USAGE_INTERVAL_MS } from "@/features/claude-usage/queries";
import { attentionKeys } from "@/features/needs-input-inbox/queries";
import { PORTS_INTERVAL_MS, portKillerKeys } from "@/features/port-killer/queries";
import { pulseKeys, SNAP_INTERVAL_MS } from "@/features/pulse/queries";
import { QA_LOG_INTERVAL_MS } from "@/features/qa/queries";

/**
 * What one live channel does to the phone's query cache (M4). `apply` writes a value frame into its query, or
 * invalidates the queries a notice names. `resync` lists the queries refetched when a connection opens: a notice
 * channel has no snapshot, so whatever changed while the phone was away is only seen by refetching.
 * `fallbackMs` is the poll a screen falls back to while the channel is not live (the stream is down, the tier cannot
 * stream, or the app just came back); `null` means the channel replaces no poll.
 *
 * Method syntax on purpose: it lets the table's per-channel rows stand in for the union row the dispatcher uses.
 */
export interface LiveCacheRow<C extends LiveChannel> {
    apply(frame: LiveFrameOf<C>, queryClient: QueryClient): void;
    resync: readonly QueryKey[];
    fallbackMs: number | null;
}

export type LiveCacheTable = { [C in LiveChannel]: LiveCacheRow<C> };

function portKey(p: PortInfo): string {
    return `${p.pid}:${p.port}:${p.proto}`;
}

/** Merges a classify batch into the port list the phone holds; nothing to merge into before the first list. */
export function mergeClassify(prev: PortsRes | undefined, updates: PortInfo[]): PortsRes | undefined {
    if (!prev) {
        return prev;
    }

    const byKey = new Map(updates.map((p) => [portKey(p), p]));
    return { ...prev, ports: prev.ports.map((p) => byKey.get(portKey(p)) ?? p) };
}

function invalidate(queryClient: QueryClient, keys: readonly QueryKey[]): void {
    for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey });
    }
}

/** The Q→A log under every filter, and the attention inbox that counts unread action entries. */
const QA_KEYS: readonly QueryKey[] = [["qa", "log"], attentionKeys.list];
/** The waiting set holds both the open decisions and the pending ask forms. */
const WAITING_KEYS: readonly QueryKey[] = [answerQueueKeys.queue];

/**
 * One row per channel; the mapped type makes a channel added to the contract's `LiveChannelFrames` fail to compile
 * until it has a row here.
 */
export const LIVE_CACHE_TABLE: LiveCacheTable = {
    ports: {
        apply(frame, queryClient) {
            if (frame.type === "snapshot") {
                queryClient.setQueryData<PortsRes>(portKillerKeys.list, frame.payload);
                return;
            }

            queryClient.setQueryData<PortsRes>(portKillerKeys.list, (prev) => mergeClassify(prev, frame.payload.ports));
        },
        resync: [],
        fallbackMs: PORTS_INTERVAL_MS,
    },
    pulse: {
        apply(frame, queryClient) {
            queryClient.setQueryData(pulseKeys.snap, frame.payload);
        },
        resync: [],
        fallbackMs: SNAP_INTERVAL_MS,
    },
    // The phone reads the claude-only usage route, a different shape from the all-provider cache the frame carries,
    // so the frame says "changed" and the query refetches.
    "ai-usage": {
        apply(_frame, queryClient) {
            invalidate(queryClient, [claudeUsageKeys.usage]);
        },
        resync: [],
        fallbackMs: USAGE_INTERVAL_MS,
    },
    qa: {
        apply(_frame, queryClient) {
            invalidate(queryClient, QA_KEYS);
        },
        resync: QA_KEYS,
        fallbackMs: QA_LOG_INTERVAL_MS,
    },
    decisions: {
        apply(_frame, queryClient) {
            invalidate(queryClient, WAITING_KEYS);
        },
        resync: WAITING_KEYS,
        fallbackMs: QUEUE_INTERVAL_MS,
    },
    pending: {
        apply(_frame, queryClient) {
            invalidate(queryClient, WAITING_KEYS);
        },
        resync: [],
        fallbackMs: QUEUE_INTERVAL_MS,
    },
    // No phone screen reads handoffs yet.
    handoffs: {
        apply() {},
        resync: [],
        fallbackMs: null,
    },
    // The agents board (F9): a phase frame patches its session; a snapshot patches every session, or refetches the
    // board when a session started or ended (the frame carries phases, not the project, prompt and sub-agents).
    agents: {
        apply(frame, queryClient) {
            const board = queryClient.getQueryData<AgentsBoardDto>(agentsKeys.board);
            const next =
                frame.type === "phase" ? withPhase(board, frame.payload) : withPhases(board, frame.payload.sessions);

            if (next) {
                queryClient.setQueryData(agentsKeys.board, next);
            }

            invalidate(queryClient, [agentsKeys.board]);
        },
        resync: [agentsKeys.board],
        fallbackMs: BOARD_INTERVAL_MS,
    },
};

export function rowOf<C extends LiveChannel>(table: LiveCacheTable, channel: C): LiveCacheRow<C> {
    return table[channel];
}
