import type { RunSummary } from "@dd/contract";
import { FlatList, Pressable, Text, View } from "react-native";
import { Card } from "@/ui/Card";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface RunPickerProps {
    runs: RunSummary[];
    selectedLogFile: string | null;
    onSelect: (run: RunSummary) => void;
}

/**
 * Run selector for the build-log tail. One tappable row per recent run; the selected run is marked
 * with an accent border. Reuses the daemon runs endpoint (via the feature hook). testIDs:
 * `build-log-tail-run-picker` (list), `build-log-tail-run-<runId>` (row), `build-log-tail-run-empty`.
 */
export function RunPicker({ runs, selectedLogFile, onSelect }: RunPickerProps) {
    const c = useThemeColors();

    if (runs.length === 0) {
        return (
            <Card testID="build-log-tail-run-empty">
                <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>No recorded runs to tail.</Text>
            </Card>
        );
    }

    return (
        <FlatList
            testID="build-log-tail-run-picker"
            horizontal
            data={runs}
            keyExtractor={(r) => r.runId}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 4 }}
            renderItem={({ item }) => {
                const selected = item.logFile === selectedLogFile;
                return (
                    <Pressable
                        testID={`build-log-tail-run-${item.runId}`}
                        accessibilityRole="button"
                        accessibilityLabel={`build-log-tail-run-${item.runId}`}
                        onPress={() => onSelect(item)}
                        className="rounded-xl border px-3 py-2"
                        style={{
                            borderColor: selected ? c.accent : c.border,
                            backgroundColor: selected ? c.accentMuted : c.bgPanel,
                        }}
                    >
                        <Text numberOfLines={1} style={{ color: c.textPrimary, fontFamily: "monospace" }}>
                            {item.taskName}
                        </Text>
                        <View className="mt-1 self-start">
                            <StatusPill
                                label={
                                    item.exitCode === null
                                        ? "running"
                                        : item.exitCode === 0
                                          ? "exit 0"
                                          : `exit ${item.exitCode}`
                                }
                                tone={item.exitCode === null ? "accent" : item.exitCode === 0 ? "muted" : "danger"}
                                normalCase
                                dot={item.exitCode === null}
                            />
                        </View>
                    </Pressable>
                );
            }}
        />
    );
}
