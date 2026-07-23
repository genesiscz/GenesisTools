import type { PortInfo } from "@dd/contract";
import { Pressable, Text, View } from "react-native";
import { protoLabel } from "@/features/port-killer/units";
import { Card } from "@/ui/Card";
import { KeyValueRow } from "@/ui/KeyValueRow";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface PortRowProps {
    port: PortInfo;
    onKill: (port: PortInfo) => void;
}

/**
 * One listening-port card: ":<port>" accent pill + proto, the owning command, its pid, and bind
 * address, plus a danger "Kill" button that delegates to the confirm dialog via `onKill`.
 * testID `port-killer-row-<port>`; the kill button is `port-killer-kill-<port>`.
 */
export function PortRow({ port, onKill }: PortRowProps) {
    const c = useThemeColors();

    return (
        <Card testID={`port-killer-row-${port.port}`} className="gap-2">
            <View className="flex-row items-center justify-between">
                <StatusPill testID={`port-killer-port-${port.port}`} label={`:${port.port}`} tone="accent" />
                <StatusPill label={protoLabel(port.proto)} tone="muted" normalCase />
            </View>
            <Text
                numberOfLines={1}
                className="text-base font-bold"
                style={{ color: c.textPrimary, fontFamily: "monospace" }}
            >
                {port.command}
            </Text>
            <KeyValueRow label="pid" value={String(port.pid)} />
            <Text numberOfLines={1} className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {port.address}
            </Text>
            <Pressable
                testID={`port-killer-kill-${port.port}`}
                accessibilityRole="button"
                accessibilityLabel={`Kill port ${port.port}`}
                onPress={() => onKill(port)}
                className="mt-1 self-start rounded-lg px-3 py-2"
                style={{ borderWidth: 1, borderColor: c.danger }}
            >
                <Text
                    className="text-xs font-bold uppercase tracking-widest"
                    style={{ color: c.danger, fontFamily: "monospace" }}
                >
                    Kill
                </Text>
            </Pressable>
        </Card>
    );
}
