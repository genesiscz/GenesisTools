import type { RunSummary } from "@dd/contract";
import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DaemonStatusHeader } from "@/features/daemon/components/DaemonStatusHeader";
import { RunLogSheet } from "@/features/daemon/components/RunLogSheet";
import { RunRow } from "@/features/daemon/components/RunRow";
import { useDaemonRuns, useDaemonStatus } from "@/features/daemon/hooks";
import { Card } from "@/ui/Card";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Daemon screen — install/run status + recent runs (tap a run to view its structured log). Composes
 * feature components off the per-feature `useDaemonStatus`/`useDaemonRuns` hooks (D32 — never raw
 * useQuery). Parity with the web daemon view (status + runs + log viewer).
 */
export default function DaemonScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const statusQuery = useDaemonStatus();
    const runsQuery = useDaemonRuns();
    const [openRun, setOpenRun] = useState<RunSummary | null>(null);

    const runs = runsQuery.data ?? [];

    if (statusQuery.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Daemon" }} />
                <View testID="screen-daemon" accessibilityLabel="screen-daemon" className="flex-1 items-center justify-center bg-dd-bg-base">
                    <View testID="daemon-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading daemon…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (statusQuery.isError || !statusQuery.data) {
        return (
            <>
                <Stack.Screen options={{ title: "Daemon" }} />
                <View testID="screen-daemon" accessibilityLabel="screen-daemon" className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6">
                    <Text testID="daemon-error" className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                        Daemon unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {statusQuery.error instanceof Error ? statusQuery.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Daemon" }} />
            <View testID="screen-daemon" accessibilityLabel="screen-daemon" className="flex-1 bg-dd-bg-base">
                <FlatList
                    testID="daemon-runs-list"
                    data={runs}
                    keyExtractor={(run) => run.runId}
                    contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 12 }}
                    ListHeaderComponent={
                        <View className="gap-4 pb-2">
                            <MockBadge />
                            <DaemonStatusHeader overview={statusQuery.data} />
                            <SectionHeader title="Recent runs" />
                        </View>
                    }
                    renderItem={({ item }) => <RunRow run={item} onPress={setOpenRun} />}
                    ListEmptyComponent={
                        <Card testID="daemon-runs-empty">
                            <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>No recorded runs yet.</Text>
                        </Card>
                    }
                />

                <RunLogSheet run={openRun} onClose={() => setOpenRun(null)} />
            </View>
        </>
    );
}
