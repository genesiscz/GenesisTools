import { Alert, Pressable, Text, View } from "react-native";
import type { ProcessInfo } from "@/features/process-monitor/types";
import { cpu, mb, uptime } from "@/features/process-monitor/units";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface ProcessRowProps {
    process: ProcessInfo;
    onKill: (pid: number) => void;
}

const HIGH_CPU_PCT = 50;

/**
 * One process row (feature-local Tier-2, like ContainerRow): mono name (flex-1, 1 line) + a
 * `pid · 1.8 GB · 12%` trailing line, a danger StatusPill when `cpuPct > 50`, and a Kill action
 * behind a native confirm `Alert` (mirrors ConnectionsScreen's delete confirm). testIDs:
 * `process-monitor-row-<pid>` and the per-row Kill `process-monitor-kill-<pid>`.
 */
export function ProcessRow({ process, onKill }: ProcessRowProps) {
    const c = useThemeColors();
    const highCpu = process.cpuPct > HIGH_CPU_PCT;

    const confirmKill = () => {
        Alert.alert("Kill process?", `${process.name} (pid ${process.pid})`, [
            { text: "Cancel", style: "cancel" },
            { text: "Kill", style: "destructive", onPress: () => onKill(process.pid) },
        ]);
    };

    return (
        <View
            testID={`process-monitor-row-${process.pid}`}
            accessibilityLabel={`process-monitor-row-${process.pid}`}
            className="flex-row items-center gap-3 py-2.5"
        >
            <View className="flex-1 gap-1">
                <View className="flex-row items-center gap-2">
                    <Text
                        numberOfLines={1}
                        className="flex-1 text-sm font-bold"
                        style={{ color: c.textPrimary, fontFamily: "monospace" }}
                    >
                        {process.name}
                    </Text>
                    {highCpu ? <StatusPill label={`${cpu(process.cpuPct)} CPU`} tone="danger" /> : null}
                </View>
                <Text numberOfLines={1} className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {`pid ${process.pid} · ${mb(process.rssBytes)} · ${cpu(process.cpuPct)} · ${uptime(process.uptimeMs)}`}
                </Text>
            </View>
            <Pressable
                testID={`process-monitor-kill-${process.pid}`}
                accessibilityRole="button"
                accessibilityLabel={`process-monitor-kill-${process.pid}`}
                onPress={confirmKill}
                className="rounded-lg border border-dd-border px-3 py-1.5"
            >
                <Text className="text-xs font-bold" style={{ color: c.danger, fontFamily: "monospace" }}>
                    Kill
                </Text>
            </Pressable>
        </View>
    );
}
