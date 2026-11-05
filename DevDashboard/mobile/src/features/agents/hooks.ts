import type {
    AgentBoardSession,
    AgentInterruptReceiptDto,
    AgentSendReceiptDto,
    AgentSendTiming,
    AgentStopReceiptDto,
} from "@dd/contract";
import { onlineManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardClient } from "@/api/client-provider";
import {
    addDraft,
    type DraftStore,
    flushDrafts,
    isOfflineError,
    kvDraftStore,
    removeDraft,
    type SteerDraft,
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
 * Component-facing agents hooks (D32). The board is written by the live `agents` channel while the stream is up
 * (phase frames patch it, a start or an end refetches it) and polls only while it is not.
 */
export function useAgentsBoard() {
    const refetchInterval = useLiveRefetchInterval("agents");
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

/** What the composer shows after a send: the Mac's receipt, or the draft that waits for the connection. */
export type SteerResult =
    | { kind: "receipt"; receipt: AgentSendReceiptDto }
    | { kind: "waiting"; draft: SteerDraft }
    | { kind: "failed"; error: string };

/**
 * The steer composer of one session (F10). A send goes to the Mac at once; when the phone is offline, or the Mac does
 * not answer, the message becomes a draft in the outbox and is sent again, with the same key, when the connection
 * returns (`onlineManager`) or the composer mounts. Drafts of every session flush together, oldest first.
 */
export function useSteerComposer(sessionKey: string, store: DraftStore = kvDraftStore) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();
    const [drafts, setDrafts] = useState<SteerDraft[]>([]);
    const [result, setResult] = useState<SteerResult | null>(null);
    const [sending, setSending] = useState(false);
    const flushing = useRef(false);

    const reload = useCallback(async () => {
        setDrafts((await store.read()).filter((draft) => draft.key === sessionKey));
    }, [store, sessionKey]);

    const send = useCallback(
        (draft: SteerDraft) =>
            sendToSession(client, { key: draft.key, text: draft.text, timing: draft.timing, idempotencyKey: draft.id }),
        [client]
    );

    const flush = useCallback(async () => {
        if (flushing.current || !onlineManager.isOnline()) {
            return;
        }

        flushing.current = true;

        try {
            const flushed = await flushDrafts({ store, send });
            const mine = flushed.sent.find((entry) => entry.draft.key === sessionKey);

            if (mine) {
                setResult({ kind: "receipt", receipt: mine.receipt });
                void queryClient.invalidateQueries({ queryKey: agentsKeys.transcript(sessionKey) });
            }
        } finally {
            flushing.current = false;
            await reload();
        }
    }, [store, send, sessionKey, queryClient, reload]);

    useEffect(() => {
        void reload().then(flush);
        const unsubscribeOnline = onlineManager.subscribe((online) => {
            if (online) {
                void flush();
            }
        });
        const unsubscribeRecovery = queryClient.getQueryCache().subscribe((event) => {
            if (event.type === "updated" && event.action.type === "success" && event.query.queryKey[0] === "agents") {
                void flush();
            }
        });
        return () => {
            unsubscribeOnline();
            unsubscribeRecovery();
        };
    }, [reload, flush, queryClient]);

    const submit = useCallback(
        async (text: string, timing: AgentSendTiming) => {
            const draft: SteerDraft = {
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
                    return;
                }

                const receipt = await send(draft);
                setResult({ kind: "receipt", receipt });
                void queryClient.invalidateQueries({ queryKey: agentsKeys.transcript(sessionKey) });
            } catch (error) {
                if (isOfflineError(error)) {
                    await addDraft(store, { ...draft, attempts: 1, lastError: String(error) });
                    setResult({ kind: "waiting", draft });
                    return;
                }

                setResult({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
            } finally {
                setSending(false);
                await reload();
            }
        },
        [sessionKey, store, send, queryClient, reload]
    );

    const discard = useCallback(
        async (id: string) => {
            await removeDraft(store, id);
            await reload();
        },
        [store, reload]
    );

    return { drafts, result, sending, submit, discard, flush, clearResult: () => setResult(null) };
}

/** Ends a session's running turn with its TUI's Esc key (F19). */
export function useInterruptSession(onReceipt?: (receipt: AgentInterruptReceiptDto) => void) {
    const client = useDashboardClient();

    return useMutation({
        mutationFn: (key: string) => interruptSession(client, { key, idempotencyKey: idempotencyKey() }),
        onSuccess: (receipt) => onReceipt?.(receipt),
    });
}
