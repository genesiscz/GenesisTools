import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { HourGroup } from "@/features/activity-timeline/components/HourGroup";
import { useTimeline } from "@/features/activity-timeline/hooks";
import { groupByHour } from "@/features/activity-timeline/units";
import { Empty } from "@/ui/Empty";
import { Loading } from "@/ui/Loading";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * The cross-source "today on this machine" feed: daemon runs + agent Q&A + terminal launches,
 * grouped into descending hour buckets. Composes the `useTimeline` hook (D32) → `groupByHour` →
 * a FlatList of `HourGroup`s. Loading/error/empty mirror the daemon screen.
 */
export function Timeline() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const query = useTimeline();

    if (query.isPending) {
        return <Loading testID="timeline-loading" label="Loading activity…" />;
    }

    if (query.isError) {
        return (
            <View testID="timeline-error" className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6">
                <Text className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                    Timeline unavailable
                </Text>
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {query.error instanceof Error ? query.error.message : "Could not reach the agent."}
                </Text>
            </View>
        );
    }

    const groups = groupByHour(query.data ?? []);

    return (
        <FlatList
            testID="timeline-list"
            data={groups}
            keyExtractor={(group) => group.hourKey}
            contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            ListHeaderComponent={
                <View className="gap-4 pb-2">
                    <MockBadge />
                    <SectionHeader title="Today on this machine" />
                </View>
            }
            renderItem={({ item }) => <HourGroup group={item} />}
            ListEmptyComponent={
                <Empty
                    testID="timeline-empty"
                    title="Nothing happened yet today"
                    hint="Runs, Q&A, and terminals will appear here."
                />
            }
        />
    );
}
