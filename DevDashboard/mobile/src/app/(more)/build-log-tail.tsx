import type { ClassifiedLogEntry, RunSummary } from "@dd/contract";
import { Stack } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LogStream } from "@/features/build-log-tail/components/LogStream";
import { RunPicker } from "@/features/build-log-tail/components/RunPicker";
import { useBuildLogBacklog, useBuildLogRuns, useBuildLogStream } from "@/features/build-log-tail/hooks";
import { toClassifiedLines } from "@/features/build-log-tail/units";
import { MockBadge } from "@/ui/MockBadge";
import { SectionHeader } from "@/ui/SectionHeader";
import { useThemeColors } from "@/theme/colors";

/**
 * Live Build/Run Log Tail. Pick a recent daemon run, then live-tail its log over SSE with error
 * highlighting + jump-to-error. The backlog (static `getRunLog`) seeds the list; the live SSE tail
 * appends from there (FileTailer is "from now on", so the backlog fetch fills the history). Composes
 * the feature hooks only (D32). Distinct from the Daemon screen's STATIC RunLogSheet — this streams.
 */
export default function BuildLogTailScreen() {
    const c = useThemeColors();
    const insets = useSafeAreaInsets();
    const runsQuery = useBuildLogRuns();
    const [selected, setSelected] = useState<RunSummary | null>(null);
    const logFile = selected?.logFile ?? null;

    const backlogQuery = useBuildLogBacklog(logFile);
    const { live, status } = useBuildLogStream(logFile, { onResume: () => void backlogQuery.refetch() });

    const lines = useMemo(
        // Backlog entries are plain LogEntry (no `cls`); `toClassifiedLines` re-derives via classOf.
        () => toClassifiedLines([...(backlogQuery.data ?? []), ...live] as ClassifiedLogEntry[]),
        [backlogQuery.data, live],
    );

    const statusConnected = status === "open" || status === "live";
    const statusLabel =
        logFile === null
            ? "pick a run"
            : status === "live"
              ? "live"
              : status === "open"
                ? "connected"
                : "connecting";

    if (runsQuery.isPending) {
        return (
            <>
                <Stack.Screen options={{ title: "Build Log" }} />
                <View
                    testID="screen-build-log-tail"
                    accessibilityLabel="screen-build-log-tail"
                    className="flex-1 items-center justify-center bg-dd-bg-base"
                >
                    <View testID="build-log-tail-loading" className="items-center gap-2">
                        <ActivityIndicator color={c.accent} />
                        <Text style={{ color: c.textMuted, fontFamily: "monospace" }}>Loading runs…</Text>
                    </View>
                </View>
            </>
        );
    }

    if (runsQuery.isError) {
        return (
            <>
                <Stack.Screen options={{ title: "Build Log" }} />
                <View
                    testID="screen-build-log-tail"
                    accessibilityLabel="screen-build-log-tail"
                    className="flex-1 items-center justify-center gap-2 bg-dd-bg-base p-6"
                >
                    <Text
                        testID="build-log-tail-error"
                        className="text-base font-bold"
                        style={{ color: c.danger, fontFamily: "monospace" }}
                    >
                        Runs unavailable
                    </Text>
                    <Text className="text-xs" style={{ color: c.textMuted, fontFamily: "monospace" }}>
                        {runsQuery.error instanceof Error ? runsQuery.error.message : "Could not reach the agent."}
                    </Text>
                </View>
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: "Build Log" }} />
            <View
                testID="screen-build-log-tail"
                accessibilityLabel="screen-build-log-tail"
                className="flex-1 bg-dd-bg-base px-4"
                style={{ paddingTop: insets.top + 8 }}
            >
                <View className="gap-3 pb-3">
                    <MockBadge />
                    <SectionHeader title="Live build log" />
                    <RunPicker runs={runsQuery.data ?? []} selectedLogFile={logFile} onSelect={setSelected} />
                </View>

                <LogStream
                    lines={lines}
                    statusLabel={statusLabel}
                    statusConnected={statusConnected && logFile !== null}
                />
            </View>
        </>
    );
}
