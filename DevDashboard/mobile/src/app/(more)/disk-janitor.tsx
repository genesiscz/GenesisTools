import { Stack } from "expo-router";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { UsageBars } from "@/features/disk-janitor/components/UsageBars";
import { useDiskUsage } from "@/features/disk-janitor/hooks";
import { usePulse } from "@/features/pulse/hooks";
import { gb } from "@/features/pulse/units";
import { Card } from "@/ui/Card";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { StatTile } from "@/ui/StatTile";
import { useThemeColors } from "@/theme/colors";

/**
 * Disk Janitor — ranked breakdown of the biggest dev dirs (node_modules / caches / build dirs),
 * headed by the Pulse disk-free StatTile for context. Read-only in v1 (no delete). Drills the single
 * Pulse disk gauge into a per-directory ranking from GET /api/disk/usage. Composes the feature-local
 * `UsageBars` off `useDiskUsage()` (D32 — never raw useQuery). Mirrors the containers screen shape.
 */
export default function DiskJanitorScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const query = useDiskUsage();
    const pulse = usePulse();

    const data = query.data;
    const diskFree = pulse.data?.diskFreeBytes ?? null;

    if (query.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Disk Janitor" }} />
                <View
                    testID="screen-disk-janitor"
                    accessibilityLabel="screen-disk-janitor"
                    className="flex-1 items-center justify-center bg-dd-bg-base"
                >
                    <View testID="disk-janitor-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Scanning disk…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (query.isError || !data) {
        return (
            <>
                <Stack.Screen options={{ title: "Disk Janitor" }} />
                <View
                    testID="screen-disk-janitor"
                    accessibilityLabel="screen-disk-janitor"
                    className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
                >
                    <Text
                        testID="disk-janitor-error"
                        className="text-base font-bold"
                        style={{ color: c.danger, fontFamily: "monospace" }}
                    >
                        Disk usage unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {query.error instanceof Error ? query.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Disk Janitor" }} />
            <ScrollView
                testID="screen-disk-janitor"
                accessibilityLabel="screen-disk-janitor"
                className="flex-1 bg-dd-bg-base"
                contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            >
                <MockBadge />

                {/* Header context: the single Pulse disk-free gauge this screen drills into. */}
                <StatTile testID="disk-janitor-free" label="Disk free" value={gb(diskFree)} half={false} />

                <SectionHeader title="Biggest dev directories" />

                {!data.available || data.entries.length === 0 ? (
                    <Card testID="disk-janitor-empty">
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            No scannable dev directories found on this host.
                        </Text>
                    </Card>
                ) : (
                    <UsageBars entries={data.entries} />
                )}
            </ScrollView>
        </>
    );
}
