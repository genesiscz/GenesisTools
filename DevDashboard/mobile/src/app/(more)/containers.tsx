import { Stack } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ContainerRow } from "@/features/containers/components/ContainerRow";
import { useContainers } from "@/features/containers/hooks";
import { partitionByState } from "@/features/containers/units";
import { Card } from "@/ui/Card";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Containers screen — Docker availability + running/stopped container cards. Composes the
 * `ContainerRow` off the per-feature `useContainers` hook (D32 — never raw useQuery). Parity with
 * the web containers view (list + dockerAvailable + state). Per-container LOGS are unbacked by the
 * contract and intentionally omitted (see 20-impl-09-rest-notes.md).
 */
export default function ContainersScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const query = useContainers();

    const data = query.data;
    const { running, stopped } = useMemo(() => partitionByState(data?.containers ?? []), [data?.containers]);

    if (query.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Containers" }} />
                <View testID="screen-containers" accessibilityLabel="screen-containers" className="flex-1 items-center justify-center bg-dd-bg-base">
                    <View testID="containers-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading containers…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (query.isError || !data) {
        return (
            <>
                <Stack.Screen options={{ title: "Containers" }} />
                <View testID="screen-containers" accessibilityLabel="screen-containers" className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6">
                    <Text testID="containers-error" className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                        Containers unavailable
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
            <Stack.Screen options={{ title: "Containers" }} />
            <ScrollView
                testID="screen-containers"
                accessibilityLabel="screen-containers"
                className="flex-1 bg-dd-bg-base"
                contentContainerStyle={{ padding: 16, paddingTop: insets.top + 8, gap: 16 }}
            >
                <MockBadge />

                {!data.dockerAvailable ? (
                    <Card testID="containers-docker-unavailable">
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            Docker is not available on this host.
                        </Text>
                    </Card>
                ) : null}

                {data.dockerAvailable && data.containers.length === 0 ? (
                    <Text testID="containers-empty" className="py-8 text-center" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        No containers.
                    </Text>
                ) : null}

                {running.length > 0 ? (
                    <View testID="containers-running" className="gap-3">
                        <SectionHeader title={`Running (${running.length})`} />
                        {running.map((container) => (
                            <ContainerRow key={container.id} container={container} />
                        ))}
                    </View>
                ) : null}

                {stopped.length > 0 ? (
                    <View testID="containers-stopped" className="gap-3">
                        <SectionHeader title={`Stopped (${stopped.length})`} />
                        {stopped.map((container) => (
                            <ContainerRow key={container.id} container={container} />
                        ))}
                    </View>
                ) : null}
            </ScrollView>
        </>
    );
}
