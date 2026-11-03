import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { QueueSessionCard } from "@/features/answer-queue/components/QueueSessionCard";
import { ReceiptLine } from "@/features/answer-queue/components/ReceiptLine";
import { useAnswerQueue } from "@/features/answer-queue/hooks";
import { type RecentReceipt, withRecentReceipt } from "@/features/answer-queue/units";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

/**
 * The answer queue (F6): decisions and ask forms grouped by agent session, with the notch widget's count. Sits at
 * the top of the Needs Input screen; the attention list below it keeps the agent sessions and QA action items.
 */
export function AnswerQueue() {
    const c = useThemeColors();
    const queue = useAnswerQueue();
    const sessions = queue.data?.sessions ?? [];
    // Above the cards: a send removes its card on the next read, and its receipt must stay until it is read.
    const [recent, setRecent] = useState<RecentReceipt[]>([]);
    const onReceipt = useCallback((entry: RecentReceipt) => setRecent((list) => withRecentReceipt(list, entry)), []);

    return (
        <View testID="answer-queue" className="gap-3 pb-4">
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
                        onPress={() => setRecent((list) => list.filter((kept) => kept.testID !== entry.testID))}
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
            {sessions.map((session) => (
                <QueueSessionCard
                    key={session.sessionId ?? session.items[0]?.id ?? "form"}
                    session={session}
                    onReceipt={onReceipt}
                />
            ))}
        </View>
    );
}
