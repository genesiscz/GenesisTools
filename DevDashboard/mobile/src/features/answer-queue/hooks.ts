import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { createContext, type Dispatch, type SetStateAction, useContext, useEffect, useState } from "react";
import { useDashboardClient } from "@/api/client-provider";
import {
    answerForm,
    answerQueueKeys,
    answerQueueQuery,
    type SendStagedInput,
    type StageInput,
    sendStaged,
    stagePick,
} from "@/features/answer-queue/queries";
import { type KeptEdits, keptEdits, keptOr, type Receipt } from "@/features/answer-queue/units";

/**
 * Component-facing answer-queue hooks (D32). Every write invalidates the queue, so a staged pick shows as staged and
 * a sent session drops out on the next read. The idempotency key rides in the variables, so TanStack's retry of the
 * same action sends the same key and the Mac answers it once.
 */

/**
 * The queue polls only while its screen is focused: each poll is a full inbox gather on the Mac (and a sealed relay
 * round trip on the managed tier), and a tab screen stays mounted after the user leaves it.
 */
export function useAnswerQueue() {
    const focused = useIsFocused();
    const options = answerQueueQuery(useDashboardClient());
    return useQuery({ ...options, refetchInterval: focused ? options.refetchInterval : false });
}

/**
 * `onDone` runs on the mutation itself, not on one `mutate` call, so it still runs when the card that sent the write
 * has left the queue; it runs before the invalidation that removes that card.
 */
function useQueueWrite<V, R>(
    write: (client: ReturnType<typeof useDashboardClient>, variables: V) => Promise<R>,
    onDone?: (result: R) => void
) {
    const client = useDashboardClient();
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: (variables: V) => write(client, variables),
        onSuccess: (result) => onDone?.(result),
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: answerQueueKeys.queue });
        },
    });
}

export function useStagePick() {
    return useQueueWrite((client, input: StageInput) => stagePick(client, input));
}

export function useSendStaged(onReceipt?: (receipt: Receipt) => void) {
    return useQueueWrite(
        (client, input: SendStagedInput) => sendStaged(client, input),
        onReceipt
    );
}

export function useAnswerForm(onReceipt?: (receipt: Receipt) => void) {
    return useQueueWrite((client, input: Parameters<typeof answerForm>[1]) => answerForm(client, input), onReceipt);
}

/** The screen's kept edits (`KeptEdits`); the Needs Input screen provides one for as long as it is mounted. */
export const KeptEditsContext = createContext<KeptEdits>(keptEdits());

/**
 * `useState` whose value outlives the card: it starts from the kept edit for `key` and writes every change back, so a
 * card the list unmounted while scrolling comes back with what the user typed.
 */
export function useKeptState<T>(
    pick: (kept: KeptEdits) => Map<string, T>,
    key: string,
    init: () => T
): [T, Dispatch<SetStateAction<T>>] {
    const map = pick(useContext(KeptEditsContext));
    const [value, setValue] = useState<T>(() => keptOr(map, key, init));

    useEffect(() => {
        map.set(key, value);
    }, [map, key, value]);

    return [value, setValue];
}
