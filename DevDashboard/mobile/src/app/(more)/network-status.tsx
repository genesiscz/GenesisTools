import { Stack } from "expo-router";
import { ActivityIndicator, Text, View } from "react-native";
import { RepairButton } from "@/features/network-status/components/RepairButton";
import { StatusCard } from "@/features/network-status/components/StatusCard";
import { useNetStatus } from "@/features/network-status/hooks";
import { MockBadge } from "@/ui/MockBadge";
import { Screen } from "@/ui/Screen";
import { useThemeColors } from "@/theme/colors";

/**
 * Network & Transport Status screen — an at-a-glance HEALTH panel for the active link (NOT the
 * pairing manager; that's Connections). Composes the network-status feature `StatusCard` + a
 * `RepairButton` off the `useNetStatus` hook (D32 — never raw useQuery). Loading/error states mirror
 * the daemon screen.
 */
export default function NetworkStatusScreen() {
    const c = useThemeColors();
    const query = useNetStatus();

    if (query.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Network" }} />
                <Screen testID="screen-network-status" scroll={false}>
                    <View className="flex-1 items-center justify-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text testID="network-status-loading" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            Checking link…
                        </Text>
                    </View>
                </Screen>
            </>
        );
    }

    if (query.isError || !query.data) {
        return (
            <>
                <Stack.Screen options={{ title: "Network" }} />
                <Screen testID="screen-network-status" scroll={false}>
                    <View className="flex-1 items-center justify-center gap-2 p-6">
                        <Text testID="network-status-error" className="text-base font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                            Status unavailable
                        </Text>
                        <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            {query.error instanceof Error ? query.error.message : "Could not reach the agent."}
                        </Text>
                        <RepairButton />
                    </View>
                </Screen>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Network" }} />
            <Screen testID="screen-network-status">
                <MockBadge />
                <StatusCard status={query.data} />
                <RepairButton />
            </Screen>
        </>
    );
}
