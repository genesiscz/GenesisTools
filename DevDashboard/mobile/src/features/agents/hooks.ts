import {
    type AgentBoardSession,
    type AgentInterruptReceiptDto,
    type AgentSendReceiptDto,
    type AgentSendTiming,
    type AgentStopReceiptDto,
    type DashboardClient,
    ENDPOINTS,
    type PingWatchesDto,
} from "@dd/contract";
import { hashKey, onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardClient, useDashboardConnectionId } from "@/api/client-provider";
import {
    addDraft,
    type DraftStore,
    type FlushResult,
    flushDrafts,
    isOfflineError,
    kvDraftStore,
    removeDraft,
    type SteerDraft,
    updateDrafts,
} from "@/features/agents/outbox";
import {
    agentsKeys,
    boardQuery,
    interruptSession,
    sendToSession,
    stopSession,
    transcriptQuery,
} from "@/features/agents/queries";
import { idempotencyKey } from "@/features/answer-queue/units";
import { useLiveRefetchInterval } from "@/live/provider";

/**
 * How often the board is read again while the live channel is up. Its frames carry phases only, so a new prompt,
 * title, account or sub-agent that comes without a phase change would otherwise stay stale for as long as the
 * stream holds.
 */
export const BOARD_METADATA_MS = 60_000;

/** The board's poll: the channel's fallback while the stream is down, the slow metadata refresh while it is live. */
export function boardRefetchInterval(liveInterval: number | false): number {
    return liveInterval === false ? BOARD_METADATA_MS : liveInterval;
}

/**
 * Component-facing agents hooks (D32). The board is written by the live `agents` channel while the stream is up
 * (phase frames patch it, a start or an end refetches it) and polls at the channel's fallback while it is not.
 */
export function useAgentsBoard() {
    const refetchInterval = boardRefetchInterval(useLiveRefetchInterval("agents"));
    return useQuery({ ...boardQuery(useDashboardClient()), refetchInterval });
}

/** One session's row from the board cache, so the session view follows the same live phase. */
export function useBoardSession(key: string): AgentBoardSession | undefined {
    const board = useAgentsBoard();
    return board.data?.sessions.find((session) => session.key === key);
}

/** The newest turns of a session, tailed while its screen is focused. */
export function useAgentTranscript(session: Pick<AgentBoardSession, "key" | "sessionId" | "provider">) {
    const focused = useIsFocused();
    const options = transcriptQuery(useDashboardClient(), session);
    return useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
}

/** Ends a session's process tree on the Mac. The board refetches after, so a stopped session leaves it. */
export function useStopSession(onReceipt?: (receipt: AgentStopReceiptDto) => void) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (input: { key: string; pid: number; idempotencyKey: string }) => stopSession(client, input),
        onSuccess: (receipt) => onReceipt?.(receipt),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentsKeys.board });
        },
    });
}

const pingsKey = ["agents", "pings"] as const;

/** How often the ping watches are read while the session screen is focused. */
export const PINGS_INTERVAL_MS = 30_000;

/**
 * "Ping me when done" (F15) for one session. The Mac drops a watch by itself when the turn ends, so the watches are
 * read again while the screen is focused and whenever the session's phase changes; a tap then registers a new watch
 * instead of removing one the Mac already consumed.
 */
export function usePingWatch(session: AgentBoardSession) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();
    const focused = useIsFocused();
    const pings = useQuery({
        queryKey: pingsKey,
        queryFn: () => client.call(ENDPOINTS.gatewayPings, {}),
        refetchInterval: focused ? PINGS_INTERVAL_MS : false,
    });
    const phase = useRef(session.label);

    useEffect(() => {
        if (phase.current === session.label) {
            return;
        }

        phase.current = session.label;
        void queryClient.invalidateQueries({ queryKey: pingsKey });
    }, [session.label, queryClient]);

    const watched = pings.data?.watches.some((watch) => watch.key === session.key) ?? false;
    const toggle = useMutation({
        mutationFn: (): Promise<PingWatchesDto> =>
            watched
                ? client.call(ENDPOINTS.pingUnwatch, { key: session.key }, { idempotencyKey: idempotencyKey() })
                : client.call(
                      ENDPOINTS.pingWatch,
                      { key: session.key, label: session.title ?? session.project ?? undefined },
                      { idempotencyKey: idempotencyKey() }
                  ),
        onSuccess: (next) => queryClient.setQueryData(pingsKey, next),
    });

    return { watched, loading: pings.isPending, toggle };
}

