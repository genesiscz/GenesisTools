import { Pressable, Text, View } from "react-native";
import { SORTS } from "@/features/process-monitor/types";
import type { ProcessSort } from "@/features/process-monitor/types";
import { useThemeColors } from "@/theme/colors";

interface SortToggleProps {
    sort: ProcessSort;
    onChange: (sort: ProcessSort) => void;
}

/**
 * Two-segment sort toggle (RSS / Name) inside a bordered pill. The active segment gets the accent-
 * muted fill + accent text and carries `accessibilityState={{ selected: true }}` so the Appium spec
 * can read which sort is active; inactive segments are muted. testIDs: container
 * `process-monitor-sort-toggle`, segments `process-monitor-sort-rss` / `process-monitor-sort-name`.
 */
export function SortToggle({ sort, onChange }: SortToggleProps) {
    const c = useThemeColors();

    return (
        <View
            testID="process-monitor-sort-toggle"
            accessibilityLabel="process-monitor-sort-toggle"
            className="flex-row self-start rounded-full border border-dd-border bg-dd-bg-panel p-0.5"
        >
            {SORTS.map((option) => {
                const active = option.value === sort;

                return (
                    <Pressable
                        key={option.value}
                        testID={option.testID}
                        accessibilityRole="button"
                        accessibilityLabel={option.testID}
                        accessibilityState={{ selected: active }}
                        onPress={() => onChange(option.value)}
                        className="rounded-full px-3 py-1"
                        style={{ backgroundColor: active ? c.accentMuted : "transparent" }}
                    >
                        <Text
                            className="text-xs font-bold"
                            style={{ color: active ? c.accent : c.textMuted, fontFamily: "monospace" }}
                        >
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
