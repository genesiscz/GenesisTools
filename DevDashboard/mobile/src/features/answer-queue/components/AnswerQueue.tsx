import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ReceiptLine } from "@/features/answer-queue/components/ReceiptLine";
import { useAnswerQueue } from "@/features/answer-queue/hooks";
import { keptEdits, pruneKept, type RecentReceipt, withRecentReceipt } from "@/features/answer-queue/units";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * The answer queue's state, shared by its header and its session rows in the Needs Input list: the queue read, the
 * recent receipts and the cards' kept edits. The rows are list items (virtualized), so this lives in the screen, not
 * in a card: a send removes its card on the next read, and its receipt must stay until it is read.
 */
export function useAnswerQueueState() {
    const queue = useAnswerQueue();
    const [recent, setRecent] = useState<RecentReceipt[]>([]);
    const onReceipt = useCallback((entry: RecentReceipt) => setRecent((list) => withRecentReceipt(list, entry)), []);
    const dismiss = useCallback(
        (testID: string) => setRecent((list) => list.filter((kept) => kept.testID !== testID)),
        []
    );
    // A card that scrolls far away unmounts; what the user typed in it stays here until its item leaves the queue.
    const [kept] = useState(keptEdits);
    const data = queue.data;

    useEffect(() => {
        // Only a successful read prunes: a failed poll keeps the last data, and never drops a note being typed.
        if (data) {
            pruneKept(kept, data.sessions);
        }
    }, [kept, data]);

    return { queue, sessions: data?.sessions ?? [], recent, onReceipt, dismiss, kept };
}

export type AnswerQueueState = ReturnType<typeof useAnswerQueueState>;

/**
 * The answer queue's header (F6): the notch widget's count, the recent receipts, and the loading, error or empty
 * line. Its session cards are the rows below it in the same list.
 */
export function AnswerQueueHeader({ state }: { state: AnswerQueueState }) {
    const c = useThemeColors();
    const { queue, sessions, recent, dismiss } = state;

    return (
        <View testID="answer-queue" className="gap-3">
            <View className="flex-row items-center justify-between">
                <SectionHeader title="Waiting for you" />
                <StatusPill testID="answer-queue-count" label={`${queue.data?.total ?? 0}`} tone="accent" normalCase />
            </View>
            {recent.map((entry) => (
                <View key={entry.testID} className="flex-row items-center gap-2">
                    <Text className="flex-1 text-xs" numberOfLines={1} style={{ color: c.textMuted }}>
                        {entry.label}
                    </Text>
                    <ReceiptLine testID={entry.testID} receipt={entry.receipt} />
                    <Pressable
                        testID={`${entry.testID}-dismiss`}
                        accessibilityRole="button"
                        accessibilityLabel={`Dismiss the receipt of ${entry.label}`}
                        onPress={() => dismiss(entry.testID)}
                        className="min-h-11 min-w-11 items-center justify-center px-2"
                    >
                        <Text className="text-xs" style={{ color: c.textSecondary }}>
                            Dismiss
                        </Text>
                    </Pressable>
                </View>
            ))}
            {queue.isLoading && sessions.length === 0 ? (
                <Text testID="answer-queue-loading" className="text-xs" style={{ color: c.textMuted }}>
                    Loading the queue…
                </Text>
            ) : null}
            {queue.isError && sessions.length === 0 ? (
                <Text testID="answer-queue-error" className="text-xs" style={{ color: c.danger }}>
                    {queue.error instanceof Error ? queue.error.message : "Could not read the queue."}
                </Text>
            ) : null}
            {queue.isSuccess && sessions.length === 0 ? (
                <Text testID="answer-queue-empty" className="text-xs" style={{ color: c.textMuted }}>
                    No decision or ask form waits for you.
                </Text>
            ) : null}
        </View>
    );
}
