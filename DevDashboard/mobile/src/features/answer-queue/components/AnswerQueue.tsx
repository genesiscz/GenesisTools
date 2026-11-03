import { Text, View } from "react-native";
import { QueueSessionCard } from "@/features/answer-queue/components/QueueSessionCard";
import { useAnswerQueue } from "@/features/answer-queue/hooks";
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

    return (
        <View testID="answer-queue" className="gap-3 pb-4">
            <View className="flex-row items-center justify-between">
                <SectionHeader title="Waiting for you" />
                <StatusPill testID="answer-queue-count" label={`${queue.data?.total ?? 0}`} tone="accent" normalCase />
            </View>
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
                <QueueSessionCard key={session.sessionId ?? session.items[0]?.id ?? "form"} session={session} />
            ))}
        </View>
    );
}
