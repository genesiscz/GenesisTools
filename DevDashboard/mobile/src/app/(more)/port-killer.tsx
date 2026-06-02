import type { PortInfo } from "@dd/contract";
import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { KillConfirmDialog } from "@/features/port-killer/components/KillConfirmDialog";
import { PortRow } from "@/features/port-killer/components/PortRow";
import { useKillPort, usePorts } from "@/features/port-killer/hooks";
import { byPortAsc } from "@/features/port-killer/units";
import { Card } from "@/ui/Card";
import { Empty } from "@/ui/Empty";
import { MockBadge } from "@/ui/MockBadge";
import { Screen } from "@/ui/Screen";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Port Killer screen — every TCP port the Agent host is LISTENing on, with a confirm-gated Kill.
 * Read via `usePorts` (D32 hook), kill via `useKillPort` (invalidates the list on success). lsof
 * unavailable and empty are both handled. The kill confirm is an in-app Modal (Appium-introspectable).
 */
export default function PortKillerScreen() {
    const c = useThemeColors();
    const query = usePorts();
    const kill = useKillPort();
    const [target, setTarget] = useState<PortInfo | null>(null);

    const ports = useMemo(() => byPortAsc(query.data?.ports ?? []), [query.data?.ports]);

    if (query.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Port Killer" }} />
                <View
                    testID="screen-port-killer"
                    accessibilityLabel="screen-port-killer"
                    className="flex-1 items-center justify-center bg-dd-bg-base"
                >
                    <View testID="port-killer-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Scanning ports…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (query.isError || !query.data) {
        return (
            <>
                <Stack.Screen options={{ title: "Port Killer" }} />
                <View
                    testID="screen-port-killer"
                    accessibilityLabel="screen-port-killer"
                    className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
                >
                    <Text
                        testID="port-killer-error"
                        className="text-base font-bold"
                        style={{ color: c.danger, fontFamily: "monospace" }}
                    >
                        Ports unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {query.error instanceof Error ? query.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    const { lsofAvailable } = query.data;

    return (
        <>
            <Stack.Screen options={{ title: "Port Killer" }} />
            <Screen testID="screen-port-killer">
                <MockBadge />

                {!lsofAvailable ? (
                    <Card testID="port-killer-lsof-unavailable">
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            lsof is not available on this host.
                        </Text>
                    </Card>
                ) : null}

                {lsofAvailable && ports.length === 0 ? (
                    <Empty testID="port-killer-empty" title="No listening ports" hint="Nothing is bound right now." />
                ) : null}

                {ports.length > 0 ? (
                    <View className="gap-3">
                        <SectionHeader title={`Listening (${ports.length})`} />
                        {ports.map((port) => (
                            <PortRow key={`${port.pid}-${port.port}-${port.proto}`} port={port} onKill={setTarget} />
                        ))}
                    </View>
                ) : null}

                <KillConfirmDialog
                    visible={target !== null}
                    port={target?.port ?? null}
                    command={target?.command ?? null}
                    onCancel={() => setTarget(null)}
                    onConfirm={() => {
                        if (target) {
                            kill.mutate({ pid: target.pid, expectedCommand: target.command });
                        }

                        setTarget(null);
                    }}
                />
            </Screen>
        </>
    );
}
