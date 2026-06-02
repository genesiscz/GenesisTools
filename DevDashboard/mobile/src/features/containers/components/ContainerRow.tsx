import type { ContainerInfo } from "@dd/contract";
import { Text, View } from "react-native";
import { runState, shortImage } from "@/features/containers/units";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface ContainerRowProps {
    container: ContainerInfo;
}

/**
 * One container card (feature-local Tier-2): name + a running/stopped status pill, with image,
 * status text, and exposed ports. testID `container-row-<id>`; the pill is `container-state-<id>`.
 */
export function ContainerRow({ container }: ContainerRowProps) {
    const c = useThemeColors();
    const running = runState(container) === "running";

    return (
        <Card testID={`container-row-${container.id}`} className="gap-2">
            <View className="flex-row items-center justify-between">
                <Text numberOfLines={1} className="flex-1 pr-2 text-base font-bold" style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                    {container.name}
                </Text>
                <StatusPill
                    testID={`container-state-${container.id}`}
                    label={running ? "Running" : "Stopped"}
                    tone={running ? "accent" : "muted"}
                    dot
                />
            </View>
            <Text numberOfLines={1} className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                {shortImage(container.image)}
            </Text>
            <Text numberOfLines={1} className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                {container.status}
            </Text>
            {container.ports ? (
                <Text numberOfLines={1} className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {container.ports}
                </Text>
            ) : null}
        </Card>
    );
}
