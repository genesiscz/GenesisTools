import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AnswerQueue } from "@/features/answer-queue/components/AnswerQueue";
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
 * Consumes ONLY the feature hooks (D32). Uses a bare `View` root + a `FlatList` (like the QA screen)
 * for the long list; the root wraps the FlatList so Appium must gate on the count child, not the root.
 */
export function NeedsInputInboxScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const attention = useAttention();
    const resolve = useResolveAttention();

    const items = attention.data?.items ?? [];

    if (attention.isLoading && items.length === 0) {
        return (
            <View testID="screen-needs-input-inbox" className="flex-1 bg-dd-bg-base">
                <Loading testID="needs-input-inbox-loading" label="Loading inbox…" />
            </View>
        );
    }

    if (attention.isError && items.length === 0) {
        // The answer queue reads its own route, so a failed attention list never hides it. It scrolls: a queue of
        // several cards is taller than the screen.
        return (
            <ScrollView
                testID="screen-needs-input-inbox"
                className="flex-1 bg-dd-bg-base"
                contentContainerStyle={{ gap: 8, padding: 24, paddingTop: insets.top + 8 }}
                keyboardShouldPersistTaps="handled"
            >
                <AnswerQueue />
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
            </ScrollView>
        );
    }

    return (
        <View testID="screen-needs-input-inbox" className="flex-1 bg-dd-bg-base" style={{ paddingTop: insets.top + 8 }}>
            <AttentionList
                header={<AnswerQueue />}
                items={items}
                onResolve={(qaId) => resolve.mutate(qaId)}
            />
        </View>
    );
}
