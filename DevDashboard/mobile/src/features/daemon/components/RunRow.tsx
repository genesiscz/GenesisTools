import type { RunSummary } from "@dd/contract";
import { Pressable, Text, View } from "react-native";
import { duration, runOutcome, startedAt } from "@/features/daemon/units";
import { useThemeColors } from "@/theme/colors";

interface RunRowProps {
    run: RunSummary;
    onPress: (run: RunSummary) => void;
}

/**
 * One daemon run row (feature-local Tier-2): task name + start time on the left, an outcome dot +
 * duration on the right; tapping opens the run log. testID `daemon-run-<runId>`; the open affordance
 * shares the same id (the whole row is pressable).
 */
export function RunRow({ run, onPress }: RunRowProps) {
    const c = useThemeColors();
    const outcome = runOutcome(run);
    const dotColor = outcome === "ok" ? c.accent : outcome === "failed" ? c.danger : c.textMuted;
    const outcomeLabel = outcome === "running" ? "running" : outcome === "ok" ? `exit 0` : `exit ${run.exitCode}`;

    return (
        <Pressable
            testID={`daemon-run-${run.runId}`}
            accessibilityRole="button"
            onPress={() => onPress(run)}
            className="flex-row items-center justify-between border-b border-dd-border py-3"
        >
            <View className="flex-1 pr-3">
                <Text numberOfLines={1} style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                    {run.taskName}
                </Text>
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {startedAt(run.startedAt)}
                </Text>
            </View>
            <View className="flex-row items-center gap-2">
                <Text className="text-xs" style={{ color: c.textSecondary, fontFamily: "monospace" }}>
                    {outcomeLabel}
                </Text>
                <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                    {duration(run.duration_ms)}
                </Text>
                <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: dotColor }} />
            </View>
        </Pressable>
    );
}
