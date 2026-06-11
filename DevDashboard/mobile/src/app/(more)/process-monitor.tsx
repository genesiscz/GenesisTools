import { Stack } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ProcessTable } from "@/features/process-monitor/components/ProcessTable";
import { useKillProcess, useProcesses } from "@/features/process-monitor/hooks";
import type { ProcessSort } from "@/features/process-monitor/types";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { useThemeColors } from "@/theme/colors";

/**
 * Process Monitor screen — the full, sortable, killable process list (not just Pulse's top-5). Owns
 * the `sort` state (RSS / Name); the toggle drives a real server refetch (sort is in the query key).
 * Loading / error / empty branches mirror containers.tsx; the table + per-row Kill confirm live in
 * the feature components. Kill goes through `useKillProcess` (invalidates both sort caches on success
 * → the row leaves on the next poll under a real Agent).
 */
export default function ProcessMonitorScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const [sort, setSort] = useState<ProcessSort>("rss");
    const query = useProcesses(sort);
    const killMutation = useKillProcess();

    const handleKill = (pid: number) => {
        killMutation.mutate({ pid });
    };

    if (query.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Process Monitor" }} />
                <View
                    testID="screen-process-monitor"
                    accessibilityLabel="screen-process-monitor"
                    className="flex-1 items-center justify-center bg-dd-bg-base"
                >
                    <View testID="process-monitor-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading processes…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (query.isError || !query.data) {
        return (
            <>
                <Stack.Screen options={{ title: "Process Monitor" }} />
                <View
                    testID="screen-process-monitor"
                    accessibilityLabel="screen-process-monitor"
                    className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
                >
                    <Text
                        testID="process-monitor-error"
                        className="text-base font-bold"
                        style={{ color: c.danger, fontFamily: "monospace" }}
                    >
                        Processes unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {query.error instanceof Error ? query.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    const processes = query.data.processes;

    if (processes.length === 0) {
        return (
            <>
                <Stack.Screen options={{ title: "Process Monitor" }} />
                <View
                    testID="screen-process-monitor"
                    accessibilityLabel="screen-process-monitor"
                    className="flex-1 bg-dd-bg-base"
                >
                    <Empty testID="process-monitor-empty" title="No processes" />
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Process Monitor" }} />
            <ScrollView
                testID="screen-process-monitor"
                accessibilityLabel="screen-process-monitor"
                className="flex-1 bg-dd-bg-base"
                contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            >
                <MockBadge />
                <ProcessTable processes={processes} sort={sort} onSortChange={setSort} onKill={handleKill} />
            </ScrollView>
        </>
    );
}
