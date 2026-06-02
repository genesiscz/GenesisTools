import { Pressable, Text, View } from "react-native";
import { useThemeColors } from "@/theme/colors";

export const HISTORY_RANGES = [
    { label: "30m", minutes: 30 },
    { label: "2h", minutes: 120 },
    { label: "6h", minutes: 360 },
    { label: "24h", minutes: 1440 },
] as const;

interface RangeSelectorProps {
    value: number;
    onChange: (minutes: number) => void;
}

/** Segmented control for the history time window. Each segment carries `pulse-range-<minutes>`. */
export function RangeSelector({ value, onChange }: RangeSelectorProps) {
    const c = useThemeColors();

    return (
        <View
            testID="pulse-range-selector"
            className="flex-row gap-1 self-end rounded-lg p-1"
            style={{ backgroundColor: c.bgPanel }}
        >
            {HISTORY_RANGES.map(({ label, minutes }) => {
                const active = minutes === value;
                return (
                    <Pressable
                        key={minutes}
                        testID={`pulse-range-${minutes}`}
                        accessibilityRole="button"
                        accessibilityLabel={`Range ${label}`}
                        accessibilityState={{ selected: active }}
                        onPress={() => onChange(minutes)}
                        className="rounded-md px-3 py-1"
                        style={{ backgroundColor: active ? c.accentMuted : "transparent" }}
                    >
                        <Text
                            className="text-xs font-bold"
                            style={{ color: active ? c.accent : c.textMuted, fontFamily: "monospace" }}
                        >
                            {label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
