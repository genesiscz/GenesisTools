import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnswerQueueHeader, useAnswerQueueState } from "@/features/answer-queue/components/AnswerQueue";
import { QueueSessionCard } from "@/features/answer-queue/components/QueueSessionCard";
import { KeptEditsContext } from "@/features/answer-queue/hooks";
import { AttentionList } from "@/features/needs-input-inbox/components/AttentionList";
import { useAttention, useResolveAttention } from "@/features/needs-input-inbox/hooks";
import { Loading } from "@/ui/Loading";
import { useThemeColors } from "@/theme/colors";

/**
 * Needs-Input Inbox screen — the curated "what needs me right now" queue. On top, the answer queue
 * (F6): decisions and ask forms grouped by session, with the notch widget's count. Below, the
 * attention list: today's unread `action` QA entries and live agent ttyd sessions. Tapping a
 * question resolves it (mark read → drops out); tapping an agent session jumps to its live terminal.
 *
 * Consumes ONLY the feature hooks (D32). Uses a bare `View` root + one `SectionList` for both parts: the queue's
 * session cards are rows, so only the cards on screen mount. The root wraps the list so Appium must gate on the count
 * child, not the root.
 */
export function NeedsInputInboxScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const attention = useAttention();
    const resolve = useResolveAttention();
    const answerQueue = useAnswerQueueState();

    const items = attention.data?.items ?? [];

    // The answer queue reads its own route, so it stays mounted in the one scrolling list whatever the attention
    // list does: loading and failure show beneath it, never in its place.
    const status =
        attention.isLoading && items.length === 0 ? (
            <Loading testID="needs-input-inbox-loading" label="Loading inbox…" />
        ) : attention.isError && items.length === 0 ? (
            <View className="gap-2">
                <Text
                    testID="needs-input-inbox-error"
                    className="text-base font-bold"
                    style={{ color: c.danger, fontFamily: "monospace" }}
                >
                    Inbox unavailable
                </Text>
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {attention.error instanceof Error ? attention.error.message : "Could not reach the agent."}
                </Text>
            </View>
        ) : undefined;

    return (
        <View testID="screen-needs-input-inbox" className="flex-1 bg-dd-bg-base" style={{ paddingTop: insets.top + 8 }}>
            <KeptEditsContext.Provider value={answerQueue.kept}>
                <AttentionList
                    header={<AnswerQueueHeader state={answerQueue} />}
                    sessions={answerQueue.sessions}
                    renderSession={(session) => (
                        <QueueSessionCard session={session} onReceipt={answerQueue.onReceipt} />
                    )}
                    items={items}
                    onResolve={(qaId) => resolve.mutate(qaId)}
                    status={status}
                />
            </KeptEditsContext.Provider>
        </View>
    );
}
