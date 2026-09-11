import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import type { ClassifiedLine } from "@/features/build-log-tail/types";
import { firstErrorIndex } from "@/features/build-log-tail/units";
import { StatusPill } from "@/ui/StatusPill";
import { useThemeColors } from "@/theme/colors";

interface LogStreamProps {
    lines: ClassifiedLine[];
    /** Coarse liveness for the header pill. */
    statusLabel: string;
    statusConnected: boolean;
}

/**
 * Auto-scrolling live log list with error highlighting + a jump-to-error FAB. Auto-scroll sticks to
 * the bottom as lines arrive UNLESS the user has scrolled up (then it pauses, surfaced by the toggle).
 * Error rows are tinted `theme.danger` and carry a SECOND marker View with `build-log-tail-error-<n>`
 * so Appium can assert which rows are errors + that jump-to-error scrolled the first one into view.
 *
 * There is no `warn` theme token, so warn rows render in `accent` (deliberate — flagged). Tier-2
 * feature component; consumes shared `StatusPill` + theme tokens only (no raw palette).
 */
export function LogStream({ lines, statusLabel, statusConnected }: LogStreamProps) {
    const c = useThemeColors();
    const listRef = useRef<FlatList<ClassifiedLine>>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    useEffect(() => {
        if (autoScroll && lines.length > 0) {
            // Defer to next frame so the row is laid out before we scroll.
            requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
        }
    }, [lines.length, autoScroll]);

    const jumpToError = useCallback(() => {
        const idx = firstErrorIndex(lines);
        if (idx < 0) {
            return;
        }

        setAutoScroll(false); // jumping up means the user wants to inspect; don't yank them back down
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
    }, [lines]);

    const hasError = firstErrorIndex(lines) >= 0;

    return (
        <View testID="build-log-tail-stream" className="flex-1">
            <View className="mb-2 flex-row items-center justify-between">
                <StatusPill
                    testID="build-log-tail-live-pill"
                    label={statusLabel}
                    tone={statusConnected ? "accent" : "muted"}
                    dot={statusConnected}
                    normalCase
                />
                <Pressable
                    testID="build-log-tail-autoscroll-toggle"
                    accessibilityRole="button"
                    accessibilityLabel="build-log-tail-autoscroll-toggle"
                    onPress={() => setAutoScroll((v) => !v)}
                    className="rounded-full border px-2 py-0.5"
                    style={{ borderColor: c.border }}
                >
                    <Text
                        className="text-[10px] font-bold uppercase tracking-widest"
                        style={{ color: autoScroll ? c.accent : c.textMuted, fontFamily: "monospace" }}
                    >
                        {autoScroll ? "auto-scroll on" : "auto-scroll off"}
                    </Text>
                </Pressable>
            </View>

            {lines.length === 0 ? (
                <Text
                    testID="build-log-tail-empty"
                    className="py-8 text-center"
                    style={{ color: c.textMuted, fontFamily: "monospace" }}
                >
                    No log output yet…
                </Text>
            ) : (
                <FlatList
                    ref={listRef}
                    testID="build-log-tail-list"
                    data={lines}
                    keyExtractor={(l) => `${l.index}`}
                    onScrollBeginDrag={() => setAutoScroll(false)}
                    // scrollToIndex can throw if the row isn't measured; fall back to an offset estimate.
                    onScrollToIndexFailed={(info) => {
                        listRef.current?.scrollToOffset({
                            offset: info.averageItemLength * info.index,
                            animated: true,
                        });
                    }}
                    renderItem={({ item }) => {
                        const isError = item.cls === "error";
                        const color =
                            item.cls === "error"
                                ? c.danger
                                : item.cls === "warn"
                                  ? c.accent
                                  : c.textSecondary;
                        return (
                            <View>
                                {isError ? (
                                    <View testID={`build-log-tail-error-${item.index}`} style={{ height: 0 }} />
                                ) : null}
                                <Text
                                    testID={`build-log-tail-line-${item.index}`}
                                    className="text-xs"
                                    style={{ color, fontFamily: "monospace", fontWeight: isError ? "700" : "400" }}
                                >
                                    {item.text}
                                </Text>
                            </View>
                        );
                    }}
                />
            )}

            {hasError ? (
                <Pressable
                    testID="build-log-tail-jump-error"
                    accessibilityRole="button"
                    accessibilityLabel="Jump to first error"
                    onPress={jumpToError}
                    className="absolute bottom-4 right-4 h-12 w-12 items-center justify-center rounded-full"
                    style={{ backgroundColor: c.danger }}
                >
                    <Feather name="alert-triangle" size={20} color={c.bgBase} />
                </Pressable>
            ) : null}
        </View>
    );
}