/** What the composer shows after a send: the Mac's receipt, or the draft that waits for the connection. */
export type SteerResult =
    | { kind: "receipt"; receipt: AgentSendReceiptDto }
    | { kind: "waiting"; draft: SteerDraft }
    | { kind: "failed"; error: string };

function sendDraft(client: DashboardClient, draft: SteerDraft): Promise<AgentSendReceiptDto> {
    return sendToSession(client, { key: draft.key, text: draft.text, timing: draft.timing, idempotencyKey: draft.id });
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface DrainEvent {
    store: DraftStore;
    connectionId: string;
    result: FlushResult;
}

const drainListeners = new Set<(event: DrainEvent) => void>();
/** Concurrent drains share one flush (`flushDrafts`); its result is announced once. */
const announced = new WeakSet<FlushResult>();

/**
 * Sends a connection's waiting drafts once, oldest first. It reads the outbox first and writes nothing when no draft
 * waits, so a board update costs one read. Every mounted composer hears the result and shows its own session's part.
 */
export async function drainOutbox(input: {
    store: DraftStore;
    connectionId: string;
    send: (draft: SteerDraft) => Promise<AgentSendReceiptDto>;
}): Promise<void> {
    if (!onlineManager.isOnline()) {
        return;
    }

    const drafts = await input.store.read();

    if (!drafts.some((draft) => draft.connectionId === input.connectionId && !draft.blocked)) {
        return;
    }

    const result = await flushDrafts(input);

    if (announced.has(result)) {
        return;
    }

    announced.add(result);

    for (const listener of drainListeners) {
        listener({ store: input.store, connectionId: input.connectionId, result });
    }
}

const boardHash = hashKey(agentsKeys.board);

/**
 * The connection's outbox drain: it sends waiting drafts when the phone comes online and whenever the board loads,
 * which is how a Mac that recovers while the phone stays online is noticed. Mounted once per connection session
 * (the tabs layout), so a draft saved in a session screen is still sent after the user leaves that screen.
 */
export function useOutboxDrain(store: DraftStore = kvDraftStore): void {
    const client = useDashboardClient();
    const connectionId = useDashboardConnectionId() ?? "fixture";
    const queryClient = useQueryClient();

    useEffect(() => {
        const drain = () => {
            drainOutbox({ store, connectionId, send: (draft) => sendDraft(client, draft) }).catch((error: unknown) => {
                console.warn(`[outbox] drain failed: ${messageOf(error)}`);
            });
        };

        drain();
        const unsubscribeOnline = onlineManager.subscribe((online) => {
            if (online) {
                drain();
            }
        });
        const unsubscribeRecovery = queryClient.getQueryCache().subscribe((event) => {
            if (event.type === "updated" && event.action.type === "success" && event.query.queryHash === boardHash) {
                drain();
            }
        });

        return () => {
            unsubscribeOnline();
            unsubscribeRecovery();
        };
    }, [client, connectionId, queryClient, store]);
}

/**
 * The steer composer of one session (F10). A send goes to the Mac at once; when the phone is offline, or the Mac does
 * not answer, the message becomes a draft in the outbox, and the connection's drain (`useOutboxDrain`) sends it again
 * with the same key. The composer drains once when it mounts and shows what any drain did for its session.
 */
export function useSteerComposer(sessionKey: string, store: DraftStore = kvDraftStore) {
    const connectionId = useDashboardConnectionId() ?? "fixture";
    const client = useDashboardClient();
    const queryClient = useQueryClient();
    const [drafts, setDrafts] = useState<SteerDraft[]>([]);
    const [result, setResult] = useState<SteerResult | null>(null);
    const [sending, setSending] = useState(false);

    const reload = useCallback(async () => {
        setDrafts((await store.read()).filter((draft) => draft.connectionId === connectionId && draft.key === sessionKey));
    }, [store, sessionKey, connectionId]);

    const send = useCallback((draft: SteerDraft) => sendDraft(client, draft), [client]);
    const flush = useCallback(() => drainOutbox({ store, send, connectionId }), [store, send, connectionId]);

    useEffect(() => {
        const onDrain = (event: DrainEvent) => {
            if (event.store !== store || event.connectionId !== connectionId) {
                return;
            }

            const mine = event.result.sent.find((entry) => entry.draft.key === sessionKey);

            if (mine) {
                setResult({ kind: "receipt", receipt: mine.receipt });
                void queryClient.invalidateQueries({ queryKey: agentsKeys.transcript(sessionKey) });
            }

            const failed = event.result.failed.find((entry) => entry.draft.key === sessionKey);

            if (failed) {
                setResult({ kind: "failed", error: failed.error });
            }

            void reload();
        };

        drainListeners.add(onDrain);
        // A composer opened straight from a link drains too, in case the connection's drain is not mounted.
        void reload().then(flush);

        return () => {
            drainListeners.delete(onDrain);
        };
    }, [store, connectionId, sessionKey, queryClient, reload, flush]);

    const submit = useCallback(
        async (text: string, timing: AgentSendTiming) => {
            const draft: SteerDraft = {
                connectionId,
                id: idempotencyKey(),
                key: sessionKey,
                text,
                timing,
                createdAt: Date.now(),
                attempts: 0,
                lastError: null,
            };
            setSending(true);

            try {
                if (!onlineManager.isOnline()) {
                    await addDraft(store, { ...draft, lastError: "offline" });
                    setResult({ kind: "waiting", draft });
                    return true;
                }

                let receipt: AgentSendReceiptDto;

                try {
                    receipt = await send(draft);
                } catch (error) {
                    if (!isOfflineError(error)) {
                        setResult({ kind: "failed", error: messageOf(error) });
                        return false;
                    }

                    await addDraft(store, { ...draft, attempts: 1, lastError: String(error) });
                    setResult({ kind: "waiting", draft });
                    return true;
                }

                setResult({ kind: "receipt", receipt });
                void queryClient.invalidateQueries({ queryKey: agentsKeys.transcript(sessionKey) });

                if (receipt.outcome === "unknown") {
                    await addDraft(store, {
                        ...draft,
                        blocked: true,
                        attempts: 1,
                        lastError: `Check the session before retrying: ${receipt.detail}`,
                    });
                    return true;
                }

                return receipt.outcome !== "refused";
            } catch (error) {
                // Only the phone's own outbox reaches this catch: a send's failure is classified above. The text
                // stays in the composer, and a message of uncertain delivery is never saved as one to resend.
                setResult({ kind: "failed", error: `Not saved on the phone: ${messageOf(error)}` });
                return false;
            } finally {
                setSending(false);
                await reload();
            }
        },
        [sessionKey, store, send, queryClient, reload, connectionId]
    );

    const retry = useCallback(
        async (id: string) => {
            await updateDrafts(store, (current) =>
                current.map((draft) =>
                    draft.id === id && draft.connectionId === connectionId ? { ...draft, blocked: false } : draft
                )
            );
            await flush();
            await reload();
        },
        [store, connectionId, flush, reload]
    );

    const discard = useCallback(
        async (id: string) => {
            await removeDraft(store, id);
            await reload();
        },
        [store, reload]
    );

    return { drafts, result, sending, submit, discard, retry, flush, clearResult: () => setResult(null) };
}

/** Ends a session's running turn with its TUI's Esc key (F19). */
export function useInterruptSession(onReceipt?: (receipt: AgentInterruptReceiptDto) => void) {
    const client = useDashboardClient();

    return useMutation({
        mutationFn: (key: string) => interruptSession(client, { key, idempotencyKey: idempotencyKey() }),
        onSuccess: (receipt) => onReceipt?.(receipt),
    });
}
