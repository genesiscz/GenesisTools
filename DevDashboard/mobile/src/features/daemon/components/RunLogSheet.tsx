import type { RunSummary } from "@dd/contract";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useDaemonRunLog } from "@/features/daemon/hooks";
import { logLineText } from "@/features/daemon/units";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

interface RunLogSheetProps {
    /** The run whose log to show, or null when the sheet is closed. */
    run: RunSummary | null;
    onClose: () => void;
}

/**
 * Run-log viewer (feature-local Tier-2): a bottom sheet that fetches the selected run's structured
 * log via `useDaemonRunLog` (D32 — never raw useQuery) and renders each entry as a mono line, color
 * by stream (stderr = danger). testID `daemon-log-sheet`; lines are `daemon-log-line-<i>`.
 */
export function RunLogSheet({ run, onClose }: RunLogSheetProps) {
    const c = useThemeColors();
    const logQuery = useDaemonRunLog(run?.logFile ?? null);
    const entries = logQuery.data ?? [];

    return (
        <Modal visible={run != null} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable className="flex-1 justify-end bg-black/50" onPress={onClose}>
                <Pressable
                    testID="daemon-log-sheet"
                    className="max-h-[75%] gap-3 rounded-t-3xl border border-dd-border bg-dd-bg-panel p-5"
                    onPress={() => {}}
                >
                    <View className="flex-row items-center justify-between">
                        <SectionHeader title={run ? `${run.taskName} log` : "Run log"} />
                        <Pressable testID="daemon-log-close" accessibilityRole="button" onPress={onClose} hitSlop={8}>
                            <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>✕</Text>
                        </Pressable>
                    </View>

                    {logQuery.isPending ? (
                        <View testID="daemon-log-loading" className="items-center py-8">
                            <ActivityIndicator color={c.accent} />
                        </View>
                    ) : entries.length === 0 ? (
                        <Text testID="daemon-log-empty" className="py-8 text-center" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                            No log output.
                        </Text>
                    ) : (
                        <ScrollView testID="daemon-log-scroll" className="grow">
                            {entries.map((entry, index) => {
                                const isErr = entry.type === "stderr";
                                // Structured log lines have no stable id; a finished run's log is static and
                                // append-only, so the position is a stable enough key (ts can repeat per ms).
                                const key = `${entry.type}-${index}`;
                                return (
                                    <Text
                                        key={key}
                                        testID={`daemon-log-line-${index}`}
                                        className="text-xs"
                                        style={{ color: isErr ? c.danger : c.textSecondary, fontFamily: "monospace" }}
                                    >
                                        {logLineText(entry)}
                                    </Text>
                                );
                            })}
                        </ScrollView>
                    )}
                </Pressable>
            </Pressable>
        </Modal>
    );
}
